import * as THREE from 'three';
import type { Vehicle } from './Vehicle';
import type { WorldData } from '../world/CityGen';
import type { RoadGraph } from '../world/Roads';
import { driveToward } from './AIDriver';
import { angleDiff } from '../core/math';
import { rand } from '../core/rng';

export interface TrafficState {
  kind: 'traffic';
  edge: number;
  dir: 1 | -1;
  nextEdge: number;
  nextDir: 1 | -1;
  stuck: number;
  blocked: number;
  panic: number;
  /** Seconds to stay stopped after a fender-bender */
  shock: number;
  speedMul: number;
  reverseT: number;
}

const _p = new THREE.Vector3();

export function edgeNodes(g: RoadGraph, edge: number, dir: 1 | -1): { from: number; to: number } {
  const e = g.edges[edge]!;
  return dir === 1 ? { from: e.a, to: e.b } : { from: e.b, to: e.a };
}

/** Pick the next edge at a node (prefers going straight, avoids U-turns). */
export function chooseNext(g: RoadGraph, edge: number, dir: 1 | -1): { edge: number; dir: 1 | -1 } {
  const e = g.edges[edge]!;
  const node = dir === 1 ? e.b : e.a;
  const n = g.nodes[node]!;
  const hdg = Math.atan2(e.dx * dir, e.dz * dir);
  const opts: { edge: number; dir: 1 | -1; w: number }[] = [];
  for (const eid of n.edges) {
    if (eid === edge) continue;
    const o = g.edges[eid]!;
    const odir: 1 | -1 = o.a === node ? 1 : -1;
    const oh = Math.atan2(o.dx * odir, o.dz * odir);
    const turn = Math.abs(angleDiff(hdg, oh));
    const w = turn < 0.5 ? 3 : turn < 2.2 ? 1.2 : 0.2;
    opts.push({ edge: eid, dir: odir, w: w * (o.kind === 'highway' ? 1.5 : 1) });
  }
  if (!opts.length) return { edge, dir: dir === 1 ? -1 : 1 };
  return rand.weighted(opts, opts.map((o) => o.w));
}

export function makeTrafficState(g: RoadGraph, edge: number, dir: 1 | -1): TrafficState {
  const nx = chooseNext(g, edge, dir);
  return { kind: 'traffic', edge, dir, nextEdge: nx.edge, nextDir: nx.dir, stuck: 0, blocked: 0, panic: 0, shock: 0, speedMul: 0.85 + rand.next() * 0.3, reverseT: 0 };
}

export interface TrafficContext {
  data: WorldData;
  time: number;
  /** Distance to the nearest obstacle in the vehicle's lane ahead (vehicles, player, peds). */
  obstacleAhead: (v: Vehicle, range: number) => number;
}

/** One fixed step of lane-following for a traffic vehicle. */
export function stepTraffic(v: Vehicle, s: TrafficState, ctx: TrafficContext, dt: number): void {
  const g = ctx.data.graph;
  const e = g.edges[s.edge]!;
  const { from, to } = edgeNodes(g, s.edge, s.dir);
  const a = g.nodes[from]!, b = g.nodes[to]!;
  const p = v.position;
  // progress along edge (0 at from, L at to)
  const along = (p.x - a.x) * e.dx * s.dir + (p.z - a.z) * e.dz * s.dir;
  const remaining = e.length - along;
  let nodeR = 0;
  for (const eid of b.edges) nodeR = Math.max(nodeR, g.edges[eid]!.width / 2);
  if (b.edges.length < 3) nodeR = 0;

  // advance to the next edge once we pass into the junction
  if (remaining < nodeR * 0.6 + 0.5) {
    s.edge = s.nextEdge;
    s.dir = s.nextDir;
    const nx = chooseNext(g, s.edge, s.dir);
    s.nextEdge = nx.edge;
    s.nextDir = nx.dir;
    v.indicator = 0;
    return;
  }

  // lookahead target
  const speed = Math.max(0, v.speed);
  const look = 7 + speed * 0.55;
  let tx: number, tz: number;
  if (along + look < e.length - nodeR * 0.5) {
    const t = (along + look) / e.length;
    const lp = ctx.data.lanePoint(s.edge, s.dir === 1 ? t : 1 - t, s.dir);
    tx = lp.x; tz = lp.z;
  } else {
    const ne = g.edges[s.nextEdge]!;
    const over = Math.min(ne.length * 0.5, along + look - e.length + nodeR * 0.5 + 2);
    const t = over / ne.length;
    const lp = ctx.data.lanePoint(s.nextEdge, s.nextDir === 1 ? t : 1 - t, s.nextDir);
    tx = lp.x; tz = lp.z;
    // indicators when about to turn
    const h0 = Math.atan2(e.dx * s.dir, e.dz * s.dir), h1 = Math.atan2(ne.dx * s.nextDir, ne.dz * s.nextDir);
    const turn = angleDiff(h0, h1);
    v.indicator = Math.abs(turn) < 0.4 ? 0 : turn > 0 ? -1 : 1;
  }

  // target speed
  let target = e.speed * s.speedMul;
  if (s.panic > 0) {
    s.panic -= dt;
    target = e.speed * 1.6;
  }
  // traffic light / junction
  if (s.panic <= 0 && b.light && remaining < 45) {
    const col = g.lightFor(to, e, ctx.time);
    const stopDist = remaining - nodeR - 2.5;
    if ((col === 'red' || (col === 'yellow' && stopDist > 9)) && stopDist > -1) {
      target = Math.min(target, Math.max(0, stopDist * 0.55));
      if (stopDist < 1.2) target = 0;
    }
  } else if (b.edges.length >= 3 && remaining < 20 && !b.light) {
    target = Math.min(target, 7);
  }
  // car following
  const ob = ctx.obstacleAhead(v, 32);
  if (ob < 32) {
    const safe = s.panic > 0 ? 4 : 7.5;
    target = Math.min(target, Math.max(0, (ob - safe) * 0.7));
    if (ob < safe + 1 && speed < 1.5) s.blocked += dt;
    else s.blocked = Math.max(0, s.blocked - dt);
  } else s.blocked = 0;
  if (s.shock > 0) {
    s.shock -= dt;
    target = 0;
  }
  // stuck recovery
  if (speed < 0.6 && target > 3) s.stuck += dt;
  else s.stuck = Math.max(0, s.stuck - dt * 2);
  if (s.stuck > 6 && s.reverseT <= 0) {
    s.reverseT = 2.2;
    s.stuck = 0;
  }
  if (s.reverseT > 0) {
    s.reverseT -= dt;
    v.throttle = 0;
    v.brake = 0.7;
    v.steer = -v.steer;
    return;
  }
  // honk when blocked for a while
  if (s.blocked > 2.2 && v.hornT <= 0) {
    v.hornT = 0.6 + rand.next() * 0.8;
    s.blocked = 0;
  }
  driveToward(v, tx, tz, target, { aggressive: s.panic > 0 });
  void _p;
}
