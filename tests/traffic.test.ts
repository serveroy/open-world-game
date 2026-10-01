import { describe, expect, it, beforeAll } from 'vitest';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Physics } from '../src/physics/Physics';
import { Vehicle } from '../src/vehicles/Vehicle';
import { vehicleDef } from '../src/vehicles/VehicleData';
import { WorldData } from '../src/world/CityGen';
import { makeTrafficState, stepTraffic, edgeNodes, type TrafficState } from '../src/vehicles/TrafficAI';
import { lightColor, LIGHT_CYCLE } from '../src/world/Roads';
import { GROUPS } from '../src/physics/groups';

let wd: WorldData;
beforeAll(async () => {
  await RAPIER.init();
  wd = new WorldData(1337);
});

function setup(): { ph: Physics; scene: THREE.Scene } {
  const ph = new Physics();
  ph.world.createCollider(RAPIER.ColliderDesc.cuboid(3000, 0.5, 3000).setTranslation(0, -0.5, 0).setCollisionGroups(GROUPS.static));
  return { ph, scene: new THREE.Scene() };
}

describe('traffic AI', () => {
  it('stops at a red light and goes on green', () => {
    const g = wd.graph;
    // find a north-south city edge ending in a lit junction
    const e = g.edges.find((ed) => ed.kind === 'city' && Math.abs(ed.dz) > 0.9 && g.nodes[ed.b]!.light && ed.length > 80)!;
    const { ph, scene } = setup();
    const dir: 1 | -1 = 1;
    const lp = wd.lanePoint(e.id, 0.45, dir);
    const v = new Vehicle(vehicleDef('meridian'), ph, scene, lp.x, 0.3, lp.z, lp.yaw, 0xffffff, true, false);
    v.driver = { kind: 'ped', ref: null };
    v.engineOn = true;
    const st: TrafficState = makeTrafficState(g, e.id, dir);
    const node = g.nodes[edgeNodes(g, e.id, dir).to]!;
    // choose a time where NS is red for a long time: start of EW green
    let time = 0;
    while (lightColor((time + node.phase) % LIGHT_CYCLE, true) !== 'red' || lightColor((time + node.phase + 8) % LIGHT_CYCLE, true) !== 'red') time += 0.25;
    const ctx = { data: wd, time, obstacleAhead: () => 99 };
    let minDist = Infinity;
    for (let i = 0; i < 60 * 14; i++) {
      // keep the light frozen on red
      stepTraffic(v, st, ctx, 1 / 60);
      v.fixedUpdate(1 / 60);
      ph.step();
      v.captureTransform();
      minDist = Math.min(minDist, Math.hypot(v.position.x - node.x, v.position.z - node.z));
    }
    expect(Math.abs(v.speed)).toBeLessThan(1.5);
    expect(minDist).toBeGreaterThan(4);
    // now find green
    while (lightColor((ctx.time + node.phase) % LIGHT_CYCLE, true) !== 'green') ctx.time += 0.25;
    const e0 = st.edge;
    for (let i = 0; i < 60 * 10; i++) {
      stepTraffic(v, st, ctx, 1 / 60);
      v.fixedUpdate(1 / 60);
      ph.step();
      v.captureTransform();
    }
    expect(st.edge).not.toBe(e0);
    expect(v.upY).toBeGreaterThan(0.9);
  });

  it('follows lanes through several junctions without leaving the road', () => {
    const g = wd.graph;
    const e = g.edges.find((ed) => ed.kind === 'city' && ed.length > 80)!;
    const { ph, scene } = setup();
    const lp = wd.lanePoint(e.id, 0.2, 1);
    const v = new Vehicle(vehicleDef('pico'), ph, scene, lp.x, 0.3, lp.z, lp.yaw, 0xffffff, true, false);
    v.driver = { kind: 'ped', ref: null };
    v.engineOn = true;
    const st = makeTrafficState(g, e.id, 1);
    const ctx = { data: wd, time: 0, obstacleAhead: () => 99 };
    let edges = 0;
    let last = st.edge;
    let maxOff = 0;
    for (let i = 0; i < 60 * 40; i++) {
      ctx.time += 1 / 60;
      stepTraffic(v, st, ctx, 1 / 60);
      v.fixedUpdate(1 / 60);
      ph.step();
      v.captureTransform();
      if (st.edge !== last) {
        edges++;
        last = st.edge;
      }
      const near = g.nearestEdge(v.position.x, v.position.z, 50);
      if (near && i > 120) maxOff = Math.max(maxOff, near.d);
    }
    expect(edges).toBeGreaterThan(2);
    expect(maxOff).toBeLessThan(9);
  });
});
