import * as THREE from 'three';
import type { Game } from './Game';
import type { Vehicle } from '../vehicles/Vehicle';
import type { PedManager } from '../peds/PedManager';
import { Ped } from '../peds/Ped';
import { LockpickGame } from '../peds/Lockpick';
import { headingOf } from '../core/math';
import { rand } from '../core/rng';
import { makePose, computePose, makeAnimState } from '../characters/Pose';
import type { TrafficState } from '../vehicles/TrafficAI';

type Mode = 'none' | 'choose' | 'smash' | 'lockpick' | 'jack';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Carjacking & breaking into parked cars (with mini-game UI). */
export class TheftController {
  private mode: Mode = 'none';
  private v: Vehicle | null = null;
  private t = 0;
  private ped: Ped | null = null;
  private lock: LockpickGame | null = null;
  private choiceEl: HTMLDivElement;
  private lockEl: HTMLDivElement;
  private needleEl: HTMLDivElement;
  private zoneEl: HTMLDivElement;
  private pinsEl: HTMLDivElement;
  private msgEl: HTMLDivElement;
  private pulledPose = makePose();
  private pulledAnim = makeAnimState();
  private glassDone = false;

  constructor(private game: Game, private peds: PedManager) {
    const root = game.hud.root;
    this.choiceEl = document.createElement('div');
    this.choiceEl.className = 'dialog-choice interactive';
    this.choiceEl.innerHTML = `<button class="btn primary" data-a="smash">🪨 SMASH WINDOW</button><button class="btn" data-a="pick">🔓 LOCKPICK</button><button class="btn small" data-a="cancel">✕</button>`;
    root.appendChild(this.choiceEl);
    this.choiceEl.addEventListener('pointerdown', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      e.stopPropagation();
      if (a === 'smash') this.beginSmash();
      else if (a === 'pick') this.beginPick();
      else if (a === 'cancel') this.finish(false);
    });
    this.lockEl = document.createElement('div');
    this.lockEl.className = 'lockpick interactive';
    this.lockEl.innerHTML = `<div style="font-weight:800;letter-spacing:.1em">LOCKPICK</div><div class="track"><div class="zone"></div><div class="needle"></div></div><div class="pins"><div class="pin"></div><div class="pin"></div><div class="pin"></div></div><div class="muted" style="margin-top:6px">Tap when the needle is in the green</div>`;
    root.appendChild(this.lockEl);
    this.needleEl = this.lockEl.querySelector('.needle')!;
    this.zoneEl = this.lockEl.querySelector('.zone')!;
    this.pinsEl = this.lockEl.querySelector('.pins')!;
    this.msgEl = this.lockEl.querySelector('.muted')!;
    this.lockEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      this.pickPress();
    });
  }

  get busy(): boolean {
    return this.mode !== 'none';
  }

  /** Hook from VehicleController when the player reaches a door. Return true if handled. */
  tryEnter(v: Vehicle): boolean {
    const d = v.driver;
    if (d && d.kind === 'ped') {
      const lv = v.body.linvel();
      if (Math.hypot(lv.x, lv.z) > 6 && v.kind !== 'bike') {
        // driver floors it
        if (v.ai && (v.ai as TrafficState).kind === 'traffic') (v.ai as TrafficState).panic = 10;
        this.game.hud.toast('The driver sped off!', 1500);
        this.game.player.mode = 'foot';
        return true;
      }
      this.beginJack(v, d.ref instanceof Ped ? d.ref : null);
      return true;
    }
    if (v.locked && v.kind !== 'boat' && v.kind !== 'heli' && v.kind !== 'bike') {
      this.v = v;
      this.mode = 'choose';
      this.game.player.mode = 'scripted';
      this.game.player.vel.set(0, 0, 0);
      this.game.inputLocked = true;
      this.choiceEl.classList.add('open');
      this.game.hud.showHelp('Locked. <b>Smash</b> the window (fast, loud) or <b>pick</b> the lock (quiet). Keys: <b>LMB</b> smash · <b>E</b> lockpick', 6);
      return true;
    }
    // police / emergency vehicles are a crime even when empty
    if (v.def.cls === 'police' || v.def.cls === 'swat' || v.def.cls === 'ambulance') {
      this.reportTheft(v, 'stealPolice');
    } else if (v.role === 'parked' || v.role === 'static') {
      v.hot = v.hot || v.role === 'parked';
    }
    return false;
  }

  private beginJack(v: Vehicle, ped: Ped | null): void {
    const g = this.game;
    this.mode = 'jack';
    this.v = v;
    this.ped = ped;
    this.t = 0;
    g.player.mode = 'scripted';
    g.player.vel.set(0, 0, 0);
    g.inputLocked = true;
    if (v.ai && (v.ai as TrafficState).kind === 'traffic') (v.ai as TrafficState).shock = 4;
    v.throttle = 0;
    v.brake = 1;
    g.player.yaw = headingOf(v.position.x - g.player.pos.x, v.position.z - g.player.pos.z);
    g.player.playAction('pullout', 1.1);
    if (ped) {
      ped.setState('pulled');
      ped.vehicle = null;
    }
    v.driver = null;
  }

  private beginSmash(): void {
    const g = this.game;
    this.choiceEl.classList.remove('open');
    this.mode = 'smash';
    this.t = 0;
    this.glassDone = false;
    g.player.playAction('smash', 0.75);
    g.hud.showHelp(null);
  }

  private beginPick(): void {
    this.choiceEl.classList.remove('open');
    this.mode = 'lockpick';
    this.t = 0;
    this.lock = new LockpickGame(Math.random, this.v && this.v.def.value > 30000 ? 1.35 : 1);
    this.lockEl.style.display = 'block';
    this.game.player.held = 'lockpick';
    this.game.hud.showHelp(null);
    this.refreshPins();
  }

  private pickPress(): void {
    if (this.mode !== 'lockpick' || !this.lock) return;
    const r = this.lock.press();
    this.game.haptic(r === 'miss' || r === 'fail' ? [20, 30, 20] : 12);
    this.refreshPins();
    if (r === 'miss') this.msgEl.textContent = 'Slipped! One more mistake and the alarm goes off.';
    if (r === 'success') {
      this.msgEl.textContent = 'Click!';
      if (rand.chance(0.12)) this.triggerAlarm();
      setTimeout(() => this.finish(true), 250);
    }
    if (r === 'fail') {
      this.msgEl.textContent = 'Alarm!';
      this.triggerAlarm();
      setTimeout(() => this.finish(true), 400);
    }
  }

  private refreshPins(): void {
    const l = this.lock;
    if (!l) return;
    const pins = this.pinsEl.children;
    for (let i = 0; i < pins.length; i++) pins[i]!.classList.toggle('ok', i < l.pin);
    this.zoneEl.style.left = `${(l.zoneCenter - l.zoneWidth / 2) * 100}%`;
    this.zoneEl.style.width = `${l.zoneWidth * 100}%`;
  }

  private triggerAlarm(): void {
    const v = this.v;
    if (!v) return;
    v.alarm = 25;
    this.game.events.emit('noise', { x: v.position.x, z: v.position.z, radius: 45, kind: 'alarm' });
    this.reportTheft(v, 'alarm');
  }

  private reportTheft(v: Vehicle, type: 'theft' | 'alarm' | 'stealPolice' | 'carjack'): void {
    const witnessed = this.peds.witness(type === 'alarm' ? 'theft' : type, v.position.x, v.position.z, type === 'alarm' ? 60 : 40);
    this.game.events.emit('crime', { type, x: v.position.x, z: v.position.z, witnessed, byCop: false });
  }

  private finish(enter: boolean): void {
    const g = this.game;
    const v = this.v;
    this.choiceEl.classList.remove('open');
    this.lockEl.style.display = 'none';
    g.inputLocked = false;
    g.player.held = 'none';
    this.mode = 'none';
    this.lock = null;
    if (enter && v && !v.destroyed) {
      v.locked = false;
      v.hot = true;
      g.vctrl?.seat(v);
      if (v.def.cls === 'police' || v.def.cls === 'swat') this.reportTheft(v, 'stealPolice');
    } else if (g.player.mode === 'scripted') g.player.mode = 'foot';
    this.v = null;
    this.ped = null;
  }

  fixedUpdate(dt: number): void {
    const g = this.game;
    if (this.mode === 'none') return;
    this.t += dt;
    const v = this.v;
    if (!v) return this.finish(false);
    if (this.mode === 'choose') {
      if (g.input.pressed('attack')) this.beginSmash();
      else if (g.input.pressed('interact')) this.beginPick();
      else if (g.input.pressed('pause') || g.input.pressed('jump')) this.finish(false);
      return;
    }
    if (this.mode === 'lockpick') {
      this.lock?.tick(dt);
      if (g.input.pressed('attack') || g.input.pressed('jump') || g.input.pressed('interact')) this.pickPress();
      if (g.input.pressed('pause')) this.finish(false);
      return;
    }
    if (this.mode === 'smash') {
      if (this.t > 0.4 && !this.glassDone) {
        this.glassDone = true;
        v.u.uGlass.value = 1;
        v.toWorld(v.info.door, _v);
        const fx = g.vehicles?.effects;
        if (fx) for (let i = 0; i < 12; i++) fx.sharp.emit({ x: _v.x, y: v.position.y + 1.1, z: _v.z, vx: (Math.random() - 0.5) * 3, vy: Math.random() * 2, vz: (Math.random() - 0.5) * 3, life: 0.7, size0: 0.08, size1: 0.05, color0: 0xd8e8f0, alpha0: 0.9, alpha1: 0.4, gravity: 9.8 });
        g.events.emit('noise', { x: v.position.x, z: v.position.z, radius: 25, kind: 'alarm' });
        if (rand.chance(0.7)) this.triggerAlarm();
        else this.reportTheft(v, 'theft');
        g.haptic(30);
        g.cam.addShake(0.15);
      }
      if (this.t > 0.95) this.finish(true);
      return;
    }
    if (this.mode === 'jack') {
      const ped = this.ped;
      if (ped) {
        // drag the driver from the seat to outside the door
        const k = Math.min(1, this.t / 0.9);
        const seat = v.def.seats[0]!;
        v.toWorld([seat[0], seat[1] - 0.55, seat[2]], _v);
        v.toWorld([v.info.door[0] + 0.6, 0, v.info.door[2]], _v2);
        _v2.y = g.player.pos.y;
        ped.pos.lerpVectors(_v, _v2, k * k * (3 - 2 * k));
        ped.prevPos.copy(ped.pos);
        ped.yaw = headingOf(ped.pos.x - v.position.x, ped.pos.z - v.position.z);
        ped.sync();
        if (this.t >= 0.9 && ped.state === 'pulled') {
          ped.setCollision(true);
          ped.setState('down');
          ped.play('fall', 1.4);
          ped.hostile = true;
          ped.threat.copy(g.player.pos);
          ped.groundY = g.player.pos.y;
          // decide reaction after getting up
          const r = rand.next();
          ped.archetype = ped.archetype === 'normal' && r < 0.2 ? 'brave' : ped.archetype;
          if (ped.archetype === 'snitch' || r > 0.82) {
            ped.reportCrime = 'carjack';
            ped.reportPos.copy(v.position);
            ped.ai.afterDown = 'call';
          } else if (ped.archetype === 'brave' || ped.archetype === 'gang') ped.ai.afterDown = rand.chance(0.6) ? 'fight' : 'chase';
          else ped.ai.afterDown = 'flee';
        }
      }
      if (this.t >= 1.1) {
        this.reportTheft(v, 'carjack');
        this.finish(true);
      }
    }
  }

  update(): void {
    // pulled ped pose (state 'pulled' is rendered here)
    const p = this.ped;
    if (p && p.state === 'pulled') {
      this.pulledAnim.action = 'pulled';
      this.pulledAnim.actionT = Math.min(1, this.t / 0.9);
      this.pulledAnim.time += 1 / 60;
      computePose(this.pulledPose, this.pulledAnim);
      this.game.chars.update(p.slot, p.pos.x, p.pos.y, p.pos.z, p.yaw, this.pulledPose, 'none');
    }
    if (this.mode === 'lockpick' && this.lock) {
      this.needleEl.style.left = `calc(${(this.lock.needle * 100).toFixed(1)}% - 2px)`;
      const pl = this.game.player;
      pl.anim.action = 'lockpick';
    }
  }
}
