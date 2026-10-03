import * as THREE from 'three';
import { GeoBuilder } from './GeoBuilder';
import type { Building, ChunkContent, WorldData } from './CityGen';
import { CHUNK_SIZE, WATER_Y, WORLD_MIN_X, WORLD_MIN_Z } from './constants';
import { districtAt, isQuay, landMetric, MARINA_BASIN, LANDMARKS, type DistrictId } from './MapData';
import { HF_CELL } from './Terrain';

export interface BoxCollider {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
  kind: 'building' | 'slab' | 'wall' | 'pier' | 'fence';
}

export interface ChunkBuild {
  geometry: THREE.BufferGeometry;
  colliders: BoxCollider[];
}

const GROUND: Partial<Record<DistrictId, number>> = {
  downtown: 0x8a8984, midtown: 0x8c8a80, rustvale: 0x7a6c52, docks: 0x5c5d5f, heights: 0x6a8a48,
  marina: 0x80907a, velvet: 0xb0a088, dustwater: 0xc8a674, desert: 0xd2a66a, coralkeys: 0x6e9048, pelican: 0x6e9048, beach: 0xdcc9a0,
};
const SAND = new THREE.Color(0xdcc9a0);
const WET_SAND = new THREE.Color(0xb8a27a);
const ROCK = new THREE.Color(0x9a6a46);
const ROCK2 = new THREE.Color(0xb88456);
const SEABED = new THREE.Color(0xc2b48a);
const SEABED_DEEP = new THREE.Color(0x6a7a70);
const _c = new THREE.Color();
const _c2 = new THREE.Color();

const ASPHALT = 0x3a3b3e;
const ASPHALT_DESERT = 0x4a4642;
const LINE_W = 0xe8e8e0;
const LINE_Y = 0xe8c040;
const SIDEWALK = 0xa8a49a;
const CURB = 0xc0bcb2;

export function terrainColor(wd: WorldData, x: number, z: number, h: number, slope: number, out: THREE.Color): THREE.Color {
  if (h < WATER_Y - 0.15) {
    const t = Math.min(1, (WATER_Y - h) / 12);
    return out.copy(SEABED).lerp(SEABED_DEEP, t);
  }
  const m = landMetric(x, z);
  const d = districtAt(x, z);
  if (!isQuay(x, z) && m < 38 && x < 300 && d !== 'coralkeys' && d !== 'pelican') {
    return out.copy(h < WATER_Y + 0.25 ? WET_SAND : SAND);
  }
  if (d === 'coralkeys' || d === 'pelican') {
    if (h < 1.2) return out.copy(SAND);
    out.setHex(0x6e9048);
    if (slope > 0.6) out.lerp(ROCK, 0.6);
    return out;
  }
  out.setHex(GROUND[d] ?? 0x8a8a80);
  if (x >= 300) {
    // desert tint variation + rock on steep slopes and mesa tops
    const n = Math.sin(x * 0.013) * Math.cos(z * 0.011) * 0.5 + 0.5;
    out.lerp(_c2.setHex(0xc89858), n * 0.4);
    if (slope > 0.45) out.lerp(ROCK, Math.min(1, (slope - 0.45) * 2.5));
    if (h > 28) out.lerp(ROCK2, Math.min(1, (h - 28) / 10) * 0.7);
    if (wd.terrain.roadDist(x, z) < 11) out.lerp(_c2.setHex(0xb08858), 0.4);
  }
  return out;
}

