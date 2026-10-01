import { STATIONS, chordOn, makeSong, midiToFreq, sectionAt, stepTime, type Song, type StationDef } from './music';

/**
 * Three procedural radio stations synthesised live with Web Audio. Each station keeps playing a
 * seeded "song" (drums, bass, chords, lead); songs rotate every few dozen bars. A look-ahead
 * scheduler queues notes ~0.25 s ahead so frame hitches never cause timing glitches.
 */
export class Radio {
  readonly out: GainNode;
  private speaker: BiquadFilterNode;
  private noise: AudioBuffer;
  private crackle: AudioBufferSourceNode | null = null;
  private crackleGain: GainNode;
  private station = -1;
  private song: Song | null = null;
  private songSeed = 1;
  private step = 0;
  private bar = 0;
  private nextTime = 0;
  private barStart = 0;
  /** Muffled "outside the car / club walls" mode. */
  private muffle = 0;
  /** Reverb send (procedural plate impulse). */
  private send: GainNode;
  /** Gap between songs (DJ talks); ctx time when the next song starts. */
  private breakUntil = 0;
  private prev: Song | null = null;
  onSongChange: ((station: StationDef, song: Song) => void) | null = null;
  /** Between songs: the DJ links `prev` → `next`. */
  onBreak: ((station: StationDef, prev: Song, next: Song) => void) | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.speaker = ctx.createBiquadFilter();
    this.speaker.type = 'lowpass';
    this.speaker.frequency.value = 7000;
    this.speaker.Q.value = 0.4;
    this.speaker.connect(this.out).connect(dest);
    // reverb: exponentially decaying stereo noise impulse
    const len = Math.floor(ctx.sampleRate * 2.2);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const wet = ctx.createGain();
    wet.gain.value = 0.32;
    this.send = ctx.createGain();
    this.send.connect(conv).connect(wet).connect(this.speaker);
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.crackleGain = ctx.createGain();
    this.crackleGain.gain.value = 0;
    this.crackleGain.connect(this.speaker);
    this.songSeed = (Date.now() / 1000) | 0;
  }

  get current(): StationDef | null {
    return STATIONS[this.station] ?? null;
  }
  get songTitle(): string {
    return this.song?.title ?? '';
  }
  get songArtist(): string {
    return this.song?.artist ?? '';
  }

  /** -1 = off */
  tune(index: number): void {
    if (index === this.station) return;
    this.station = index;
    if (index < 0 || index >= STATIONS.length) {
      this.station = -1;
      this.song = null;
      this.setCrackle(false);
      return;
    }
    this.newSong();
    this.setCrackle(STATIONS[index]!.id === 'lowtide');
  }

  private newSong(withBreak = false): void {
    const st = STATIONS[this.station]!;
    const prev = this.song;
    this.song = makeSong(st, this.songSeed++ * 7919 + this.station * 131);
    this.step = 0;
    this.bar = 0;
    const now = this.ctx.currentTime;
    if (withBreak && prev) {
      // station ident sting, then the DJ talks over a short gap
      this.jingle(now + 0.1);
      this.breakUntil = now + 5.2;
      this.prev = prev;
      this.onBreak?.(st, prev, this.song);
    } else this.breakUntil = now;
    this.nextTime = this.breakUntil + 0.12;
    this.barStart = this.nextTime;
    if (!withBreak) this.onSongChange?.(st, this.song);
  }

  /** Three-note station ident. */
  private jingle(t: number): void {
    const st = STATIONS[this.station]!;
    const notes = st.id === 'neon' ? [76, 79, 83, 88] : st.id === 'dust' ? [67, 71, 74, 79] : [72, 75, 79, 82];
    notes.forEach((m, i) => this.pluck(t + i * 0.11, midiToFreq(m), i === notes.length - 1 ? 0.9 : 0.25, st.id === 'neon' ? 'square' : 'triangle', 0.07, 0.5));
  }

  private setCrackle(on: boolean): void {
    if (on && !this.crackle) {
      const b = this.ctx.createBuffer(1, this.ctx.sampleRate * 2, this.ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() < 0.0008 ? (Math.random() * 2 - 1) * 0.8 : (Math.random() * 2 - 1) * 0.015;
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.loop = true;
      s.connect(this.crackleGain);
      s.start();
      this.crackle = s;
      this.crackleGain.gain.value = 0.5;
    } else if (!on && this.crackle) {
      this.crackle.stop();
      this.crackle.disconnect();
      this.crackle = null;
    }
  }

  /** Set output level (0..1) and muffling (0 clear … 1 through-walls). */
  setLevel(level: number, muffle = 0): void {
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(level, t, 0.25);
    if (Math.abs(muffle - this.muffle) > 0.01) {
      this.muffle = muffle;
      this.speaker.frequency.setTargetAtTime(7000 - muffle * 6400, t, 0.2);
    }
  }

  /** Call every frame: schedules notes in a short look-ahead window. */
  update(): void {
    const s = this.song;
    if (!s) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.nextTime < now - 0.5) {
      // tab was suspended: resync instead of machine-gunning old notes
      this.nextTime = now + 0.05;
      this.barStart = this.nextTime - (stepTime(s.bpm, s.swing, this.step));
    }
    if (now < this.breakUntil - 0.2) return;
    if (this.prev) {
      // break over: announce the song that is starting now
      this.prev = null;
      this.onSongChange?.(STATIONS[this.station]!, s);
    }
    while (this.nextTime < now + 0.25) {
      this.playStep(s, this.step, this.bar, this.nextTime);
      this.step++;
      if (this.step >= 16) {
        this.step = 0;
        this.bar++;
        this.barStart += stepTime(s.bpm, 0, 16);
        if (this.bar >= s.bars) {
          this.newSong(true);
          return;
        }
      }
      this.nextTime = this.barStart + stepTime(s.bpm, s.swing, this.step);
    }
  }

  private playStep(s: Song, step: number, bar: number, t: number): void {
    const { section: sec, barInSection } = sectionAt(s, bar);
    const e = sec.energy;
    const lastBar = barInSection === sec.bars - 1;
    const deg = sec.prog[barInSection % sec.prog.length]!;
    const chord = chordOn(s.root + 12, s.mode, deg, s.station !== 'dust');
    const s16 = 60 / s.bpm / 4;
    // outro fades down bar by bar
    const fade = sec.kind === 'outro' ? Math.max(0.15, 1 - barInSection / sec.bars) : 1;
    // crash into each chorus
    if (step === 0 && barInSection === 0 && sec.kind === 'chorus') this.crash(t, 0.5 * fade);
    // drums
    if (e >= 0.5 && s.kick[step]) this.kick(t, s.kick[step]! * fade);
    if (e >= 0.55 && s.snare[step]) this.snare(t, s.snare[step]! * fade, s.station);
    if (e >= 0.55 && lastBar && step >= 12 && sec.kind !== 'outro') this.snare(t, 0.35 + (step - 12) * 0.12, s.station); // fill
    if (e >= 0.2 && s.hat[step]) this.hat(t, s.hat[step]! * (e >= 0.9 ? 1.2 : 0.8) * fade, s.station);
    // bass
    const b = s.bass[step];
    if (b !== null && b !== undefined && e >= 0.5) {
      const root = chordOn(s.root, s.mode, deg)[0]!;
      const note = b === 7 ? root + 12 : chordOn(s.root, s.mode, deg + b)[0]!;
      this.bass(t, midiToFreq(note), s16 * (s.station === 'neon' ? 1.6 : 3.2), s.station);
    }
    // chords
    if (step === 0) this.pad(t, chord.map(midiToFreq), s16 * 16, s.station, fade * (sec.kind === 'chorus' ? 1.15 : 1));
    if (s.station === 'dust' && (step === 4 || step === 12) && e >= 0.5) this.strum(t, chord.map((m) => midiToFreq(m + 12)));
    if (s.station === 'neon' && e >= 0.9 && step % 2 === 0) this.pluck(t, midiToFreq(chord[(step / 2) % chord.length]! + 24), s16 * 1.4, 'square', 0.03, 0.25);
    if (s.station === 'lowtide' && e >= 0.6 && (step === 6 || step === 14)) this.keys(t, midiToFreq(chord[1]! + 12), s16 * 4);
    // verse: instrumental melody · chorus: sung hook · bridge: long held vocal notes
    if (sec.kind === 'verse' && barInSection >= 2) {
      const l = s.lead[(barInSection % 4) * 16 + step];
      if (l !== null && l !== undefined) {
        if (s.station === 'neon') this.lead(t, midiToFreq(l), s16 * 2, 'sawtooth', 0.04);
        else if (s.station === 'dust') this.pluck(t, midiToFreq(l - 12), s16 * 3, 'triangle', 0.1, 0.2);
        else this.keys(t, midiToFreq(l - 12), s16 * 3);
      }
    } else if (sec.kind === 'chorus') {
      const h = s.hook[(barInSection % 2) * 16 + step];
      if (h !== null && h !== undefined) {
        // note length: until the next hook note (max 1 beat)
        let len = 1;
        while (len < 6 && s.hook[((barInSection % 2) * 16 + step + len) % 32] === null) len++;
        this.sing(t, midiToFreq(h), s16 * len * 0.95, step + barInSection, s.vocalFemale, 0.09 * fade);
      }
    } else if (sec.kind === 'bridge' && step === 0) {
      this.sing(t, midiToFreq(chord[2]! + (s.vocalFemale ? 12 : 0)), s16 * 14, barInSection * 3 + 1, s.vocalFemale, 0.07);
    }
  }

  /** Formant "singer": sawtooth through three vowel formants, vibrato, a little scoop into pitch. */
  private sing(t: number, f: number, dur: number, vowelSeed: number, female: boolean, amp: number): void {
    const ctx = this.ctx;
    const V = [[800, 1150, 2900], [450, 800, 2830], [325, 700, 2530], [400, 1700, 2600], [350, 2000, 2800]] as const; // a o u e i
    const v = V[Math.abs(vowelSeed * 7 + 3) % V.length]!;
    const k = female ? 1.17 : 1;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(f * 0.97, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.06);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 5.2;
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(f * 0.012, t + Math.min(0.35, dur * 0.6));
    lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.05);
    g.gain.setValueAtTime(amp, t + Math.max(0.06, dur - 0.08));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.12);
    [1, 0.55, 0.22].forEach((lvl, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = v[i]! * k;
      bp.Q.value = 9 + i * 3;
      const fg = ctx.createGain();
      fg.gain.value = lvl * 3;
      o.connect(bp).connect(fg).connect(g);
    });
    g.connect(this.speaker);
    g.connect(this.send);
    o.start(t);
    lfo.start(t);
    o.stop(t + dur + 0.2);
    lfo.stop(t + dur + 0.2);
  }

  private crash(t: number, v: number): void {
    const g = this.env(t, 0.09 * v, 0.002, 1.6, 0.4);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5000;
    src.connect(hp).connect(g);
    src.start(t, 0, 1.7);
  }

  // ------------------------------------------------------------------ instruments
  private env(t: number, peak: number, attack: number, dur: number, send = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(this.speaker);
    if (send > 0) {
      const sg = this.ctx.createGain();
      sg.gain.value = send;
      g.connect(sg).connect(this.send);
    }
    return g;
  }

  private osc(type: OscillatorType, f: number, t: number, dur: number, to: AudioNode, detune = 0): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune;
    o.connect(to);
    o.start(t);
    o.stop(t + dur + 0.05);
    return o;
  }

  private kick(t: number, v: number): void {
    const g = this.env(t, 0.55 * v, 0.003, 0.32);
    const o = this.osc('sine', 150, t, 0.32, g);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
  }

  private snare(t: number, v: number, st: string): void {
    const g = this.env(t, (st === 'lowtide' ? 0.18 : 0.28) * v, 0.002, st === 'neon' ? 0.22 : 0.14);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = st === 'lowtide' ? 'bandpass' : 'highpass';
    hp.frequency.value = st === 'lowtide' ? 2200 : 1400;
    src.connect(hp).connect(g);
    src.start(t, Math.random() * 0.5, 0.3);
    const tg = this.env(t, 0.12 * v, 0.002, 0.08);
    this.osc('triangle', 190, t, 0.08, tg);
  }

  private hat(t: number, v: number, st: string): void {
    const g = this.env(t, 0.07 * v, 0.001, st === 'dust' ? 0.06 : 0.035);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    src.connect(hp).connect(g);
    src.start(t, Math.random() * 0.5, 0.1);
  }

  private bass(t: number, f: number, dur: number, st: string): void {
    const g = this.env(t, st === 'neon' ? 0.16 : 0.2, 0.006, dur);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(st === 'neon' ? 1400 : 700, t);
    lp.frequency.exponentialRampToValueAtTime(220, t + dur);
    lp.connect(g);
    this.osc(st === 'lowtide' ? 'sine' : 'sawtooth', f, t, dur, lp);
    if (st === 'neon') this.osc('square', f / 2, t, dur, lp);
  }

  private pad(t: number, fs: number[], dur: number, st: string, gain = 1): void {
    const lvl = (st === 'neon' ? 0.035 : st === 'lowtide' ? 0.04 : 0.02) * gain;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(lvl, t + (st === 'neon' ? 0.6 : 0.15));
    g.gain.setValueAtTime(lvl, t + dur - 0.3);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = st === 'neon' ? 1600 : 1100;
    lp.connect(g).connect(this.speaker);
    g.connect(this.send);
    for (const f of fs) {
      if (st === 'lowtide') {
        this.osc('sine', f, t, dur + 0.2, lp);
        this.osc('sine', f * 2, t, dur + 0.2, lp, 4);
      } else {
        this.osc('sawtooth', f, t, dur + 0.2, lp, -7);
        this.osc('sawtooth', f, t, dur + 0.2, lp, 7);
      }
    }
  }

  private strum(t: number, fs: number[]): void {
    fs.forEach((f, i) => this.pluck(t + i * 0.018, f, 0.5, 'triangle', 0.05, 0.2));
  }

  private pluck(t: number, f: number, dur: number, type: OscillatorType, amp: number, send = 0.15): void {
    const g = this.env(t, amp, 0.003, dur, send);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(f * 6, t);
    lp.frequency.exponentialRampToValueAtTime(f * 1.2, t + dur);
    lp.connect(g);
    this.osc(type, f, t, dur, lp);
  }

  private lead(t: number, f: number, dur: number, type: OscillatorType, amp: number): void {
    const g = this.env(t, amp, 0.02, dur, 0.35);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    lp.connect(g);
    const o = this.osc(type, f, t, dur, lp);
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 5.5;
    const lg = this.ctx.createGain();
    lg.gain.value = 6;
    lfo.connect(lg).connect(o.detune);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }

  private keys(t: number, f: number, dur: number): void {
    const g = this.env(t, 0.07, 0.01, dur * 1.6, 0.3);
    this.osc('sine', f, t, dur * 1.6, g);
    const g2 = this.env(t, 0.025, 0.005, dur * 0.6);
    this.osc('sine', f * 3, t, dur * 0.6, g2);
  }
}
