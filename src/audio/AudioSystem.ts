import * as THREE from 'three';
import { Howler } from 'howler';
import type { Game, System } from '../game/Game';
import type { Vehicle } from '../vehicles/Vehicle';
import { SfxBank } from './Sfx';
import { Radio } from './Radio';
import { STATIONS } from './music';
import { coastX, districtAt } from '../world/MapData';
import type { Ped } from '../peds/Ped';
import { sirensQ, syncTags, vehiclesQ } from '../ecs/world';

const _f = new THREE.Vector3();
const _u = new THREE.Vector3();

/** One continuous engine voice (car/bike/boat/heli), optionally spatialised. */
class EngineVoice {
  readonly out: GainNode;
  private o1: OscillatorNode;
  private o2: OscillatorNode;
  private nsrc: AudioBufferSourceNode;
  private ng: GainNode;
  private nf: BiquadFilterNode;
  private lp: BiquadFilterNode;
  private lfo: OscillatorNode;
  private lfoG: GainNode;
  readonly panner: PannerNode | null;
  v: Vehicle | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode, noise: AudioBuffer, spatial: boolean) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 800;
    this.o1 = ctx.createOscillator();
    this.o1.type = 'sawtooth';
    this.o2 = ctx.createOscillator();
    this.o2.type = 'square';
    const g1 = ctx.createGain(), g2 = ctx.createGain();
    g1.gain.value = 0.5;
    g2.gain.value = 0.35;
    this.o1.connect(g1).connect(this.lp);
    this.o2.connect(g2).connect(this.lp);
    this.nsrc = ctx.createBufferSource();
    this.nsrc.buffer = noise;
    this.nsrc.loop = true;
    this.nf = ctx.createBiquadFilter();
    this.nf.type = 'bandpass';
    this.nf.frequency.value = 400;
    this.ng = ctx.createGain();
    this.ng.gain.value = 0.1;
    this.nsrc.connect(this.nf).connect(this.ng).connect(this.lp);
    // amplitude LFO (heli rotor "whop", idle lope)
    this.lfo = ctx.createOscillator();
    this.lfo.frequency.value = 0;
    this.lfoG = ctx.createGain();
    this.lfoG.gain.value = 0;
    const am = ctx.createGain();
    am.gain.value = 1;
    this.lfo.connect(this.lfoG).connect(am.gain);
    this.lp.connect(am).connect(this.out);
    if (spatial) {
      this.panner = ctx.createPanner();
      this.panner.panningModel = 'equalpower';
      this.panner.distanceModel = 'inverse';
      this.panner.refDistance = 5;
      this.panner.rolloffFactor = 1.2;
      this.out.connect(this.panner).connect(dest);
    } else {
      this.panner = null;
      this.out.connect(dest);
    }
    this.o1.start();
    this.o2.start();
    this.nsrc.start(0, Math.random());
    this.lfo.start();
  }

  set(v: Vehicle | null, level: number): void {
    const t = this.ctx.currentTime;
    this.v = v;
    if (!v || !v.engineOn || v.destroyed) {
      this.out.gain.setTargetAtTime(0, t, 0.15);
      return;
    }
    const d = v.def;
    const thr = Math.max(v.throttle, v.brake > 0.2 && v.speed < 0 ? v.brake : 0);
    if (d.kind === 'heli') {
      const rs = v.rotorSpeed;
      this.o1.frequency.setTargetAtTime(60 + rs * 40, t, 0.1);
      this.o2.frequency.setTargetAtTime(900 + rs * 700, t, 0.1);
      this.nf.frequency.setTargetAtTime(500, t, 0.1);
      this.ng.gain.setTargetAtTime(1.4 * rs, t, 0.1);
      this.lp.frequency.setTargetAtTime(900 + rs * 600, t, 0.1);
      this.lfo.frequency.setTargetAtTime(3 + rs * 9, t, 0.1);
      this.lfoG.gain.setTargetAtTime(0.7 * rs, t, 0.1);
      this.out.gain.setTargetAtTime(level * (0.15 + rs * 0.5), t, 0.1);
    } else {
      const cyl = d.kind === 'bike' ? 2 + Math.round(d.engineTone * 2) : 4 + Math.round(d.engineTone * 4);
      const f = (v.rpm / 60) * (cyl / 2) * (d.kind === 'boat' ? 0.6 : 1);
      this.o1.frequency.setTargetAtTime(f, t, 0.04);
      this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.04);
      this.nf.frequency.setTargetAtTime(d.kind === 'boat' ? 300 : f * 2, t, 0.05);
      this.ng.gain.setTargetAtTime(d.kind === 'boat' ? 1.2 : 0.15 + thr * 0.25, t, 0.08);
      this.lp.frequency.setTargetAtTime(280 + thr * 1800 + v.rpm * 0.12 + d.engineTone * 300, t, 0.06);
      // big engines lope at idle
      this.lfo.frequency.setTargetAtTime(f / cyl, t, 0.1);
      this.lfoG.gain.setTargetAtTime(v.rpm < 1300 ? d.engineTone * 0.35 : 0, t, 0.2);
      this.out.gain.setTargetAtTime(level * (0.2 + thr * 0.3) * (0.7 + d.engineTone * 0.5), t, 0.06);
    }
    if (this.panner) {
      const p = v.position;
      this.panner.positionX.setTargetAtTime(p.x, t, 0.03);
      this.panner.positionY.setTargetAtTime(p.y, t, 0.03);
      this.panner.positionZ.setTargetAtTime(p.z, t, 0.03);
    }
  }
}