/** Build one chunk's merged static mesh and its colliders. */
export function buildChunk(wd: WorldData, ch: ChunkContent): ChunkBuild {
  const g = new GeoBuilder();
  const colliders: BoxCollider[] = [];
  const x0 = WORLD_MIN_X + ch.cx * CHUNK_SIZE, z0 = WORLD_MIN_Z + ch.cz * CHUNK_SIZE;
  buildTerrain(wd, g, x0, z0);
  buildRoads(wd, g, ch);
  for (const bi of ch.blocks) buildBlock(wd, g, colliders, bi);
  for (const bi of ch.buildings) buildBuilding(wd, g, colliders, wd.buildings[bi]!);
  buildQuay(g, x0, z0);
  for (const pi of ch.props) {
    const p = wd.props[pi]!;
    if (p.type === 'pier') {
      g.color(0x7a5a3a).params(0);
      g.box(p.x, p.y - (p.h ?? 0.4), p.z, (p.w ?? 10) / 2, p.h ?? 0.4, (p.d ?? 4) / 2, 0x8a6a48, false);
      colliders.push({ x: p.x, y: p.y - (p.h ?? 0.4) / 2, z: p.z, hx: (p.w ?? 10) / 2, hy: (p.h ?? 0.4) / 2, hz: (p.d ?? 4) / 2, yaw: 0, kind: 'pier' });
      // posts
      g.color(0x4a3a2a);
      const w = p.w ?? 10, d = p.d ?? 4;
      for (let s = -w / 2 + 1; s <= w / 2 - 1; s += 6)
        for (const t of [-d / 2 + 0.3, d / 2 - 0.3]) g.box(p.x + s, WATER_Y - 3, p.z + t, 0.18, p.y - WATER_Y + 2.6, 0.18, undefined, false);
      if (d > w) for (let s = -d / 2 + 1; s <= d / 2 - 1; s += 6) for (const t of [-w / 2 + 0.3, w / 2 - 0.3]) g.box(p.x + t, WATER_Y - 3, p.z + s, 0.18, p.y - WATER_Y + 2.6, 0.18, undefined, false);
    } else if (p.type === 'fence') {
      const w = p.w ?? 10, h = p.h ?? 2;
      g.color(0x8a8a8a).params(0);
      g.box(p.x, p.y, p.z, w / 2, h, 0.04, undefined, false);
      colliders.push({ x: p.x, y: p.y + h / 2, z: p.z, hx: w / 2, hy: h / 2, hz: 0.08, yaw: p.yaw, kind: 'fence' });
    }
  }
  return { geometry: g.build(), colliders };
}

function buildTerrain(wd: WorldData, g: GeoBuilder, x0: number, z0: number): void {
  const t = wd.terrain;
  // detect flat chunk (all samples equal) → coarse grid
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) {
      const h = t.sample(x0 + i * 20, z0 + j * 20);
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
  const flat = maxH - minH < 0.001;
  const step = flat ? 50 : HF_CELL;
  const n = CHUNK_SIZE / step;
  const hs = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) hs[j * (n + 1) + i] = t.sample(x0 + i * step, z0 + j * step);
  const cols = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++)
    for (let i = 0; i <= n; i++) {
      const k = j * (n + 1) + i;
      const h = hs[k]!;
      const hx = hs[j * (n + 1) + Math.min(n, i + 1)]! - hs[j * (n + 1) + Math.max(0, i - 1)]!;
      const hz = hs[Math.min(n, j + 1) * (n + 1) + i]! - hs[Math.max(0, j - 1) * (n + 1) + i]!;
      const slope = Math.hypot(hx, hz) / (2 * step);
      terrainColor(wd, x0 + i * step, z0 + j * step, h, slope, _c);
      cols[k * 3] = _c.r; cols[k * 3 + 1] = _c.g; cols[k * 3 + 2] = _c.b;
    }
  g.params(0);
  const put = (i: number, j: number): void => {
    const k = j * (n + 1) + i;
    g.colorRGB(cols[k * 3]!, cols[k * 3 + 1]!, cols[k * 3 + 2]!);
  };
  // triangles with anti-diagonal split (matches physics heightfield): (00,10,01) and (10,11,01)
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const xa = x0 + i * step, xb = xa + step, za = z0 + j * step, zb = za + step;
      const h00 = hs[j * (n + 1) + i]!, h10 = hs[j * (n + 1) + i + 1]!, h01 = hs[(j + 1) * (n + 1) + i]!, h11 = hs[(j + 1) * (n + 1) + i + 1]!;
      // upward winding: (00, 01, 10) and (10, 01, 11)
      put(i, j); vtx(g, xa, h00, za);
      put(i, j + 1); vtx(g, xa, h01, zb);
      put(i + 1, j); vtx(g, xb, h10, za);
      put(i + 1, j); vtx(g, xb, h10, za);
      put(i, j + 1); vtx(g, xa, h01, zb);
      put(i + 1, j + 1); vtx(g, xb, h11, zb);
      fixNormals(g, 6);
    }
}

