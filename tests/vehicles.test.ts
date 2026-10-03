import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../src/physics/Physics';
import { Vehicle } from '../src/vehicles/Vehicle';
import { VEHICLES, vehicleDef } from '../src/vehicles/VehicleData';
import { VehicleHealth, engineRpm, torqueCurve } from '../src/vehicles/Damage';
import { GROUPS } from '../src/physics/groups';
import { WATER_Y } from '../src/world/constants';

beforeAll(async () => {
  await RAPIER.init();
});

function setup(water = false): { ph: Physics; scene: THREE.Scene } {
  const ph = new Physics();
  const scene = new THREE.Scene();
  const y = water ? -12 : 0;
  ph.world.createCollider(RAPIER.ColliderDesc.cuboid(2000, 0.5, 2000).setTranslation(0, y - 0.5, 0).setCollisionGroups(GROUPS.static));
  return { ph, scene };
}

function run(v: Vehicle, ph: Physics, seconds: number, each?: (t: number) => void): void {
  const dt = ph.fixedDt;
  for (let t = 0; t < seconds; t += dt) {
    each?.(t);
    v.fixedUpdate(dt);
    ph.step();
    v.captureTransform();
  }
}

describe('ground vehicle handling', () => {
  const report: string[] = [];
  for (const def of VEHICLES.filter((d) => d.kind === 'car' || d.kind === 'bike')) {
    it(`${def.id} accelerates, brakes, steers, stays upright`, () => {
      const { ph, scene } = setup();
      const v = new Vehicle(def, ph, scene, 0, 0.3, 0, 0, 0xffffff, true, false);
      v.driver = { kind: 'player', ref: null };
      v.role = 'player';
      run(v, ph, 1); // settle
      let t100 = -1;
      run(v, ph, 12, (t) => {
        v.throttle = 1;
        if (t100 < 0 && v.speed > 27.8) t100 = t;
      });
      const top = v.speed;
      const z0 = v.position.z;
      run(v, ph, 6, () => {
        v.throttle = 0;
        v.brake = 1;
      });
      const brakeDist = v.position.z - z0;
      v.brake = 0;
      // turn test at moderate speed
      run(v, ph, 3, () => {
        v.throttle = 0.6;
        v.steer = 0;
      });
      let yawDelta = 0;
      let last = v.yaw;
      run(v, ph, 2, () => {
        v.throttle = 0.5;
        v.steer = 1;
        const y = v.yaw;
        let d = y - last;
        if (d > Math.PI) d -= Math.PI * 2;
        if (d < -Math.PI) d += Math.PI * 2;
        yawDelta += d;
        last = y;
      });
      report.push(`${def.id.padEnd(12)} top ${(top * 3.6).toFixed(0)} km/h  0-100 ${t100 < 0 ? '—' : t100.toFixed(1) + 's'}  brake ${brakeDist.toFixed(0)}m  yawΔ ${yawDelta.toFixed(2)} up ${v.upY.toFixed(2)}`);
      expect(top).toBeGreaterThan(def.kind === 'bike' ? 12 : 12);
      expect(brakeDist).toBeLessThan(140);
      expect(v.upY).toBeGreaterThan(0.6);
      // steering right (+1) must turn clockwise (yaw decreases)
      expect(yawDelta).toBeLessThan(-0.2);
      v.dispose(scene);
    });
  }
  it('prints handling report', () => {
    console.log('\n' + report.join('\n'));
  });
});

describe('boats & helicopter', () => {
  it('boat floats and moves forward', () => {
    const { ph, scene } = setup(true);
    const v = new Vehicle(vehicleDef('marlin'), ph, scene, 0, WATER_Y + 0.2, 0, 0, 0xffffff, true, false);
    v.driver = { kind: 'player', ref: null };
    run(v, ph, 3);
    expect(v.position.y).toBeGreaterThan(WATER_Y - 1.2);
    expect(v.position.y).toBeLessThan(WATER_Y + 1.5);
    run(v, ph, 6, () => (v.throttle = 1));
    expect(v.speed).toBeGreaterThan(10);
    expect(v.upY).toBeGreaterThan(0.8);
    console.log('boat speed', (v.speed * 3.6).toFixed(0), 'km/h y', v.position.y.toFixed(2));
  });
  it('helicopter spools, climbs, hovers', () => {
    const { ph, scene } = setup();
    const v = new Vehicle(vehicleDef('kestrel'), ph, scene, 0, 0.3, 0, 0, 0xffffff, true, false);
    v.driver = { kind: 'player', ref: null };
    run(v, ph, 4, () => (v.lift = 0));
    run(v, ph, 4, () => (v.lift = 1));
    const y1 = v.position.y;
    expect(y1).toBeGreaterThan(5);
    run(v, ph, 4, () => (v.lift = 0));
    const y2 = v.position.y;
    run(v, ph, 2, () => (v.lift = 0));
    expect(Math.abs(v.position.y - y2)).toBeLessThan(3);
    run(v, ph, 4, () => {
      v.lift = 0;
      v.pitchIn = 1;
    });
    expect(v.position.z).toBeGreaterThan(8);
    expect(v.upY).toBeGreaterThan(0.6);
    console.log('heli y', y1.toFixed(1), 'z after pitch', v.position.z.toFixed(1));
  });
});

describe('damage model', () => {
  it('impacts damage, burn, explode', () => {
    const h = new VehicleHealth(1000);
    expect(h.impact(30)).toBe(0);
    h.impact(800);
    expect(h.health).toBeLessThan(1000);
    let boom = false;
    h.onExplode = () => (boom = true);
    h.apply(5000);
    expect(h.state).toBe('burning');
    for (let i = 0; i < 100; i++) h.update(0.1);
    expect(boom).toBe(true);
    expect(h.state).toBe('wrecked');
  });
  it('engine model is sane', () => {
    expect(torqueCurve(0, 50)).toBeGreaterThan(1);
    expect(torqueCurve(50, 50)).toBe(0);
    const r = engineRpm(25, 50, 5, 1);
    expect(r.gear).toBe(3);
    expect(r.rpm).toBeGreaterThan(800);
  });
});