/** Siren / horn / alarm voice (two oscillators driven per frame). */
class ToneVoice {
  readonly out: GainNode;
  readonly a: OscillatorNode;
  readonly b: OscillatorNode;
  readonly panner: PannerNode;
  v: Vehicle | null = null;

  constructor(private ctx: AudioContext, dest: AudioNode, type: OscillatorType, cutoff: number) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.a = ctx.createOscillator();
    this.b = ctx.createOscillator();
    this.a.type = this.b.type = type;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    this.a.connect(lp);
    this.b.connect(lp);
    lp.connect(this.out);
    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 8;
    this.panner.rolloffFactor = 0.9;
    this.out.connect(this.panner).connect(dest);
    this.a.start();
    this.b.start();
  }

  place(p: THREE.Vector3): void {
    const t = this.ctx.currentTime;
    this.panner.positionX.setTargetAtTime(p.x, t, 0.03);
    this.panner.positionY.setTargetAtTime(p.y + 1, t, 0.03);
    this.panner.positionZ.setTargetAtTime(p.z, t, 0.03);
  }

  level(g: number): void {
    this.out.gain.setTargetAtTime(g, this.ctx.currentTime, 0.03);
  }
}

/**
 * Game audio: Howler one-shots (procedurally rendered), live engines/sirens/horns/skids, ambience
 * beds that follow district/weather/time, and the radio. Volumes follow Settings.
 */
export class AudioSystem implements System {
  name = 'audio';
  readonly sfx = new SfxBank();
  ctx: AudioContext | null = null;
  radio: Radio | null = null;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noise!: AudioBuffer;
  private player!: EngineVoice;
  private ai: EngineVoice[] = [];
  private sirens: ToneVoice[] = [];
  private horns: ToneVoice[] = [];
  private alarm!: ToneVoice;
  private skidG!: GainNode;
  private windG!: GainNode;
  private amb: Record<'city' | 'wind' | 'waves' | 'rain', { g: GainNode; f: BiquadFilterNode }> = {} as never;
  private chirpT = 0;
  private stepT = 0;
  private cashT = 0;
  private heartT = 0;
  private station = 0;
  private inClub = false;
  private started = false;
  private t = 0;

