import * as THREE from 'three';
import type { Game } from './Game';
import type { Vehicle } from '../vehicles/Vehicle';
import type { VehicleManager } from '../vehicles/VehicleManager';
import { computePose, makeAnimState, makePose, blendPose, type Pose } from '../characters/Pose';
import { clamp, dampFactor } from '../core/math';
import { headingOf } from '../core/math';
import { GROUPS } from '../physics/groups';

type Phase = 'none' | 'approach' | 'opening' | 'exiting';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

/** Player ↔ vehicle interaction: entering, driving, exiting, seated rendering. */
export class VehicleController {
  vehicle: Vehicle | null = null;
  target: Vehicle | null = null;
  private phase: Phase = 'none';
  private phaseT = 0;
  private hood = false;
  private seatPose: Pose = makePose();
  private seatTarget: Pose = makePose();
  private anim = makeAnimState();
  /** Hook for carjack / lockpick flows (M4): return true if handled. */
  onTryEnter: ((v: Vehicle) => boolean) | null = null;
  onEntered: ((v: Vehicle) => void) | null = null;
  onExited: ((v: Vehicle) => void) | null = null;

  constructor(private game: Game, private vm: VehicleManager) {}

  get inVehicle(): boolean {
    return this.vehicle !== null;
  }

  /** Nearest vehicle the player can enter (door within reach). */
  findEnterable(): Vehicle | null {
    const p = this.game.player.pos;
    let best: Vehicle | null = null;
    let bd = Infinity;
    for (const v of this.vm.vehicles) {
      if (v.destroyed || v.driver?.kind === 'player') continue;
      const reach = v.kind === 'heli' ? 5 : v.kind === 'boat' ? 4.5 : v.def.cls === 'bus' ? 4 : 3.2;
      const dc = v.position.distanceTo(p);
      if (dc > v.def.length / 2 + reach) continue;
      v.toWorld(v.info.door, _v);
      v.toWorld(v.info.door2, _v2);
      const d = Math.min(_v.distanceTo(p), _v2.distanceTo(p), dc - v.def.length * 0.3);
      if (d < reach && d < bd && Math.abs(v.position.y - p.y) < 3) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  /** Begin entering a vehicle (walk to the door first). */
  enter(v: Vehicle, instant = false): void {
    const p = this.game.player;
    if (instant) {
      this.seat(v);
      return;
    }
    this.target = v;
    this.phase = 'approach';
    this.phaseT = 0;
    p.mode = 'scripted';
  }

  /** Put the player into the driver's seat. */
  seat(v: Vehicle): void {
    const g = this.game;
    const p = g.player;
    this.vehicle = v;
    this.target = null;
    this.phase = 'none';
    v.driver = { kind: 'player', ref: p };
    v.role = 'player';
    v.ai = null;
    v.locked = false;
    v.engineOn = true;
    v.handbrake = false;
    v.persistent = false;
    p.mode = 'vehicle';
    p.setCollisionEnabled(false);
    p.held = 'none';
    g.cam.mode = v.kind === 'heli' ? 'heli' : this.hood ? 'hood' : 'vehicle';
    g.cam.snapBehind(v.yaw);
    g.touchVehicleMode = v.kind === 'heli' ? 'heli' : v.kind === 'boat' ? 'boat' : 'vehicle';
    g.hud.toast(v.def.name, 1500);
    this.onEntered?.(v);
    g.events.emit('vehicleEntered', { vehicle: v, stolen: false });
  }

  exit(force = false): void {
    const g = this.game;
    const v = this.vehicle;
    if (!v) return;
    const p = g.player;
    const fast = Math.abs(v.speed) > 7 && v.kind !== 'heli';
    if (!force && !fast && v.kind !== 'boat' && v.kind !== 'heli' && Math.abs(v.speed) > 2) {
      // slow down first; exit when nearly stopped
      this.pendingExit = true;
      return;
    }
    this.pendingExit = false;
    v.driver = null;
    v.throttle = 0;
    v.lift = 0;
    v.role = 'parked';
    v.handbrake = !fast;
    v.persistent = true; // keep last-used car around for a while
    v.idleTime = 0;
    if (v.kind !== 'heli' || v.speed < 2) v.engineOn = v.kind === 'heli';
    // exit position: driver door if free, else passenger side, else roof
    const options = [v.info.door, v.info.door2];
    let placed = false;
    for (const d of options) {
      v.toWorld(d, _v);
      const ground = g.physics.raycast(_v.x, _v.y + 2.5, _v.z, 0, -1, 0, 8);
      const gy = ground ? ground.y : _v.y;
      const blocked = g.physics.raycast(v.position.x, gy + 0.9, v.position.z, _v.x - v.position.x, 0, _v.z - v.position.z, _v.distanceTo(v.position), GROUPS.rayWorldVehicles, v.body);
      if (!blocked || blocked.owner?.ref === v) {
        p.teleport(_v.x, gy + 0.05, _v.z, v.yaw);
        placed = true;
        break;
      }
    }
    if (!placed) p.teleport(v.position.x, v.position.y + v.info.half[1] * 2 + 0.6, v.position.z, v.yaw);
    p.mode = 'foot';
    p.setCollisionEnabled(true);
    if (v.kind === 'boat' || (v.kind === 'heli' && v.position.y > 3)) {
      p.vel.set(0, 0, 0);
    }
    if (fast) {
      // bail out: tumble sideways with the vehicle's momentum
      const lv = v.body.linvel();
      p.vel.set(lv.x * 0.5, 2, lv.z * 0.5);
      p.vitals.damage(Math.min(25, Math.abs(v.speed) * 1.2), true);
      g.hud.damageFlash(0.6);
      p.playAction('fall', 0.9);
    }
    this.vehicle = null;
    g.cam.mode = 'foot';
    g.cam.snapBehind(v.yaw);
    this.onExited?.(v);
    g.events.emit('vehicleExited', { vehicle: v });
  }
  pendingExit = false;

  fixedUpdate(dt: number): void {
    const g = this.game;
    const p = g.player;
    const inp = g.input;
    // entering sequence
    if (this.target && this.phase !== 'none') {
      const v = this.target;
      this.phaseT += dt;
      if (v.destroyed || v.position.distanceTo(p.pos) > 12) {
        this.cancelEnter();
        return;
      }
      if (this.phase === 'approach') {
        // walk toward the nearest door
        v.toWorld(v.info.door, _v);
        v.toWorld(v.info.door2, _v2);
        const door = _v.distanceTo(p.pos) <= _v2.distanceTo(p.pos) + 0.8 ? _v : _v2;
        const dx = door.x - p.pos.x, dz = door.z - p.pos.z;
        const d = Math.hypot(dx, dz);
        p.mode = 'foot';
        p.step(dt, { dx: d > 0.01 ? dx / d : 0, dz: d > 0.01 ? dz / d : 0, sprint: d > 4, jump: false, crouch: false, faceYaw: null });
        p.mode = 'scripted';
        if (d < 0.6 || this.phaseT > 2.2 || v.kind === 'boat' || v.kind === 'heli' || v.kind === 'bike') {
          if (this.onTryEnter && this.onTryEnter(v)) {
            // handled by theft flow (carjack / lockpick); it will call seat() itself
            this.phase = 'none';
            this.target = null;
            return;
          }
          this.phase = 'opening';
          this.phaseT = 0;
          p.yaw = headingOf(v.position.x - p.pos.x, v.position.z - p.pos.z);
          p.playAction('open_door', 0.45);
        }
      } else if (this.phase === 'opening') {
        p.prevPos.copy(p.pos);
        if (this.phaseT > 0.45) this.seat(v);
      }
      if (inp.pressed('enter') && this.phaseT > 0.3) this.cancelEnter();
      return;
    }
    const v = this.vehicle;
    if (!v) return;
    if (g.inputLocked) {
      v.throttle = 0;
      v.brake = 1;
      v.steer = 0;
      return;
    }
    // driving input
    const gas = Math.max(inp.down('gas') ? 1 : 0, inp.throttle, inp.lastDevice === 'touch' ? 0 : 0);
    const brake = Math.max(inp.down('brake') ? 1 : 0, inp.brakeAxis);
    if (v.kind === 'heli') {
      const up = (inp.down('ascend') || inp.down('gas') ? 1 : 0) - (inp.down('descend') || inp.down('brake') ? 1 : 0);
      v.lift = clamp(up, -1, 1);
      v.pitchIn = clamp(inp.moveY, -1, 1);
      v.steer = clamp(inp.moveX, -1, 1);
      v.throttle = 0;
    } else {
      v.throttle = this.pendingExit ? 0 : gas;
      v.brake = this.pendingExit ? 1 : brake;
      v.steer = clamp(inp.moveX, -1, 1);
      v.handbrake = inp.down('handbrake') && inp.lastDevice !== 'keyboard' ? true : inp.down('handbrake');
    }
    if (inp.pressed('horn')) v.hornT = 0.25;
    v.horn = inp.down('horn');
    if (v.horn) v.hornT = Math.max(v.hornT, 0.05);
    if (inp.pressed('lights')) v.lights = !v.lights;
    if (inp.pressed('camera')) {
      this.hood = !this.hood;
      if (v.kind !== 'heli') g.cam.mode = this.hood ? 'hood' : 'vehicle';
    }
    if (v.def.siren && inp.pressed('horn') && inp.down('handbrake')) v.siren = !v.siren;
    if (inp.pressed('enter')) this.exit();
    if (this.pendingExit && Math.abs(v.speed) < 1.5) this.exit(true);
    // auto lights at night for the player too
    if (g.env && g.env.night > 0.4 && !v.lights && v.engineOn) v.lights = true;
  }

  private cancelEnter(): void {
    this.target = null;
    this.phase = 'none';
    if (this.game.player.mode === 'scripted') this.game.player.mode = 'foot';
  }

  update(dt: number): void {
    const g = this.game;
    const p = g.player;
    // contextual enter prompt
    if (p.mode === 'foot' && !this.vehicle) {
      const near = this.findEnterable();
      g.touch.setContext('enter', !!near, near ? (near.driver && near.driver.kind === 'ped' ? 'JACK' : near.locked ? 'BREAK IN' : 'ENTER') : 'ENTER');
      if (g.inputLocked) return;
      if (near && g.input.pressed('enter')) this.enter(near);
    } else g.touch.setContext('enter', false);

    if (this.target && this.phase !== 'none') {
      // render player walking toward the car via normal path
      p.mode = 'foot';
      p.updateVisual(dt, g.alpha, 0, 'none');
      p.mode = 'scripted';
      return;
    }
    const v = this.vehicle;
    if (!v) return;
    // seated character follows the vehicle
    const seat = v.def.seats[0]!;
    v.toWorld([seat[0], seat[1] - 0.55 + (v.kind === 'bike' ? 0.0 : 0), seat[2]], _v);
    _q.copy(v.renderQuat);
    _v.copy(new THREE.Vector3(seat[0], seat[1] - 0.55, seat[2]).applyQuaternion(v.renderQuat).add(v.renderPos));
    _e.setFromQuaternion(_q, 'YXZ');
    this.anim.driving = true;
    this.anim.bike = v.kind === 'bike';
    this.anim.steer = v.steer;
    this.anim.time += dt;
    this.anim.lean = v.kind === 'bike' ? 0 : -v.steer * 0.1;
    this.anim.aim = 'none';
    this.anim.action = 'none';
    computePose(this.seatTarget, this.anim);
    if (v.kind === 'boat' || v.kind === 'heli') {
      // standing at the helm / seated in cockpit
      if (v.kind === 'boat' && v.def.style === 'skiff') {
        this.seatTarget.rootY = -0.42;
      }
    }
    blendPose(this.seatPose, this.seatTarget, dampFactor(12, dt));
    p.pos.copy(v.position);
    p.renderPos.copy(_v);
    p.prevPos.copy(p.pos);
    p.yaw = _e.y;
    const showBody = !(g.cam.mode === 'hood');
    if (showBody) g.chars.update(p.slot, _v.x, _v.y, _v.z, _e.y, this.seatPose, 'none');
    else g.chars.hide(p.slot);
    // camera
    const size = clamp(v.def.length / 4.6, 0.7, 2.4);
    const target = _v2.copy(v.renderPos);
    target.y += v.info.center[1] + v.info.half[1] * 0.9;
    if (g.cam.mode === 'hood') {
      const eye = v.toWorld([seat[0] * 0.3, seat[1] + 0.55, seat[2] + 0.35], new THREE.Vector3());
      g.cam.yaw = v.yaw;
      g.cam.update(dt, target, v.yaw, Math.abs(v.speed), { excludeBody: v.body, vehicleSize: size });
      g.cam.setHood(eye);
    } else {
      g.cam.update(dt, target, v.yaw, Math.abs(v.speed), { excludeBody: v.body, vehicleSize: size, reverse: v.speed < -2 });
    }
    // HUD
    g.hud.speedometer(true, Math.abs(v.speed) * 3.6, v.def.name, v.health.fraction, g.settings.data.units === 'imperial');
  }
}
