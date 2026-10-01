import { Howl } from 'howler';
import { encodeWav, normalize, toDataUri } from './wav';

const SR = 22050;

type Recipe = { dur: number; gain?: number; build: (ctx: OfflineAudioContext, out: AudioNode) => void };

function noiseBuffer(ctx: BaseAudioContext, dur: number, brown = false): AudioBuffer {
  const b = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return b;
}

/** Noise → filter → exponential decay envelope. */
function burst(ctx: BaseAudioContext, out: AudioNode, o: { t?: number; dur: number; type: BiquadFilterType; f: number; f1?: number; q?: number; amp: number; attack?: number; brown?: boolean }): void {
  const t = o.t ?? 0;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, o.dur + 0.05, o.brown);
  const flt = ctx.createBiquadFilter();
  flt.type = o.type;
  flt.frequency.setValueAtTime(o.f, t);
  if (o.f1) flt.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  flt.Q.value = o.q ?? 0.8;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.amp, t + (o.attack ?? 0.002));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  src.connect(flt).connect(g).connect(out);
  src.start(t);
}

/** Oscillator with pitch sweep + exponential decay. */
function tone(ctx: BaseAudioContext, out: AudioNode, o: { t?: number; dur: number; type: OscillatorType; f: number; f1?: number; amp: number; attack?: number }): void {
  const t = o.t ?? 0;
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.f, t);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(o.amp, t + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + o.dur + 0.02);
}

/** Simple feedback echo for big outdoor gunshots. */
function echo(ctx: BaseAudioContext, out: AudioNode, delay: number, fb: number): AudioNode {
  const input = ctx.createGain();
  const d = ctx.createDelay(1);
  d.delayTime.value = delay;
  const g = ctx.createGain();
  g.gain.value = fb;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  input.connect(out);
  input.connect(d).connect(lp).connect(g).connect(d);
  g.connect(out);
  return input;
}

const gun = (crack: number, decay: number, thump: number, tail: number, amp = 1): Recipe => ({
  dur: decay + tail + 0.1,
  build: (ctx, out) => {
    const o = tail > 0.2 ? echo(ctx, out, 0.16, 0.35) : out;
    burst(ctx, o, { dur: decay, type: 'bandpass', f: crack, f1: crack * 0.35, q: 0.6, amp });
    burst(ctx, o, { dur: decay * 2.2 + tail, type: 'lowpass', f: 1800, f1: 200, amp: amp * 0.55, brown: true });
    tone(ctx, o, { dur: decay * 1.4, type: 'sine', f: thump, f1: thump * 0.4, amp: amp * 0.8 });
  },
});