/** Push a single vertex with current colour/params; normal fixed later. */
function vtx(g: GeoBuilder, x: number, y: number, z: number): void {
  g.pos.push(x, y, z);
  g.nrm.push(0, 1, 0);
  g.col.push(...currentColor(g));
  g.uvm.push(0, 0);
  g.wp.push(0, 0, 0, 0);
}
function currentColor(g: GeoBuilder): [number, number, number] {
  const r = (g as unknown as { r: number }).r, gg = (g as unknown as { g: number }).g, b = (g as unknown as { b: number }).b;
  return [r, gg, b];
}
/** Compute flat normals for the last `count` vertices (triangles). */
function fixNormals(g: GeoBuilder, count: number): void {
  const p = g.pos, nr = g.nrm;
  const start = p.length / 3 - count;
  for (let v = start; v < start + count; v += 3) {
    const ax = p[v * 3]!, ay = p[v * 3 + 1]!, az = p[v * 3 + 2]!;
    const ux = p[v * 3 + 3]! - ax, uy = p[v * 3 + 4]! - ay, uz = p[v * 3 + 5]! - az;
    const wx = p[v * 3 + 6]! - ax, wy = p[v * 3 + 7]! - ay, wz = p[v * 3 + 8]! - az;
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (let k = 0; k < 3; k++) {
      nr[(v + k) * 3] = nx;
      nr[(v + k) * 3 + 1] = ny;
      nr[(v + k) * 3 + 2] = nz;
    }
  }
}

function roadY(wd: WorldData, x: number, z: number, kind: string): number {
  if (kind === 'city') return 0.03;
  return wd.terrain.sample(x, z) + 0.09;
}

function nodeRadius(wd: WorldData, nodeId: number): number {
  const n = wd.graph.nodes[nodeId]!;
  let w = 0;
  for (const e of n.edges) w = Math.max(w, wd.graph.edges[e]!.width);
  return n.edges.length >= 3 ? w / 2 : 0;
}

function buildRoads(wd: WorldData, g: GeoBuilder, ch: ChunkContent): void {
  const gr = wd.graph;
  for (const ei of ch.edges) {
    const e = gr.edges[ei]!;
    const a = gr.nodes[e.a]!, b = gr.nodes[e.b]!;
    const ra = nodeRadius(wd, e.a), rb = nodeRadius(wd, e.b);
    const desert = e.kind !== 'city';
    const segLen = desert ? 8 : e.length;
    const n = Math.max(1, Math.ceil(e.length / segLen));
    g.color(desert ? ASPHALT_DESERT : ASPHALT).params(0);
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const ax = a.x + (b.x - a.x) * t0, az = a.z + (b.z - a.z) * t0;
      const bx = a.x + (b.x - a.x) * t1, bz = a.z + (b.z - a.z) * t1;
      g.strip(ax, az, bx, bz, e.width, roadY(wd, ax, az, e.kind), roadY(wd, bx, bz, e.kind));
    }
    // markings (trim at junctions)
    const L = e.length;
    const s0 = ra + 1.5, s1 = L - rb - 1.5;
    if (s1 <= s0) continue;
    const px = -e.dz, pz = e.dx;
    const mark = (off: number, w: number, dash: number, gap: number, hex: number): void => {
      g.color(hex);
      const stepLen = gap > 0 ? dash + gap : desert ? 8 : s1 - s0;
      for (let s = s0; s < s1; s += stepLen) {
        const se = Math.min(s1, s + (gap > 0 ? dash : stepLen));
        const ax = a.x + e.dx * s + px * off, az = a.z + e.dz * s + pz * off;
        const bx = a.x + e.dx * se + px * off, bz = a.z + e.dz * se + pz * off;
        g.strip(ax, az, bx, bz, w, roadY(wd, ax, az, e.kind) + 0.012, roadY(wd, bx, bz, e.kind) + 0.012);
      }
    };
    if (e.width >= 13.5) {
      mark(0.18, 0.14, 0, 0, LINE_Y);
      mark(-0.18, 0.14, 0, 0, LINE_Y);
    } else mark(0, 0.14, 3, 4, desert ? LINE_W : LINE_Y);
    mark(e.width / 2 - 0.5, 0.14, 0, 0, LINE_W);
    mark(-(e.width / 2 - 0.5), 0.14, 0, 0, LINE_W);
  }
  // junction patches + crosswalks
  for (const ni of ch.nodes) {
    const nd = gr.nodes[ni]!;
    const desert = nd.x > 280;
    let w = 0;
    for (const e of nd.edges) w = Math.max(w, gr.edges[e]!.width);
    const y = desert ? wd.terrain.sample(nd.x, nd.z) + 0.1 : 0.04;
    g.color(desert ? ASPHALT_DESERT : ASPHALT).params(0);
    if (!desert) {
      const r = w / 2;
      g.flat(nd.x - r, nd.z - r, nd.x + r, nd.z + r, y);
      if (nd.light) {
        g.color(LINE_W);
        for (const eid of nd.edges) {
          const e = gr.edges[eid]!;
          const dir = e.a === ni ? 1 : -1;
          const ux = e.dx * dir, uz = e.dz * dir;
          const cx = nd.x + ux * (r + 1.6), cz = nd.z + uz * (r + 1.6);
          const qx = -uz, qz = ux;
          for (let s = -e.width / 2 + 0.8; s < e.width / 2 - 0.5; s += 1.1) {
            const sx = cx + qx * s, sz = cz + qz * s;
            g.strip(sx - ux * 1.3, sz - uz * 1.3, sx + ux * 1.3, sz + uz * 1.3, 0.55, y + 0.012, y + 0.012);
          }
        }
      }
    } else {
      // octagon disc to hide joints
      const r = w / 2 + 0.3;
      for (let k = 0; k < 8; k++) {
        const a0 = (k / 8) * Math.PI * 2, a1 = ((k + 1) / 8) * Math.PI * 2;
        g.tri(nd.x, y, nd.z, nd.x + Math.cos(a1) * r, y, nd.z + Math.sin(a1) * r, nd.x + Math.cos(a0) * r, y, nd.z + Math.sin(a0) * r);
      }
    }
  }
}