  constructor(private game: Game) {
    this.station = game.settings.data.radioStation >= 3 ? -1 : game.settings.data.radioStation;
    const unlock = (): void => {
      this.init();
      void this.ctx?.resume?.();
    };
    addEventListener('pointerdown', unlock);
    addEventListener('keydown', unlock);
    addEventListener('touchend', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) void this.ctx.suspend();
      else void this.ctx.resume();
    });
    // UI click feedback
    addEventListener('click', (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('.btn, button.card, button.item, button.app')) this.ui('ui');
    }, true);
    this.hookEvents();
  }

  /** Create the audio graph (needs a user gesture on mobile). Safe to call repeatedly. */
  init(): void {
    if (this.started) return;
    const s = this.game.settings.data;
    try {
      Howler.volume(s.masterVolume);
    } catch {
      return;
    }
    const ctx = (Howler as unknown as { ctx: AudioContext | null }).ctx;
    const master = (Howler as unknown as { masterGain: GainNode | null }).masterGain;
    if (!ctx || !master) return;
    this.started = true;
    this.ctx = ctx;
    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = s.sfxVolume;
    this.sfxBus.connect(master);
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = s.musicVolume;
    this.musicBus.connect(master);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.player = new EngineVoice(ctx, this.sfxBus, this.noise, false);
    for (let i = 0; i < 3; i++) this.ai.push(new EngineVoice(ctx, this.sfxBus, this.noise, true));
    for (let i = 0; i < 2; i++) this.sirens.push(new ToneVoice(ctx, this.sfxBus, 'sawtooth', 2400));
    for (let i = 0; i < 2; i++) this.horns.push(new ToneVoice(ctx, this.sfxBus, 'square', 1800));
    this.alarm = new ToneVoice(ctx, this.sfxBus, 'square', 2600);
    this.skidG = this.loopNoise('bandpass', 1100, 1.2);
    this.windG = this.loopNoise('lowpass', 500, 0.7);
    for (const [k, type, f] of [['city', 'lowpass', 260], ['wind', 'bandpass', 420], ['waves', 'lowpass', 520], ['rain', 'highpass', 2600]] as const) {
      const flt = ctx.createBiquadFilter();
      flt.type = type;
      flt.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      src.connect(flt).connect(g).connect(this.sfxBus);
      src.start(0, Math.random() * 2);
      this.amb[k] = { g, f: flt };
    }
    this.radio = new Radio(ctx, this.musicBus);
    this.radio.onSongChange = (st, song) => {
      if (this.game.vctrl?.inVehicle && !this.inClub) this.game.hud.radio(`${st.name} · “${song.title}”`);
    };
    void this.sfx.build();
    this.game.settings.onChange((st) => {
      Howler.volume(st.masterVolume);
      this.sfxBus.gain.setTargetAtTime(st.sfxVolume, ctx.currentTime, 0.05);
      this.musicBus.gain.setTargetAtTime(st.musicVolume, ctx.currentTime, 0.05);
    });
  }

  private loopNoise(type: BiquadFilterType, f: number, q: number): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    flt.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(flt).connect(g).connect(this.sfxBus);
    src.start(0, Math.random() * 2);
    return g;
  }

  private get sfxVol(): number {
    return this.game.settings.data.sfxVolume;
  }

  /** Spatial one-shot at a world position. */
  at(name: string, x: number, y: number, z: number, vol = 1, rate = 1, ref = 6): void {
    if (!this.sfx.ready) return;
    this.sfx.play(name, { x, y, z, vol: vol * this.sfxVol, rate: rate * (0.94 + Math.random() * 0.12), ref });
  }

  /** Non-spatial UI / music sting. */
  ui(name: string, vol = 1): void {
    if (!this.sfx.ready) return;
    this.sfx.play(name, { vol: vol * this.sfxVol });
  }

  private hookEvents(): void {
    const ev = this.game.events;
    ev.on('shot', (e) => {
      const w = e.weapon;
      const name = w === 'smg' || w === 'shotgun' || w === 'rifle' || w === 'sniper' ? w : 'pistol';
      this.at(name, e.x, e.y, e.z, e.silenced ? 0.3 : e.byPlayer ? 0.8 : 0.9, 1, e.byPlayer ? 10 : 14);
    });
    ev.on('explosion', (e) => {
      this.at('explosion', e.x, e.y, e.z, 1, 0.9 + Math.random() * 0.2, 30);
      this.game.haptic([40, 30, 80]);
    });
    ev.on('pedHurt', (e) => {
      const p = e.ped as Ped;
      if (!p?.pos) return;
      const w = this.game.combat?.arsenal.current;
      if (e.byPlayer && (w === 'fists' || w === 'bat' || w === 'knife')) this.at(w === 'bat' ? 'bat' : w === 'knife' ? 'stab' : 'punch', p.pos.x, p.pos.y + 1, p.pos.z, 0.9, 1, 4);
    });
    ev.on('missionPassed', () => this.ui('passed'));
    ev.on('missionFailed', () => this.ui('failed'));
    ev.on('playerDied', () => this.ui('wasted'));
    ev.on('playerBusted', () => this.ui('busted'));
    ev.on('cashChanged', (e) => {
      if (e.delta > 0 && this.cashT <= 0) {
        this.ui('cash', 0.7);
        this.cashT = 0.4;
      } else if (e.delta < 0 && this.game.ui.open && this.cashT <= 0) {
        this.ui('buy', 0.8);
        this.cashT = 0.3;
      }
    });
    ev.on('pickup', (e) => this.ui(e.kind === 'shell' ? 'shell' : 'pickup'));
    ev.on('vehicleEntered', () => this.ui('door', 0.5));
    ev.on('vehicleExited', () => this.ui('door', 0.5));
  }

  /** Called once systems exist (vehicle impacts). */
  attach(): void {
    const vm = this.game.vehicles;
    if (!vm) return;
    const prev = vm.onImpact;
    vm.onImpact = (v, intensity, other) => {
      prev?.(v, intensity, other);
      if (intensity > 0.06) {
        const p = v.position;
        this.at(intensity > 0.35 ? 'crash' : 'thud', p.x, p.y, p.z, Math.min(1, 0.3 + intensity), 0.9 + Math.random() * 0.2, 8);
        if (v.driver?.kind === 'player') this.game.haptic(Math.round(20 + intensity * 80));
      }
    };
  }

  setClub(on: boolean, station: number): void {
    this.inClub = on;
    if (on) this.radio?.tune(station);
  }

  update(dt: number): void {
    if (!this.started || !this.ctx) return;
    const g = this.game;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.t += dt;
    this.cashT -= dt;
    const paused = g.ui.pausing;
    // listener = camera
    const cam = g.renderer.camera;
    cam.getWorldDirection(_f);
    _u.set(0, 1, 0).applyQuaternion(cam.quaternion);
    Howler.pos(cam.position.x, cam.position.y, cam.position.z);
    Howler.orientation(_f.x, _f.y, _f.z, _u.x, _u.y, _u.z);
    const L = ctx.listener;
    if (L.positionX) {
      L.positionX.setTargetAtTime(cam.position.x, t, 0.02);
      L.positionY.setTargetAtTime(cam.position.y, t, 0.02);
      L.positionZ.setTargetAtTime(cam.position.z, t, 0.02);
    }
    const world = paused ? 0 : 1;
    // player engine + skid + wind
    const pv = g.vctrl?.vehicle ?? null;
    this.player.set(pv, world);
    let slip = 0;
    if (pv && pv.ctrl) for (let i = 0; i < pv.wheelSlip.length; i++) if (pv.wheelContact[i]) slip += Math.max(0, pv.wheelSlip[i]! - 0.35);
    this.skidG.gain.setTargetAtTime(world * Math.min(0.5, slip * 0.18) * (pv && Math.abs(pv.speed) > 3 ? 1 : 0), t, 0.05);
    const spd = pv ? Math.abs(pv.speed) : Math.hypot(g.player.vel.x, g.player.vel.z) * 0.5 + Math.max(0, -g.player.vel.y);
    this.windG.gain.setTargetAtTime(world * Math.min(0.25, spd * spd * 0.00012), t, 0.1);
    // nearby AI engines, sirens, horns, alarm (queried from the ECS index)
    syncTags();
    this.assignVoices(world);
    // ambience
    const p = g.focus;
    const dist = districtAt(p.x, p.z);
    const city = dist !== 'desert' && dist !== 'sea' && dist !== 'coralkeys' && dist !== 'pelican' && dist !== 'beach';
    const coast = Math.max(0, 1 - Math.max(0, p.x - coastX(p.z)) / 90);
    const night = g.env?.night ?? 0;
    const rain = g.env?.weather.params.rain ?? 0;
    const inside = this.inClub ? 0.15 : 1;
    this.amb.city.g.gain.setTargetAtTime(world * inside * (city ? 0.07 * (1 - night * 0.5) : 0.015), t, 0.5);
    this.amb.wind.g.gain.setTargetAtTime(world * inside * (city ? 0.01 : 0.05 + 0.03 * Math.sin(this.t * 0.3)), t, 0.5);
    this.amb.wind.f.frequency.setTargetAtTime(380 + Math.sin(this.t * 0.21) * 120, t, 0.5);
    this.amb.waves.g.gain.setTargetAtTime(world * inside * (coast * (0.06 + 0.05 * Math.max(0, Math.sin(this.t * 0.55)))), t, 0.3);
    this.amb.rain.g.gain.setTargetAtTime(world * inside * rain * 0.12, t, 0.5);
    // crickets on warm nights outside downtown
    if (world && night > 0.6 && !city && rain < 0.1 && !this.inClub) {
      this.chirpT -= dt;
      if (this.chirpT <= 0) {
        this.chirpT = 0.5 + Math.random() * 1.4;
        this.chirp(t);
      }
    }
    // footsteps
    const pl = g.player;
    const fs = Math.hypot(pl.vel.x, pl.vel.z);
    if (world && pl.mode === 'foot' && pl.grounded && !pl.swimming && fs > 1.2) {
      this.stepT -= dt * (fs / 2.2);
      if (this.stepT <= 0) {
        this.stepT = 0.42;
        this.at('step', pl.pos.x, pl.pos.y, pl.pos.z, Math.min(0.5, 0.15 + fs * 0.05), 0.9 + Math.random() * 0.2, 2);
      }
    }
    // low-health heartbeat
    if (world && pl.vitals.health < 25 && pl.mode !== 'dead') {
      this.heartT -= dt;
      if (this.heartT <= 0) {
        this.heartT = 0.85;
        this.ui('heartbeat', 0.5);
      }
    }
    this.updateRadio(dt, pv, paused);
  }

  private chirp(t: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.frequency.value = 4200 + Math.random() * 600;
    const g = ctx.createGain();
    g.gain.value = 0;
    const n = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      g.gain.setValueAtTime(0.012, t + i * 0.05);
      g.gain.setValueAtTime(0, t + i * 0.05 + 0.025);
    }
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + n * 0.05 + 0.05);
  }

  private assignVoices(world: number): void {
    const g = this.game;
    const vm = g.vehicles;
    const t = this.ctx!.currentTime;
    if (!vm) return;
    const cam = g.renderer.camera.position;
    const pv = g.vctrl?.vehicle ?? null;
    const near: { v: Vehicle; d: number }[] = [];
    for (const { vehicle: v } of vehiclesQ) {
      if (v === pv || v.destroyed) continue;
      const d = v.position.distanceTo(cam);
      if (d < 90) near.push({ v, d });
    }
    near.sort((a, b) => a.d - b.d);
    const engines = near.filter((n) => n.v.engineOn && n.d < 60);
    this.ai.forEach((voice, i) => voice.set(engines[i]?.v ?? null, world * 0.7));
    // sirens (including the player's own cop car)
    const sir: Vehicle[] = [];
    for (const { vehicle: v } of sirensQ) if (v !== pv && v.position.distanceTo(cam) < 160) sir.push(v);
    sir.sort((a, b) => a.position.distanceTo(cam) - b.position.distanceTo(cam));
    if (pv?.siren) sir.unshift(pv);
    this.sirens.forEach((s, i) => {
      const v = sir[i];
      if (!v) return s.level(0);
      const k = this.t + i * 1.7;
      const yelp = Math.floor(k / 6) % 2 === 1;
      const f = yelp ? 700 + 500 * (0.5 + 0.5 * Math.sign(Math.sin(k * 2 * Math.PI * 4))) : 650 + 650 * (0.5 + 0.5 * Math.sin(k * 2 * Math.PI * 0.28));
      s.a.frequency.setTargetAtTime(f, t, 0.02);
      s.b.frequency.setTargetAtTime(f * 1.005, t, 0.02);
      s.place(v.position);
      s.level(world * 0.13);
    });
    const hn = near.filter((n) => n.v.hornT > 0 || n.v.horn).map((n) => n.v);
    if (pv && (pv.horn || pv.hornT > 0)) hn.unshift(pv);
    this.horns.forEach((h, i) => {
      const v = hn[i];
      if (!v) return h.level(0);
      const big = v.def.mass > 3000;
      h.a.frequency.setTargetAtTime(big ? 220 : 370 + (v.id % 5) * 12, t, 0.01);
      h.b.frequency.setTargetAtTime(big ? 277 : 466 + (v.id % 5) * 12, t, 0.01);
      h.place(v.position);
      h.level(world * 0.12);
    });
    const al = near.find((n) => n.v.alarm > 0)?.v;
    if (al) {
      const on = Math.floor(this.t * 5) % 2 === 0;
      this.alarm.a.frequency.setTargetAtTime(on ? 900 : 650, t, 0.005);
      this.alarm.b.frequency.setTargetAtTime(on ? 905 : 655, t, 0.005);
      this.alarm.place(al.position);
      this.alarm.level(world * 0.07);
    } else this.alarm.level(0);
  }

  private updateRadio(dt: number, pv: Vehicle | null, paused: boolean): void {
    const g = this.game;
    const r = this.radio;
    if (!r) return;
    void dt;
    if (this.inClub) {
      r.setLevel(0.9, 0);
      r.update();
      return;
    }
    const inVeh = !!pv && pv.def.kind !== 'heli';
    if (inVeh && g.input.pressed('radio') && !g.controlsLocked) {
      this.station = this.station >= STATIONS.length - 1 ? -1 : this.station + 1;
      if (this.station === -1) g.hud.radio('RADIO OFF');
      r.tune(this.station);
      if (this.station >= 0) g.hud.radio(`${STATIONS[this.station]!.name} · “${r.songTitle}”`);
    }
    if (inVeh && this.station >= 0) {
      if (!r.current) {
        r.tune(this.station);
        g.hud.radio(`${STATIONS[this.station]!.name} · “${r.songTitle}”`);
      }
      r.setLevel(paused ? 0.25 : 0.55, 0);
    } else if (r.current) {
      // keep the music going briefly when stepping out, muffled, then stop
      r.setLevel(0, 0.8);
      if (!inVeh && this.t % 3 < dt) r.tune(-1);
    }
    r.update();
  }
}