export const RECIPES: Record<string, Recipe> = {
  pistol: gun(1900, 0.12, 140, 0.25),
  smg: gun(2400, 0.07, 170, 0.12, 0.85),
  shotgun: gun(900, 0.22, 90, 0.45, 1),
  rifle: gun(2600, 0.1, 120, 0.35),
  sniper: gun(1500, 0.18, 70, 0.8),
  explosion: {
    dur: 2.4,
    build: (ctx, out) => {
      const e = echo(ctx, out, 0.22, 0.3);
      burst(ctx, e, { dur: 2.1, type: 'lowpass', f: 2400, f1: 120, amp: 1, brown: true, attack: 0.01 });
      burst(ctx, e, { dur: 0.35, type: 'bandpass', f: 1200, f1: 300, amp: 0.7 });
      tone(ctx, e, { dur: 1.2, type: 'sine', f: 70, f1: 28, amp: 1 });
    },
  },
  punch: { dur: 0.15, build: (ctx, out) => { burst(ctx, out, { dur: 0.09, type: 'lowpass', f: 700, amp: 0.9 }); tone(ctx, out, { dur: 0.1, type: 'sine', f: 140, f1: 60, amp: 0.8 }); } },
  bat: { dur: 0.25, build: (ctx, out) => { tone(ctx, out, { dur: 0.16, type: 'triangle', f: 330, f1: 180, amp: 0.8 }); burst(ctx, out, { dur: 0.1, type: 'bandpass', f: 1500, amp: 0.5 }); } },
  stab: { dur: 0.2, build: (ctx, out) => { burst(ctx, out, { dur: 0.12, type: 'highpass', f: 2500, amp: 0.4 }); tone(ctx, out, { dur: 0.08, type: 'sine', f: 200, f1: 90, amp: 0.6 }); } },
  swing: { dur: 0.25, build: (ctx, out) => burst(ctx, out, { dur: 0.22, type: 'bandpass', f: 600, f1: 2200, q: 2, amp: 0.5, attack: 0.08 }) },
  glass: {
    dur: 0.7,
    build: (ctx, out) => {
      burst(ctx, out, { dur: 0.3, type: 'highpass', f: 4000, amp: 0.7 });
      for (let i = 0; i < 7; i++) tone(ctx, out, { t: Math.random() * 0.25, dur: 0.25 + Math.random() * 0.3, type: 'sine', f: 2800 + Math.random() * 3500, amp: 0.18 });
    },
  },
  crash: {
    dur: 0.9,
    build: (ctx, out) => {
      burst(ctx, out, { dur: 0.5, type: 'lowpass', f: 2200, f1: 300, amp: 1, brown: true });
      burst(ctx, out, { dur: 0.15, type: 'bandpass', f: 900, amp: 0.8 });
      for (const f of [212, 347, 563, 911]) tone(ctx, out, { dur: 0.6, type: 'triangle', f, f1: f * 0.92, amp: 0.15 });
    },
  },
  thud: { dur: 0.3, build: (ctx, out) => { tone(ctx, out, { dur: 0.25, type: 'sine', f: 110, f1: 45, amp: 0.9 }); burst(ctx, out, { dur: 0.1, type: 'lowpass', f: 500, amp: 0.5 }); } },
  step: { dur: 0.08, build: (ctx, out) => burst(ctx, out, { dur: 0.06, type: 'lowpass', f: 1100, amp: 0.6 }) },
  splash: { dur: 0.9, build: (ctx, out) => burst(ctx, out, { dur: 0.8, type: 'bandpass', f: 1800, f1: 400, q: 0.5, amp: 0.9, attack: 0.02 }) },
  click: { dur: 0.04, build: (ctx, out) => tone(ctx, out, { dur: 0.03, type: 'square', f: 1800, f1: 1200, amp: 0.3 }) },
  reload: { dur: 0.45, build: (ctx, out) => { burst(ctx, out, { dur: 0.05, type: 'bandpass', f: 3000, q: 3, amp: 0.6 }); burst(ctx, out, { t: 0.28, dur: 0.06, type: 'bandpass', f: 2200, q: 3, amp: 0.8 }); } },
  lockpick: { dur: 0.08, build: (ctx, out) => burst(ctx, out, { dur: 0.05, type: 'bandpass', f: 4200, q: 6, amp: 0.7 }) },
  door: { dur: 0.35, build: (ctx, out) => { tone(ctx, out, { dur: 0.2, type: 'sine', f: 90, f1: 60, amp: 0.8 }); burst(ctx, out, { dur: 0.25, type: 'bandpass', f: 700, amp: 0.4 }); } },
  pickup: { dur: 0.3, build: (ctx, out) => { tone(ctx, out, { dur: 0.12, type: 'triangle', f: 880, amp: 0.5 }); tone(ctx, out, { t: 0.08, dur: 0.18, type: 'triangle', f: 1320, amp: 0.5 }); } },
  cash: { dur: 0.6, build: (ctx, out) => { tone(ctx, out, { dur: 0.08, type: 'square', f: 1200, amp: 0.15 }); for (const f of [1760, 2637, 3520]) tone(ctx, out, { t: 0.06, dur: 0.5, type: 'sine', f, amp: 0.25 }); } },
  shell: { dur: 1.0, build: (ctx, out) => { [1046, 1318, 1568, 2093].forEach((f, i) => tone(ctx, out, { t: i * 0.08, dur: 0.6, type: 'sine', f, amp: 0.3 })); } },
  ui: { dur: 0.05, build: (ctx, out) => tone(ctx, out, { dur: 0.04, type: 'sine', f: 1400, f1: 1800, amp: 0.25 }) },
  buy: { dur: 0.35, build: (ctx, out) => { tone(ctx, out, { dur: 0.1, type: 'triangle', f: 660, amp: 0.4 }); tone(ctx, out, { t: 0.09, dur: 0.22, type: 'triangle', f: 990, amp: 0.4 }); } },
  passed: {
    dur: 2.2,
    gain: 0.7,
    build: (ctx, out) => {
      const seq = [60, 64, 67, 72, 67, 72, 76];
      seq.forEach((m, i) => {
        const f = 440 * Math.pow(2, (m - 69) / 12);
        tone(ctx, out, { t: i * 0.12, dur: i === seq.length - 1 ? 1.2 : 0.22, type: 'square', f, amp: 0.25 });
        tone(ctx, out, { t: i * 0.12, dur: i === seq.length - 1 ? 1.4 : 0.3, type: 'triangle', f: f / 2, amp: 0.35 });
      });
    },
  },
  failed: {
    dur: 2,
    gain: 0.7,
    build: (ctx, out) => {
      [55, 51, 48].forEach((m, i) => tone(ctx, out, { t: i * 0.35, dur: i === 2 ? 1.4 : 0.4, type: 'sawtooth', f: 440 * Math.pow(2, (m - 69) / 12), amp: 0.25 }));
      burst(ctx, out, { dur: 1.6, type: 'lowpass', f: 400, amp: 0.4, brown: true, attack: 0.3 });
    },
  },
  wasted: {
    dur: 3,
    gain: 0.8,
    build: (ctx, out) => {
      for (const m of [36, 43, 46, 51]) tone(ctx, out, { dur: 2.8, type: 'sawtooth', f: 440 * Math.pow(2, (m - 69) / 12), f1: 440 * Math.pow(2, (m - 71) / 12), amp: 0.2, attack: 0.05 });
      tone(ctx, out, { dur: 1.6, type: 'sine', f: 60, f1: 30, amp: 0.8 });
    },
  },
  busted: {
    dur: 1.8,
    build: (ctx, out) => {
      for (let i = 0; i < 4; i++) tone(ctx, out, { t: i * 0.2, dur: 0.18, type: 'square', f: i % 2 ? 660 : 880, amp: 0.25 });
      tone(ctx, out, { t: 0.8, dur: 0.9, type: 'sawtooth', f: 220, f1: 110, amp: 0.3 });
    },
  },
  heartbeat: { dur: 0.6, build: (ctx, out) => { tone(ctx, out, { dur: 0.12, type: 'sine', f: 60, f1: 40, amp: 0.9 }); tone(ctx, out, { t: 0.18, dur: 0.14, type: 'sine', f: 55, f1: 38, amp: 0.7 }); } },
  wheel: { dur: 0.06, build: (ctx, out) => tone(ctx, out, { dur: 0.05, type: 'triangle', f: 900, amp: 0.3 }) },
};