function buildBlock(wd: WorldData, g: GeoBuilder, cols: BoxCollider[], bi: number): void {
  const b = wd.blocks[bi]!;
  const y = b.y;
  // curb + sidewalk slab
  g.color(SIDEWALK).params(0);
  g.box((b.x0 + b.x1) / 2, 0, (b.z0 + b.z1) / 2, (b.x1 - b.x0) / 2, y, (b.z1 - b.z0) / 2, SIDEWALK, false);
  // curb edge line (lighter strip around the top perimeter)
  g.color(CURB);
  g.strip(b.x0, b.z0 + 0.15, b.x1, b.z0 + 0.15, 0.3, y + 0.004, y + 0.004);
  g.strip(b.x0, b.z1 - 0.15, b.x1, b.z1 - 0.15, 0.3, y + 0.004, y + 0.004);
  g.strip(b.x0 + 0.15, b.z0, b.x0 + 0.15, b.z1, 0.3, y + 0.004, y + 0.004);
  g.strip(b.x1 - 0.15, b.z0, b.x1 - 0.15, b.z1, 0.3, y + 0.004, y + 0.004);
  const inset = 3.2;
  if (b.district === 'heights' || b.district === 'marina') {
    g.color(b.district === 'heights' ? 0x5f8a40 : 0x6a8a4a);
    g.flat(b.x0 + inset, b.z0 + inset, b.x1 - inset, b.z1 - inset, y + 0.006);
  } else if (b.district === 'rustvale') {
    g.color(0x7a6a50);
    g.flat(b.x0 + inset, b.z0 + inset, b.x1 - inset, b.z1 - inset, y + 0.006);
  } else if (b.district === 'docks') {
    g.color(0x55565a);
    g.flat(b.x0 + inset, b.z0 + inset, b.x1 - inset, b.z1 - inset, y + 0.006);
  }
  cols.push({ x: (b.x0 + b.x1) / 2, y: y / 2 - 0.25, z: (b.z0 + b.z1) / 2, hx: (b.x1 - b.x0) / 2, hy: y / 2 + 0.25, hz: (b.z1 - b.z0) / 2, yaw: 0, kind: 'slab' });
}

