import * as THREE from 'three';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { clamp, damp, dampAngle, dampFactor, lerp } from '../core/math';
import { WATER_Y } from '../world/constants';

export type CamMode = 'foot' | 'aim' | 'vehicle' | 'hood' | 'heli' | 'cutscene' | 'scope' | 'free';

const _target = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();

/**
 * Third-person camera with orbit control, spring smoothing, collision avoidance,
 * aim zoom (over-the-shoulder), vehicle chase/hood modes and a cutscene override.
 */
export class CameraRig {
  yaw = Math.PI;
  pitch = 0.25;
  mode: CamMode = 'foot';
  private dist = 4.6;
  private fov = 62;
  private shoulder = 0;
  private lookIdle = 0;
  private shake = 0;
  private shakeT = 0;
  readonly pos = new THREE.Vector3();
  private readonly smoothTarget = new THREE.Vector3();
  private initialised = false;
  /** Cutscene control: when set, the camera eases to this pose. */
  cutPos: THREE.Vector3 | null = null;
  cutLook: THREE.Vector3 | null = null;
  cutFov = 50;
  /** Vehicle params */
  vehicleDist = 6.5;
  vehicleHeight = 2.2;
  shakeScale = 1;
  underwater = false;

  constructor(readonly camera: THREE.PerspectiveCamera, private physics: Physics) {}

  addShake(amount: number): void {
    this.shake = Math.min(1.5, this.shake + amount * this.shakeScale);
  }

  /** Apply look input (radians). */
  look(dx: number, dy: number): void {
    if (dx !== 0 || dy !== 0) this.lookIdle = 0;
    this.yaw -= dx;
    this.pitch = clamp(this.pitch + dy, -0.55, 1.25);
  }

