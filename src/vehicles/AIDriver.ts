import * as THREE from 'three';
import type { Vehicle } from './Vehicle';
import { angleDiff, clamp } from '../core/math';

const _f = new THREE.Vector3();

/**
 * Low-level driving controller: steer toward a target point and track a target speed.
 * Shared by traffic, police pursuit and mission AI.
 */
export function driveToward(v: Vehicle, tx: number, tz: number, targetSpeed: number, opts: { aggressive?: boolean; reverseOk?: boolean } = {}): void {
  const p = v.position;
  const yaw = v.yaw;
  const want = Math.atan2(tx - p.x, tz - p.z);
  let diff = angleDiff(yaw, want); // + means target is to the left (counter-clockwise)
  const speed = v.speed;
  let reverse = false;
  if (opts.reverseOk && Math.abs(diff) > 2.2 && Math.hypot(tx - p.x, tz - p.z) < 25 && speed < 3) {
    reverse = true;
    diff = angleDiff(yaw + Math.PI, want);
  }
  // our steer convention: +1 = right (clockwise, decreasing heading)
  const k = opts.aggressive ? 2.4 : 1.8;
  v.steer = clamp(-diff * k, -1, 1) * (reverse ? -1 : 1);
  // slow down for sharp turns
  const turnSlow = 1 - Math.min(0.65, Math.abs(diff) * 0.55);
  const tgt = targetSpeed * turnSlow;
  const err = tgt - (reverse ? -speed : speed);
  if (reverse) {
    v.throttle = 0;
    v.brake = clamp(0.4 + err * 0.1, 0, 0.8);
    v.handbrake = false;
    return;
  }
  if (err > 0) {
    v.throttle = clamp(err * (opts.aggressive ? 0.45 : 0.25), 0, 1);
    v.brake = 0;
  } else {
    v.throttle = 0;
    v.brake = clamp(-err * 0.2, 0, 1);
  }
  v.handbrake = opts.aggressive === true && Math.abs(diff) > 1.1 && speed > 12;
}

/** Forward unit vector helper. */
export function fwd(v: Vehicle): THREE.Vector3 {
  return v.forward(_f);
}