function nearestStreetDir(wd: WorldData, b: Building): [number, number] {
  // pick the block side closest to the building → facade normal
  const blk = wd.blocks.find((k) => b.x > k.x0 && b.x < k.x1 && b.z > k.z0 && b.z < k.z1);
  if (!blk) return [0, 1];
  const dN = b.z - b.hz - blk.z0, dS = blk.z1 - (b.z + b.hz), dW = b.x - b.hx - blk.x0, dE = blk.x1 - (b.x + b.hx);
  const m = Math.min(dN, dS, dW, dE);
  if (m === dN) return [0, -1];
  if (m === dS) return [0, 1];
  if (m === dW) return [-1, 0];
  return [1, 0];
}

function buildBuilding(wd: WorldData, g: GeoBuilder, cols: BoxCollider[], b: Building): void {
  const y0 = b.y;
  const lm = b.landmark ? LANDMARKS.find((l) => l.id === b.landmark) : undefined;
  for (let i = 0; i < b.tiers.length; i++) {
    const t = b.tiers[i]!;
    const prevH = i === 0 ? 0 : Math.min(b.tiers[i - 1]!.h, t.h);
    const startH = i === 0 ? 0 : b.tiers[0]!.h > t.h ? 0 : prevH;
    // each tier is a box from startH up to t.h
    const h = t.h - startH;
    if (h <= 0.1) continue;
    const shade = 1 - i * 0.06;
    g.color(b.color, shade).params(b.windows, b.floorH, b.seed + i * 17, 0);
    g.box(b.x + t.ox, y0 + startH, b.z + t.oz, t.hx, h, t.hz, b.roof);
    cols.push({ x: b.x + t.ox, y: y0 + startH + h / 2, z: b.z + t.oz, hx: t.hx, hy: h / 2, hz: t.hz, yaw: 0, kind: 'building' });
    // roof parapet for flat roofs
    if (!b.pitched && t.h > 6) {
      g.color(b.color, 0.8).params(0);
      const py = y0 + t.h;
      g.box(b.x + t.ox, py, b.z + t.oz - t.hz + 0.2, t.hx, 0.7, 0.2, undefined, false);
      g.box(b.x + t.ox, py, b.z + t.oz + t.hz - 0.2, t.hx, 0.7, 0.2, undefined, false);
      g.box(b.x + t.ox - t.hx + 0.2, py, b.z + t.oz, 0.2, 0.7, t.hz, undefined, false);
      g.box(b.x + t.ox + t.hx - 0.2, py, b.z + t.oz, 0.2, 0.7, t.hz, undefined, false);
    }
  }
  if (b.pitched) {
    const top = b.tiers[b.tiers.length - 1]!;
    g.color(b.roof).params(0);
    g.gable(b.x, y0 + top.h, b.z, top.hx, top.hz, Math.min(top.hx, top.hz) * 0.55);
  }
  // facade dressing
  let [fx, fz] = nearestStreetDir(wd, b);
  if (lm) {
    fx = Math.round(Math.sin(lm.yaw));
    fz = Math.round(Math.cos(lm.yaw));
  }
  const base = b.tiers[0]!;
  const faceX = b.x + fx * (base.hx + 0.05), faceZ = b.z + fz * (base.hz + 0.05);
  const along = fx !== 0 ? base.hz : base.hx;
  const sx = fz !== 0 ? 1 : 0, sz = fx !== 0 ? 1 : 0;
  if (b.style === 'shop' || b.style === 'club' || b.style === 'adobe' || lm) {
    // awning
    const aw = Math.min(along * 0.8, 9);
    g.color(lm?.color ?? (b.seed % 2 ? 0x9a2a2a : 0x2a5a8a), 0.9).params(0);
    g.boxYaw(faceX + fx * 0.6, y0 + 2.9, faceZ + fz * 0.6, sx ? aw : 0.6, 0.18, sz ? aw : 0.6, 0);
  }
  if (b.neon !== null) {
    const nw = Math.min(along * 0.7, 7);
    const ny = y0 + Math.min(b.h - 1.2, b.style === 'club' ? 5 : 4.2);
    g.color(b.neon).params(0, 3, 0, 1.4);
    g.boxYaw(faceX + fx * 0.15, ny, faceZ + fz * 0.15, sx ? nw : 0.12, 0.7, sz ? nw : 0.12, 0);
    if (b.style === 'club' || (lm && lm.kind === 'club')) {
      // vertical neon blade
      g.boxYaw(faceX + fx * 0.6 + sx * (nw + 0.5), y0 + 3.5, faceZ + fz * 0.6 + sz * (nw + 0.5), sx ? 0.12 : 0.5, Math.min(b.h - 4, 7), sz ? 0.12 : 0.5, 0);
    }
  }
  if (lm) {
    // door
    g.color(0x1a1612).params(0, 3, 0, lm.kind === 'club' ? 0.25 : 0);
    const dx = fx !== 0 ? faceX + fx * 0.05 : lm.x, dz = fz !== 0 ? faceZ + fz * 0.05 : lm.z;
    g.boxYaw(dx, y0, dz, sx ? 1.2 : 0.1, 2.6, sz ? 1.2 : 0.1, 0);
    if (lm.kind === 'police') {
      g.color(0x2a6aff).params(0, 3, 0, 1.2);
      g.boxYaw(faceX + fx * 0.15, y0 + 6.5, faceZ + fz * 0.15, sx ? 10 : 0.1, 1.0, sz ? 10 : 0.1, 0);
    }
    if (lm.kind === 'hospital') {
      g.color(0xff2a2a).params(0, 3, 0, 1.2);
      g.boxYaw(faceX + fx * 0.15, y0 + 20, faceZ + fz * 0.15, sx ? 1.2 : 0.1, 3.6, sz ? 1.2 : 0.1, 0);
      g.boxYaw(faceX + fx * 0.15, y0 + 21.2, faceZ + fz * 0.15, sx ? 3.6 : 0.1, 1.2, sz ? 3.6 : 0.1, 0);
    }
    if (lm.kind === 'helipad') {
      const top = y0 + b.h;
      g.color(0x3a3a40).params(0);
      g.box(b.x, top, b.z, 9, 0.25, 9, 0x3a3a40, false);
      g.color(0xffd250);
      g.flat(b.x - 4, b.z - 0.5, b.x + 4, b.z + 0.5, top + 0.27);
      g.flat(b.x - 4, b.z - 3, b.x - 3, b.z + 3, top + 0.27);
      g.flat(b.x + 3, b.z - 3, b.x + 4, b.z + 3, top + 0.27);
      cols.push({ x: b.x, y: top + 0.125, z: b.z, hx: 9, hy: 0.125, hz: 9, yaw: 0, kind: 'building' });
    }
    if (lm.kind === 'respray' || lm.kind === 'modshop' || lm.kind === 'warehouse') {
      // garage shutter
      g.color(0x6a6a70).params(0);
      g.boxYaw(faceX + fx * 0.06, y0, faceZ + fz * 0.06, sx ? 3.5 : 0.08, 4, sz ? 3.5 : 0.08, 0);
    }
  }
}

function buildQuay(g: GeoBuilder, x0: number, z0: number): void {
  const x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE;
  g.color(0x6a6a66).params(0);
  // docks quay face at x = -805 for z in [-1100, -340]
  const qx = -805;
  if (qx >= x0 && qx < x1) {
    const za = Math.max(z0, -1110), zb = Math.min(z1, -340);
    if (zb > za) {
      g.quad(qx, -9, za, qx, -9, zb, qx, 0.05, zb, qx, 0.05, za);
      g.color(0xd8c040);
      g.strip(qx + 0.4, za, qx + 0.4, zb, 0.25, 0.06, 0.06);
      g.color(0x6a6a66);
    }
  }
  // marina basin walls
  const mb = MARINA_BASIN;
  const wall = (ax: number, az: number, bx: number, bz: number): void => {
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) return;
    g.quad(ax, -8, az, bx, -8, bz, bx, 0.05, bz, ax, 0.05, az);
  };
  wall(mb.x1, mb.z0, mb.x1, mb.z1); // east face (faces -x)
  wall(mb.x0 - 40, mb.z0, mb.x1, mb.z0);
  wall(mb.x1, mb.z1, mb.x0 - 40, mb.z1);
}