  /** Camera forward direction (normalised) for aiming. */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return this.camera.getWorldDirection(out);
  }

  snapBehind(heading: number): void {
    this.yaw = heading;
    this.initialised = false;
  }

  /**
   * @param target pivot (player head or vehicle centre)
   * @param heading heading of followed entity (for auto-follow)
   * @param speed speed of followed entity
   */
  update(dt: number, target: THREE.Vector3, heading: number, speed: number, opts: { excludeBody?: import('@dimforge/rapier3d-compat').RigidBody; vehicleSize?: number; reverse?: boolean } = {}): void {
    this.lookIdle += dt;
    const cam = this.camera;
    if (this.mode === 'cutscene' && this.cutPos && this.cutLook) {
      const k = dampFactor(3, dt);
      this.pos.lerp(this.cutPos, k);
      cam.position.copy(this.pos);
      _look.copy(this.cutLook);
      cam.lookAt(_look);
      this.fov = damp(this.fov, this.cutFov, 4, dt);
      this.applyFov();
      return;
    }

    let dist = 4.6, height = 0.25, fov = 62, shoulder = 0.0, lag = 14;
    if (this.mode === 'aim') {
      dist = 2.3; height = 0.1; fov = 50; shoulder = 0.62; lag = 30;
    } else if (this.mode === 'scope') {
      dist = 0.01; height = 0; fov = 16; shoulder = 0; lag = 60;
    } else if (this.mode === 'vehicle' || this.mode === 'heli') {
      const size = opts.vehicleSize ?? 1;
      dist = this.vehicleDist * size + Math.min(speed, 40) * 0.035;
      height = this.vehicleHeight * size * 0.35;
      fov = 64 + Math.min(speed, 50) * 0.28;
      lag = 9;
      if (this.mode === 'heli') {
        dist = 12;
        fov = 66;
      }
      // auto-follow behind vehicle when not looking around
      if (this.lookIdle > 1.1 && speed > 2) {
        const behind = opts.reverse ? heading + Math.PI : heading;
        this.yaw = dampAngle(this.yaw, behind, 2.4, dt);
        this.pitch = damp(this.pitch, this.mode === 'heli' ? 0.32 : 0.2, 1.6, dt);
      }
    } else if (this.mode === 'hood') {
      dist = 0.01; height = 0; fov = 72; lag = 60;
      this.yaw = dampAngle(this.yaw, heading, 10, dt);
      this.pitch = damp(this.pitch, 0.02, 10, dt);
    } else if (this.mode === 'foot') {
      // gentle auto-follow while moving on foot
      if (this.lookIdle > 2.5 && speed > 3) this.yaw = dampAngle(this.yaw, heading, 0.7, dt);
    }
    this.dist = damp(this.dist, dist, 6, dt);
    this.fov = damp(this.fov, fov, 6, dt);
    this.shoulder = damp(this.shoulder, shoulder, 10, dt);

    _target.copy(target);
    _target.y += height;
    if (!this.initialised) {
      this.smoothTarget.copy(_target);
      this.initialised = true;
    } else {
      const k = dampFactor(lag, dt);
      this.smoothTarget.lerp(_target, k);
      // never lag too far (teleports, high speed)
      if (this.smoothTarget.distanceToSquared(_target) > 25) this.smoothTarget.copy(_target);
    }

    // orbit position: camera sits behind (opposite of yaw-forward)
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const rx = -Math.cos(this.yaw), rz = Math.sin(this.yaw); // right vector
    const pivot = _look.copy(this.smoothTarget);
    pivot.x += rx * this.shoulder;
    pivot.z += rz * this.shoulder;
    _desired.set(pivot.x - fx * cp * this.dist, pivot.y + sp * this.dist, pivot.z - fz * cp * this.dist);

    // collision: pull in when blocked
    if (this.mode !== 'hood' && this.mode !== 'scope') {
      const dx = _desired.x - pivot.x, dy = _desired.y - pivot.y, dz = _desired.z - pivot.z;
      const len = Math.hypot(dx, dy, dz);
      if (len > 0.05) {
        const hit = this.physics.raycast(pivot.x, pivot.y, pivot.z, dx, dy, dz, len + 0.2, GROUPS.rayCamera, opts.excludeBody);
        if (hit) {
          const d = Math.max(0.3, hit.distance - 0.25);
          _desired.set(pivot.x + (dx / len) * d, pivot.y + (dy / len) * d, pivot.z + (dz / len) * d);
        }
      }
      const minY = this.underwaterAllowed ? -50 : WATER_Y + 0.25;
      if (_desired.y < minY && this.mode !== 'heli') _desired.y = lerp(_desired.y, minY, 0.8);
    }
    this.pos.copy(_desired);

    // shake
    if (this.shake > 0.001) {
      this.shakeT += dt * 38;
      const s = this.shake * 0.12;
      this.pos.x += Math.sin(this.shakeT * 1.1) * s;
      this.pos.y += Math.sin(this.shakeT * 1.7 + 1) * s;
      this.pos.z += Math.cos(this.shakeT * 1.3) * s;
      this.shake *= Math.exp(-dt * 6);
    }
    cam.position.copy(this.pos);
    // look target slightly ahead of the pivot
    _fwd.set(fx * cp, -sp, fz * cp);
    if (this.mode === 'hood' || this.mode === 'scope') {
      cam.lookAt(_look.set(this.pos.x + _fwd.x, this.pos.y + _fwd.y + (this.mode === 'hood' ? 0 : 0), this.pos.z + _fwd.z));
    } else {
      cam.lookAt(_look.set(pivot.x + fx * 2, pivot.y + (this.mode === 'aim' ? 0.05 : 0) - sp * 0.2, pivot.z + fz * 2));
    }
    this.underwater = this.pos.y < WATER_Y - 0.05;
    this.applyFov();
  }
  underwaterAllowed = false;

  private applyFov(): void {
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Place camera directly (hood / first person) after update. */
  setHood(pos: THREE.Vector3): void {
    this.camera.position.copy(pos);
    const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.camera.lookAt(pos.x + fx * cp, pos.y - sp, pos.z + fz * cp);
    this.pos.copy(pos);
  }
}
