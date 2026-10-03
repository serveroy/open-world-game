import type { Vehicle } from '../vehicles/Vehicle';
import { driveToward } from '../vehicles/AIDriver';
import { WATER_Y } from '../world/constants';

/** Drives a vehicle along a list of waypoints (right-hand lane offset), optionally fleeing/pursuing. */
export class RouteDriver {
  i = 0;
  done = false;
  stuck = 0;
  reverseT = 0;
  constructor(
    readonly v: Vehicle,
    readonly route: [number, number][],
    public speed: number,
    readonly opts: { loop?: boolean; aggressive?: boolean; flee?: boolean; pursue?: boolean } = {},
  ) {
    // start at the closest waypoint ahead
    let best = 0, bd = Infinity;
    route.forEach(([x, z], k) => {
      const d = Math.hypot(x - v.position.x, z - v.position.z);
      if (d < bd) {
        bd = d;
        best = k;
      }
    });
    this.i = Math.min(best, route.length - 1);
    if (bd < 12 && this.i < route.length - 1) this.i++;
  }

  /** @param target player position (for pursue / flee speed boost) */
  step(dt: number, target: { x: number; z: number }): void {
    const v = this.v;
    if (v.destroyed || !v.driver) return;
    if (this.opts.pursue) {
      const lv = v.body.linvel();
      void lv;
      driveToward(v, target.x, target.z, this.speed, { aggressive: true, reverseOk: true });
      return;
    }
    if (this.done) {
      v.throttle = 0;
      v.brake = 1;
      v.steer = 0;
      return;
    }
    const [x, z] = this.route[this.i]!;
    // lane offset: shift waypoint 2.6 m to the right of the incoming segment (roads only)
    let tx = x, tz = z;
    const prev = this.route[Math.max(0, this.i - 1)]!;
    const dx = x - prev[0], dz = z - prev[1];
    const l = Math.hypot(dx, dz);
    if (l > 1 && v.kind !== 'boat' && v.kind !== 'heli') {
      const h = Math.atan2(dx, dz);
      tx += -Math.cos(h) * 2.6;
      tz += Math.sin(h) * 2.6;
    }
    const d = Math.hypot(tx - v.position.x, tz - v.position.z);
    const reach = 7 + Math.abs(v.speed) * 0.4;
    if (d < reach) {
      this.i++;
      if (this.i >= this.route.length) {
        if (this.opts.loop) this.i = 0;
        else {
          this.done = true;
          return;
        }
      }
    }
    let sp = this.speed;
    if (this.opts.flee) {
      const pd = Math.hypot(target.x - v.position.x, target.z - v.position.z);
      if (pd < 40) sp *= 1.15;
      if (pd > 140) sp *= 0.8; // let the player catch up a little
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      v.throttle = 0;
      v.brake = 0.8;
      v.steer = -v.steer;
      return;
    }
    driveToward(v, tx, tz, sp, { aggressive: this.opts.aggressive, reverseOk: true });
    if (Math.abs(v.speed) < 1 && v.throttle > 0.3 && v.position.y > WATER_Y - 2) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 2.5) {
      this.stuck = 0;
      this.reverseT = 1.3;
    }
  }
}