/** Render every recipe offline once, then play them through Howler (pooled, spatial). */
export class SfxBank {
  /** Rendered WAV per sound; Howls are created per playback kind on first use. */
  private uris = new Map<string, string>();
  private flat = new Map<string, Howl>();
  private spatial = new Map<string, Howl>();
  ready = false;

  async build(): Promise<void> {
    const Ctx = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Ctx) return;
    for (const [name, r] of Object.entries(RECIPES)) {
      try {
        const ctx = new Ctx(1, Math.ceil(SR * r.dur), SR);
        const master = ctx.createGain();
        master.gain.value = 1;
        master.connect(ctx.destination);
        r.build(ctx, master);
        const buf = await ctx.startRendering();
        const data = normalize(buf.getChannelData(0).slice(), 0.9 * (r.gain ?? 1));
        this.uris.set(name, toDataUri(encodeWav(data, SR)));
      } catch {
        /* a failed recipe just stays silent */
      }
      // yield so loading never blocks a frame for long
      await new Promise((res) => setTimeout(res, 0));
    }
    this.ready = true;
  }

  has(name: string): boolean {
    return this.uris.has(name);
  }

  /**
   * 2D (UI, stings) and 3D (world) playback use separate Howl instances: Howler reuses pooled
   * sound nodes, and a node that once had a panner would otherwise keep panning UI sounds.
   */
  private howl(name: string, spatial: boolean): Howl | null {
    const map = spatial ? this.spatial : this.flat;
    let h = map.get(name);
    if (!h) {
      const uri = this.uris.get(name);
      if (!uri) return null;
      h = new Howl({ src: [uri], format: ['wav'], pool: spatial ? 8 : 3, preload: true });
      map.set(name, h);
    }
    return h;
  }

  /** Play a one-shot; with a position it is spatialised relative to the Howler listener. */
  play(name: string, o: { vol?: number; rate?: number; x?: number; y?: number; z?: number; ref?: number } = {}): number | null {
    const h = this.howl(name, o.x !== undefined);
    if (!h) return null;
    const id = h.play();
    h.volume(o.vol ?? 1, id);
    if (o.rate) h.rate(o.rate, id);
    if (o.x !== undefined) {
      h.pos(o.x, o.y ?? 0, o.z ?? 0, id);
      h.pannerAttr({ panningModel: 'equalpower', distanceModel: 'inverse', refDistance: o.ref ?? 6, rolloffFactor: 1.1, maxDistance: 400 }, id);
    }
    return id;
  }
}
