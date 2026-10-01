/**
 * Deterministic city content: blocks, buildings, props, parking, ped paths, chunks.
 * Pure data (no three.js); rendering & physics adapters consume it per chunk.
 */
import { Rng, hash2 } from '../core/rng';
import { CITY_STREETS, LANDMARKS, districtAt, isSea, type DistrictId, type Landmark, MARINA_BASIN, coastX } from './MapData';
import { buildRoadGraph, type RoadGraph, LANE_OFFSET } from './Roads';
import { Terrain } from './Terrain';
import { CHUNK_SIZE, WORLD_MIN_X, WORLD_MIN_Z, WATER_Y } from './constants';

export type BuildingStyle = 'tower' | 'office' | 'shop' | 'house' | 'shack' | 'warehouse' | 'club' | 'condo' | 'adobe' | 'civic' | 'hut';

export interface Tier {
  hx: number;
  hz: number;
  h: number;
  /** Offset of this tier centre from building centre */
  ox: number;
  oz: number;
}

export interface Building {
  id: number;
  x: number;
  z: number;
  /** Base height (top of sidewalk/terrain). */
  y: number;
  hx: number;
  hz: number;
  h: number;
  tiers: Tier[];
  style: BuildingStyle;
  color: number;
  roof: number;
  /** Window style index 0 = none. */
  windows: number;
  floorH: number;
  seed: number;
  pitched: boolean;
  neon: number | null;
  landmark: string | null;
  district: DistrictId;
}

export type PropType =
  | 'streetlight' | 'palm' | 'tree' | 'bush' | 'hydrant' | 'bench' | 'trashcan' | 'trafficlight' | 'container'
  | 'crane' | 'cactus' | 'rock' | 'fence' | 'billboard' | 'pump' | 'phonebooth' | 'acunit' | 'watertower'
  | 'dumpster' | 'umbrella' | 'lifeguard' | 'pier' | 'canopy' | 'busstop' | 'barrier' | 'deadtree' | 'neonsign' | 'antenna' | 'bollard' | 'mailbox';

export interface Prop {
  type: PropType;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
  /** Colour variant (containers, umbrellas …). */
  c: number;
  /** Optional dims (fences / piers / billboards). */
  w?: number;
  d?: number;
  h?: number;
}

export interface Block {
  id: number;
  /** Outer block bounds (curb line) */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  district: DistrictId;
  /** Sidewalk top height */
  y: number;
}

export interface ParkingSpot {
  x: number;
  z: number;
  yaw: number;
  district: DistrictId;
}

export interface ChunkContent {
  cx: number;
  cz: number;
  buildings: number[];
  props: number[];
  blocks: number[];
  edges: number[];
  nodes: number[];
  parking: number[];
}

export const SIDEWALK_H = 0.16;

export function chunkCoord(x: number, z: number): [number, number] {
  return [Math.floor((x - WORLD_MIN_X) / CHUNK_SIZE), Math.floor((z - WORLD_MIN_Z) / CHUNK_SIZE)];
}
export function chunkKey(cx: number, cz: number): number {
  return cz * 64 + cx;
}
export const CHUNKS_X = 16;
export const CHUNKS_Z = 12;

const PALETTES: Record<string, number[]> = {
  tower: [0x7a8a9a, 0x5a6a7a, 0x9aa8b4, 0x4a5a6a, 0x8a9088, 0x6a7888, 0xb0b8c0],
  office: [0xc8b8a0, 0xa89880, 0x9a9a92, 0xd0c8b8, 0x8a8478, 0xb0a490],
  shop: [0xe0d0b0, 0xc8a080, 0xd8b890, 0xb89878, 0xe8d8c0, 0xa0b0a8],
  house: [0xf0e6d2, 0xe8d0b0, 0xd8e0e8, 0xf0d8c8, 0xc8d8c0, 0xe8e0a8, 0xd0b8a0],
  shack: [0x8a7a68, 0x7a6a5a, 0x9a8a70, 0x6a7078, 0xa08a6a, 0x8a5a4a],
  warehouse: [0x6a7078, 0x7a6a5a, 0x5a6a68, 0x8a8070, 0x704a3a],
  club: [0x2a1a3a, 0x3a1a2a, 0x1a2a3a, 0x4a2a4a, 0x2a2a2a],
  condo: [0xf0f0f0, 0xe0e8f0, 0xf0e8d8, 0xd8e8e8],
  adobe: [0xd8a878, 0xc89868, 0xe0b890, 0xc8a080, 0xb88860],
};
const ROOFS = [0x3a3a3a, 0x4a4040, 0x2a2a30, 0x5a5050];
const PITCHED = [0x8a3a2a, 0x6a4a3a, 0x4a4a52, 0x7a5a3a, 0x3a4a5a];
const NEON = [0xff2a8a, 0x2affea, 0xffe02a, 0xa02aff, 0xff5a2a, 0x2a8aff];

export class WorldData {
  readonly graph: RoadGraph;
  readonly terrain: Terrain;
  readonly blocks: Block[] = [];
  readonly buildings: Building[] = [];
  readonly props: Prop[] = [];
  readonly parking: ParkingSpot[] = [];
  readonly chunks = new Map<number, ChunkContent>();

  constructor(readonly seed: number, terrain?: Terrain) {
    this.terrain = terrain ?? new Terrain(seed);
    this.graph = buildRoadGraph();
    this.generateBlocks();
    this.generateStreetProps();
    this.generateQuayAndBeach();
    this.generateDesert();
    this.generateParking();
    this.assignChunks();
  }

  private chunk(x: number, z: number): ChunkContent {
    const [cx, cz] = chunkCoord(x, z);
    const k = chunkKey(cx, cz);
    let c = this.chunks.get(k);
    if (!c) this.chunks.set(k, (c = { cx, cz, buildings: [], props: [], blocks: [], edges: [], nodes: [], parking: [] }));
    return c;
  }

  ground(x: number, z: number): number {
    return this.terrain.heightAt(x, z);
  }

  // -------------------------------------------------------------------------
  private generateBlocks(): void {
    const hs = CITY_STREETS.filter((s) => s.dir === 'h').sort((a, b) => a.at - b.at);
    const vs = CITY_STREETS.filter((s) => s.dir === 'v');
    const zs = Array.from(new Set(hs.map((h) => h.at))).sort((a, b) => a - b);
    for (let j = 0; j < zs.length - 1; j++) {
      const za = zs[j]!, zb = zs[j + 1]!;
      const spanning = vs.filter((v) => v.from <= za + 0.1 && v.to >= zb - 0.1).sort((a, b) => a.at - b.at);
      for (let i = 0; i < spanning.length - 1; i++) {
        const va = spanning[i]!, vb = spanning[i + 1]!;
        const ha = hs.find((h) => h.at === za)!, hb = hs.find((h) => h.at === zb)!;
        const x0 = va.at + va.width / 2, x1 = vb.at - vb.width / 2;
        const z0 = za + ha.width / 2, z1 = zb - hb.width / 2;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const block: Block = { id: this.blocks.length, x0, z0, x1, z1, district: districtAt(cx, cz), y: SIDEWALK_H };
        this.blocks.push(block);
        this.populateBlock(block);
      }
    }
    // west of Beach Blvd is the waterfront strip (handled separately)
  }

  private addBuilding(b: Omit<Building, 'id'>): Building {
    const full = { ...b, id: this.buildings.length } as Building;
    this.buildings.push(full);
    return full;
  }

  private landmarksIn(b: Block): Landmark[] {
    return LANDMARKS.filter((l) => l.bx > b.x0 && l.bx < b.x1 && l.bz > b.z0 && l.bz < b.z1);
  }

  private populateBlock(b: Block): void {
    const rng = new Rng(hash2(this.seed, b.id * 7919 + 13));
    const inset = 3.2; // sidewalk width
    const ix0 = b.x0 + inset, ix1 = b.x1 - inset, iz0 = b.z0 + inset, iz1 = b.z1 - inset;
    const W = ix1 - ix0, D = iz1 - iz0;
    const lms = this.landmarksIn(b);
    const reserved: { x0: number; z0: number; x1: number; z1: number }[] = [];
    for (const l of lms) {
      reserved.push({ x0: l.bx - l.hx - 4, z0: l.bz - l.hz - 4, x1: l.bx + l.hx + 4, z1: l.bz + l.hz + 4 });
      this.addLandmarkBuilding(l, b);
    }
    const free = (x0: number, z0: number, x1: number, z1: number): boolean =>
      !reserved.some((r) => x0 < r.x1 && x1 > r.x0 && z0 < r.z1 && z1 > r.z0);

    const d = b.district;
    // lot grid per district
    let nx: number, nz: number;
    switch (d) {
      case 'downtown': nx = W > 70 ? 2 : 1; nz = D > 70 ? 2 : 1; break;
      case 'midtown': nx = Math.max(1, Math.round(W / 34)); nz = Math.max(1, Math.round(D / 34)); break;
      case 'velvet': nx = Math.max(1, Math.round(W / 26)); nz = Math.max(1, Math.round(D / 26)); break;
      case 'rustvale': nx = Math.max(2, Math.round(W / 20)); nz = Math.max(2, Math.round(D / 20)); break;
      case 'docks': nx = Math.max(1, Math.round(W / 55)); nz = Math.max(1, Math.round(D / 50)); break;
      case 'heights': nx = Math.max(2, Math.round(W / 26)); nz = 2; break;
      case 'marina': nx = Math.max(1, Math.round(W / 36)); nz = Math.max(1, Math.round(D / 36)); break;
      default: nx = Math.max(1, Math.round(W / 30)); nz = Math.max(1, Math.round(D / 30));
    }
    const lw = W / nx, ld = D / nz;
    const plazaChance = d === 'downtown' ? 0.12 : d === 'midtown' ? 0.08 : d === 'rustvale' ? 0.18 : 0.05;
    const centerDist = Math.hypot((ix0 + ix1) / 2 - -260, (iz0 + iz1) / 2 - 0);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < nz; j++) {
        // suburbs: only perimeter lots facing streets (both rows always face a street when nz = 2)
        const lx0 = ix0 + i * lw, lz0 = iz0 + j * ld;
        const lx1 = lx0 + lw, lz1 = lz0 + ld;
        if (!free(lx0, lz0, lx1, lz1)) continue;
        const cx = (lx0 + lx1) / 2, cz = (lz0 + lz1) / 2;
        if (rng.chance(plazaChance)) {
          this.addLotProps(rng, d, lx0, lz0, lx1, lz1, true);
          continue;
        }
        const seed = rng.int(0, 1 << 30);
        switch (d) {
          case 'downtown': {
            const m = rng.range(2.5, 6);
            const hx = lw / 2 - m, hz = ld / 2 - m;
            const tall = Math.max(0, 1 - centerDist / 420);
            const h = rng.range(26, 50) + tall * rng.range(30, 70);
            const tiers: Tier[] = [{ hx, hz, h: Math.min(h, rng.range(10, 16)), ox: 0, oz: 0 }];
            const shaftH = h;
            const shrink = rng.range(0.7, 0.92);
            tiers.push({ hx: hx * shrink, hz: hz * shrink, h: shaftH, ox: 0, oz: 0 });
            if (h > 60 && rng.chance(0.6)) tiers.push({ hx: hx * shrink * 0.6, hz: hz * shrink * 0.6, h: shaftH + rng.range(6, 16), ox: 0, oz: 0 });
            this.addBuilding({ x: cx, z: cz, y: SIDEWALK_H, hx, hz, h: tiers[tiers.length - 1]!.h, tiers, style: 'tower', color: rng.pick(PALETTES.tower!), roof: rng.pick(ROOFS), windows: rng.pick([1, 2, 3]), floorH: 3.6, seed, pitched: false, neon: rng.chance(0.15) ? rng.pick(NEON) : null, landmark: null, district: d });
            if (rng.chance(0.5)) this.props.push({ type: rng.chance(0.5) ? 'antenna' : 'acunit', x: cx + rng.range(-hx, hx) * 0.4 * shrink, y: SIDEWALK_H + tiers[tiers.length - 1]!.h, z: cz + rng.range(-hz, hz) * 0.4 * shrink, yaw: 0, s: rng.range(1, 2), c: 0 });
            break;
          }
          case 'midtown':
          case 'marina':
          case 'velvet': {
            const m = rng.range(1.5, 4);
            const hx = lw / 2 - m, hz = ld / 2 - m;
            const h = d === 'velvet' ? rng.range(7, 20) : d === 'marina' ? rng.range(10, 24) : rng.range(8, 30);
            const style: BuildingStyle = d === 'velvet' ? (rng.chance(0.5) ? 'club' : 'shop') : d === 'marina' ? 'condo' : rng.chance(0.5) ? 'office' : 'shop';
            const pal = style === 'club' ? PALETTES.club! : style === 'condo' ? PALETTES.condo! : style === 'office' ? PALETTES.office! : PALETTES.shop!;
            this.addBuilding({ x: cx, z: cz, y: SIDEWALK_H, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style, color: rng.pick(pal), roof: rng.pick(ROOFS), windows: style === 'club' ? 4 : rng.pick([1, 2, 3]), floorH: 3.4, seed, pitched: false, neon: d === 'velvet' || rng.chance(0.15) ? rng.pick(NEON) : null, landmark: null, district: d });
            if (rng.chance(0.4)) this.props.push({ type: rng.chance(0.3) ? 'watertower' : 'acunit', x: cx, y: SIDEWALK_H + h, z: cz, yaw: rng.range(0, 6), s: 1, c: 0 });
            break;
          }
          case 'rustvale': {
            if (rng.chance(0.15)) {
              this.addLotProps(rng, d, lx0, lz0, lx1, lz1, true);
              continue;
            }
            const m = rng.range(1, 3.5);
            const hx = Math.max(3, lw / 2 - m), hz = Math.max(3, ld / 2 - m);
            const h = rng.range(3.5, 9);
            this.addBuilding({ x: cx, z: cz, y: SIDEWALK_H, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style: 'shack', color: rng.pick(PALETTES.shack!), roof: rng.pick(ROOFS), windows: 5, floorH: 3, seed, pitched: rng.chance(0.35), neon: null, landmark: null, district: d });
            break;
          }
          case 'docks': {
            const m = rng.range(4, 8);
            const hx = lw / 2 - m, hz = ld / 2 - m;
            const h = rng.range(8, 15);
            this.addBuilding({ x: cx, z: cz, y: SIDEWALK_H, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style: 'warehouse', color: rng.pick(PALETTES.warehouse!), roof: rng.pick(ROOFS), windows: 6, floorH: 5, seed, pitched: false, neon: null, landmark: null, district: d });
            break;
          }
          case 'heights': {
            const hx = Math.min(8, lw / 2 - 4), hz = Math.min(7, ld / 2 - 5);
            // set back from the street side (j = 0 faces north street, j = 1 faces south street)
            const oz = j === 0 ? -(ld / 2 - hz - 6) : ld / 2 - hz - 6;
            const h = rng.range(4.5, 7);
            this.addBuilding({ x: cx, z: cz + oz, y: SIDEWALK_H, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style: 'house', color: rng.pick(PALETTES.house!), roof: rng.pick(PITCHED), windows: 7, floorH: 3, seed, pitched: true, neon: null, landmark: null, district: d });
            this.addLotProps(rng, d, lx0, lz0, lx1, lz1, false);
            break;
          }
          default: {
            const m = 3;
            const hx = lw / 2 - m, hz = ld / 2 - m;
            const h = rng.range(5, 12);
            this.addBuilding({ x: cx, z: cz, y: SIDEWALK_H, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style: 'shop', color: rng.pick(PALETTES.shop!), roof: rng.pick(ROOFS), windows: 1, floorH: 3.4, seed, pitched: false, neon: null, landmark: null, district: d });
          }
        }
      }
  }

  private addLandmarkBuilding(l: Landmark, b: Block): void {
    const style: BuildingStyle = l.kind === 'club' ? 'club' : l.kind === 'police' || l.kind === 'hospital' || l.kind === 'bank' ? 'civic' : l.kind === 'helipad' ? 'tower' : l.kind === 'safehouse' ? 'house' : 'shop';
    const tiers: Tier[] = [{ hx: l.hx, hz: l.hz, h: l.height, ox: 0, oz: 0 }];
    if (l.kind === 'hospital') tiers.push({ hx: l.hx * 0.5, hz: l.hz * 0.8, h: l.height + 8, ox: -l.hx * 0.3, oz: 0 });
    if (l.kind === 'police') tiers.push({ hx: l.hx * 0.3, hz: l.hz * 0.4, h: l.height + 10, ox: l.hx * 0.5, oz: 0 });
    const neon = l.kind === 'club' ? 0xff2a8a : l.kind === 'gunshop' ? 0xff5a2a : l.kind === 'barber' ? 0x2affea : l.kind === 'tattoo' ? 0xa02aff : l.kind === 'modshop' ? 0x2a8aff : l.kind === 'business' ? 0xffe02a : null;
    this.addBuilding({
      x: l.bx, z: l.bz, y: b.y, hx: l.hx, hz: l.hz, h: tiers[tiers.length - 1]!.h, tiers, style,
      color: l.color ?? 0xcccccc, roof: 0x3a3a3a, windows: l.kind === 'safehouse' ? 7 : l.kind === 'club' ? 4 : 2, floorH: 3.6,
      seed: hash2(l.bx | 0, l.bz | 0), pitched: l.kind === 'safehouse' && l.height < 8, neon, landmark: l.id, district: b.district,
    });
  }

  private addLotProps(rng: Rng, d: DistrictId, x0: number, z0: number, x1: number, z1: number, empty: boolean): void {
    const y = SIDEWALK_H;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    if (d === 'heights') {
      // yard trees, bushes, mailbox & low fence at the back
      for (let k = 0; k < 2; k++) this.props.push({ type: rng.chance(0.5) ? 'tree' : 'palm', x: rng.range(x0 + 3, x1 - 3), y, z: rng.range(z0 + 3, z1 - 3), yaw: rng.range(0, 6), s: rng.range(0.8, 1.3), c: 0 });
      this.props.push({ type: 'bush', x: rng.range(x0 + 2, x1 - 2), y, z: rng.range(z0 + 2, z1 - 2), yaw: 0, s: rng.range(0.8, 1.4), c: 0 });
      return;
    }
    if (empty) {
      if (d === 'rustvale') {
        this.props.push({ type: 'fence', x: cx, y, z: z0 + 1, yaw: 0, s: 1, c: 0, w: x1 - x0 - 2, h: 2.2 });
        this.props.push({ type: 'dumpster', x: rng.range(x0 + 3, x1 - 3), y, z: rng.range(z0 + 3, z1 - 3), yaw: rng.range(0, 6), s: 1, c: rng.int(0, 2) });
        if (rng.chance(0.6)) this.props.push({ type: 'deadtree', x: cx, y, z: cz, yaw: rng.range(0, 6), s: rng.range(0.8, 1.2), c: 0 });
      } else {
        // plaza: trees + benches
        for (let k = 0; k < 4; k++) this.props.push({ type: d === 'velvet' || d === 'marina' ? 'palm' : 'tree', x: rng.range(x0 + 4, x1 - 4), y, z: rng.range(z0 + 4, z1 - 4), yaw: rng.range(0, 6), s: rng.range(0.9, 1.3), c: 0 });
        for (let k = 0; k < 3; k++) this.props.push({ type: 'bench', x: rng.range(x0 + 4, x1 - 4), y, z: rng.range(z0 + 4, z1 - 4), yaw: rng.pick([0, Math.PI / 2, Math.PI, -Math.PI / 2]), s: 1, c: 0 });
      }
    }
  }

  // -------------------------------------------------------------------------
  private generateStreetProps(): void {
    const g = this.graph;
    const rng = new Rng(hash2(this.seed, 99));
    // street lights + trees along block perimeters (curb side)
    for (const b of this.blocks) {
      const d = b.district;
      const y = b.y;
      const step = d === 'heights' ? 34 : d === 'downtown' ? 26 : 30;
      const edges: [number, number, number, number, number][] = [
        [b.x0, b.z0, b.x1, b.z0, Math.PI], // north curb, light faces north (-Z)
        [b.x1, b.z0, b.x1, b.z1, Math.PI / 2],
        [b.x1, b.z1, b.x0, b.z1, 0],
        [b.x0, b.z1, b.x0, b.z0, -Math.PI / 2],
      ];
      for (const [ax, az, bx, bz, yaw] of edges) {
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.floor(len / step));
        const nx = Math.sin(yaw), nz = Math.cos(yaw); // outward normal (toward road)
        for (let k = 0; k < n; k++) {
          const t = (k + 0.5) / n;
          const x = ax + (bx - ax) * t - nx * 0.8, z = az + (bz - az) * t - nz * 0.8;
          this.props.push({ type: 'streetlight', x, y, z, yaw, s: 1, c: 0 });
          const tt = (k + 1) / n;
          if (k < n - 1) {
            const px = ax + (bx - ax) * tt - nx * 1.2, pz = az + (bz - az) * tt - nz * 1.2;
            if (d === 'velvet' || d === 'marina' || d === 'heights') {
              if (rng.chance(0.7)) this.props.push({ type: 'palm', x: px, y, z: pz, yaw: rng.range(0, 6), s: rng.range(0.9, 1.25), c: 0 });
            } else if (d === 'downtown' || d === 'midtown') {
              const r = rng.next();
              if (r < 0.35) this.props.push({ type: 'tree', x: px, y, z: pz, yaw: rng.range(0, 6), s: rng.range(0.7, 0.9), c: 0 });
              else if (r < 0.5) this.props.push({ type: 'trashcan', x: px, y, z: pz, yaw, s: 1, c: 0 });
              else if (r < 0.6) this.props.push({ type: 'bench', x: px, y, z: pz, yaw, s: 1, c: 0 });
              else if (r < 0.66) this.props.push({ type: 'phonebooth', x: px, y, z: pz, yaw, s: 1, c: 0 });
              else if (r < 0.7) this.props.push({ type: 'busstop', x: px, y, z: pz, yaw: yaw + Math.PI, s: 1, c: 0 });
              else if (r < 0.76) this.props.push({ type: 'mailbox', x: px, y, z: pz, yaw, s: 1, c: 0 });
            } else if (d === 'rustvale' && rng.chance(0.3)) {
              this.props.push({ type: rng.chance(0.5) ? 'trashcan' : 'dumpster', x: px, y, z: pz, yaw, s: 1, c: rng.int(0, 2) });
            }
          }
          if (k === 0 && rng.chance(0.35)) this.props.push({ type: 'hydrant', x: ax + (bx - ax) * 0.1 - nx * 0.6, y, z: az + (bz - az) * 0.1 - nz * 0.6, yaw, s: 1, c: 0 });
        }
      }
    }
    // traffic lights at lit junctions (one pole per corner, facing approaching traffic)
    for (const n of g.nodes) {
      if (!n.light) continue;
      let maxW = 0;
      for (const eid of n.edges) maxW = Math.max(maxW, g.edges[eid]!.width);
      const o = maxW / 2 + 1.2;
      // near-right corner of each approach; arm reaches over the approach lanes.
      // yaw ±π/2 → serves north/south traffic, 0/π → east/west traffic
      for (const [sx, sz, yaw] of [[1, 1, -Math.PI / 2], [-1, -1, Math.PI / 2], [-1, 1, Math.PI], [1, -1, 0]] as const)
        this.props.push({ type: 'trafficlight', x: n.x + sx * o, y: SIDEWALK_H, z: n.z + sz * o, yaw, s: 1, c: n.id });
    }
  }

  private generateQuayAndBeach(): void {
    const rng = new Rng(hash2(this.seed, 1234));
    // Docks quay strip: containers + cranes between Beach Blvd and the quay
    for (let z = -1020; z < -360; z += 16) {
      if (rng.chance(0.25)) continue;
      const x = rng.range(-790, -712);
      const stack = rng.int(1, 3);
      for (let k = 0; k < stack; k++) this.props.push({ type: 'container', x, y: k * 2.6, z, yaw: Math.PI / 2 + (rng.chance(0.2) ? 0.1 : 0), s: 1, c: rng.int(0, 5) });
    }
    for (let z = -980; z < -380; z += 140) this.props.push({ type: 'crane', x: -798, y: 0, z, yaw: -Math.PI / 2, s: 1, c: 0 });
    // Beach (Velvet Row) umbrellas, lifeguard towers, palms
    for (let z = -320; z < 340; z += 22) {
      const cxz = coastX(z);
      if (rng.chance(0.6)) this.props.push({ type: 'umbrella', x: rng.range(cxz + 25, -720), y: this.ground(cxz + 40, z), z: z + rng.range(-6, 6), yaw: 0, s: 1, c: rng.int(0, 4) });
      if (rng.chance(0.4)) {
        const px = rng.range(-718, -704);
        this.props.push({ type: 'palm', x: px, y: this.ground(px, z), z, yaw: rng.range(0, 6), s: rng.range(1, 1.3), c: 0 });
      }
    }
    for (const z of [-220, 40, 280]) {
      const x = coastX(z) + 35;
      this.props.push({ type: 'lifeguard', x, y: this.ground(x, z), z, yaw: -Math.PI / 2, s: 1, c: 0 });
    }
    // Marina piers
    const mb = MARINA_BASIN;
    for (let z = mb.z0 + 30; z < mb.z1 - 10; z += 45) this.props.push({ type: 'pier', x: (mb.x0 + mb.x1) / 2 + 10, y: WATER_Y + 1.1, z, yaw: 0, s: 1, c: 0, w: mb.x1 - mb.x0 - 20, d: 4, h: 0.4 });
    this.props.push({ type: 'pier', x: mb.x1 - 4, y: WATER_Y + 1.1, z: (mb.z0 + mb.z1) / 2, yaw: 0, s: 1, c: 0, w: 8, d: mb.z1 - mb.z0, h: 0.4 });
    // Coral Keys dock + Pelican Isle pier
    this.props.push({ type: 'pier', x: -1105, y: WATER_Y + 1.1, z: -640, yaw: 0, s: 1, c: 0, w: 40, d: 5, h: 0.4 });
    this.props.push({ type: 'pier', x: -1085, y: WATER_Y + 1.1, z: 610, yaw: 0, s: 1, c: 0, w: 40, d: 5, h: 0.4 });
    // island palms
    for (let i = 0; i < 60; i++) {
      const isl = i < 30 ? { x: -1250, z: -650, r: 140 } : { x: -1200, z: 600, r: 110 };
      const a = rng.range(0, Math.PI * 2), r = rng.range(20, isl.r);
      const x = isl.x + Math.cos(a) * r, z = isl.z + Math.sin(a) * r;
      if (isSea(x, z)) continue;
      this.props.push({ type: rng.chance(0.7) ? 'palm' : 'bush', x, y: this.ground(x, z), z, yaw: rng.range(0, 6), s: rng.range(0.9, 1.4), c: 0 });
    }
  }

  private generateDesert(): void {
    const rng = new Rng(hash2(this.seed, 4321));
    const t = this.terrain;
    // scatter cacti / rocks / dead trees away from roads
    for (let i = 0; i < 1400; i++) {
      const x = rng.range(330, 1560), z = rng.range(-1150, 1150);
      if (t.roadDist(x, z) < 14) continue;
      if (Math.hypot(x - 1185, z - 340) < 140) continue;
      const r = rng.next();
      const type: PropType = r < 0.5 ? 'cactus' : r < 0.85 ? 'rock' : 'deadtree';
      this.props.push({ type, x, y: t.heightAt(x, z), z, yaw: rng.range(0, 6), s: rng.range(0.7, 1.6), c: 0 });
    }
    // roadside billboards along Route 9
    const r9: [number, number][] = [[460, 0], [720, -90], [980, 140], [1400, 290]];
    for (const [x, z] of r9) this.props.push({ type: 'billboard', x, y: t.heightAt(x, z), z: z + 22, yaw: 0, s: 1, c: rng.int(0, 3) });
    // gas station forecourts
    for (const g of [{ x: 640, z: -112 }, { x: 1390, z: -550 }]) {
      const y = t.heightAt(g.x, g.z + 22);
      this.props.push({ type: 'canopy', x: g.x, y, z: g.z + 22, yaw: 0, s: 1, c: 0 });
      for (let k = -1; k <= 1; k++) this.props.push({ type: 'pump', x: g.x + k * 6, y, z: g.z + 22, yaw: 0, s: 1, c: 0 });
    }
    // Dustwater: small adobe buildings along streets
    const town: [number, number, number, number][] = [
      // x, z, hx, hz
      [1100, 290, 10, 7], [1160, 285, 9, 7], [1205, 287, 10, 8], [1265, 280, 12, 8], [1310, 275, 9, 7],
      [1150, 340, 8, 7], [1210, 345, 7, 8], [1100, 400, 9, 8], [1160, 440, 9, 7], [1205, 410, 8, 7], [1260, 450, 10, 7],
      [1150, 395, 6, 6], [1255, 335, 8, 8],
    ];
    for (const [x, z, hx, hz] of town) {
      if (LANDMARKS.some((l) => Math.abs(l.bx - x) < l.hx + hx + 2 && Math.abs(l.bz - z) < l.hz + hz + 2)) continue;
      if (t.roadDist(x, z) < Math.max(hx, hz) + 6) continue;
      const y = t.heightAt(x, z);
      const h = rng.range(4, 7.5);
      this.addBuilding({ x, z, y, hx, hz, h, tiers: [{ hx, hz, h, ox: 0, oz: 0 }], style: 'adobe', color: rng.pick(PALETTES.adobe!), roof: 0x8a6a4a, windows: 5, floorH: 3.2, seed: rng.int(0, 1 << 30), pitched: false, neon: rng.chance(0.2) ? rng.pick(NEON) : null, landmark: null, district: 'dustwater' });
    }
    // desert landmarks not inside city blocks
    for (const l of LANDMARKS) {
      if (l.bx < 300 && !(l.kind === 'lighthouse' || l.kind === 'villa' || l.kind === 'boatrental')) continue;
      const y = t.heightAt(l.bx, l.bz);
      const style: BuildingStyle = l.kind === 'lighthouse' ? 'civic' : l.kind === 'villa' ? 'condo' : l.kind === 'boatrental' ? 'hut' : l.bx > 1000 ? 'adobe' : 'shop';
      const tiers: Tier[] = l.kind === 'lighthouse'
        ? [{ hx: 4, hz: 4, h: 22, ox: 0, oz: 0 }, { hx: 2.6, hz: 2.6, h: 27, ox: 0, oz: 0 }]
        : [{ hx: l.hx, hz: l.hz, h: l.height, ox: 0, oz: 0 }];
      this.addBuilding({ x: l.bx, z: l.bz, y, hx: l.hx, hz: l.hz, h: tiers[tiers.length - 1]!.h, tiers, style, color: l.color ?? 0xd8c8a8, roof: 0x5a4a3a, windows: style === 'adobe' ? 5 : 2, floorH: 3.4, seed: hash2(l.bx | 0, l.bz | 0), pitched: false, neon: l.kind === 'gas' ? 0xff3a2a : l.kind === 'diner' ? 0x2affea : l.kind === 'business' ? 0xffe02a : null, landmark: l.id, district: districtAt(l.bx, l.bz) });
    }
  }

  private generateParking(): void {
    const g = this.graph;
    const rng = new Rng(hash2(this.seed, 777));
    for (const e of g.edges) {
      if (e.kind !== 'city' || e.width > 12.5) continue;
      const a = g.nodes[e.a]!;
      const d = districtAt(a.x + e.dx * e.length * 0.5, a.z + e.dz * e.length * 0.5);
      const density = d === 'heights' ? 0.25 : d === 'rustvale' ? 0.3 : d === 'downtown' ? 0.15 : d === 'docks' ? 0.12 : 0.2;
      const off = e.width / 2 - 1.3;
      for (let s = 16; s < e.length - 16; s += 7) {
        for (const side of [1, -1]) {
          if (!rng.chance(density)) continue;
          // right-hand side relative to direction a→b is (-dz, dx)·(-1)… right = (−dz·−1)… use perpendicular
          const px = -e.dz * side, pz = e.dx * side;
          const x = a.x + e.dx * s + px * off, z = a.z + e.dz * s + pz * off;
          const yaw = Math.atan2(e.dx * side, e.dz * side);
          this.parking.push({ x, z, yaw, district: d });
        }
      }
    }
    // landmark lots (police cars at HQ, ambulances at hospital)
  }

  private assignChunks(): void {
    this.buildings.forEach((b, i) => this.chunk(b.x, b.z).buildings.push(i));
    this.props.forEach((p, i) => this.chunk(p.x, p.z).props.push(i));
    this.blocks.forEach((b, i) => this.chunk((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2).blocks.push(i));
    this.parking.forEach((p, i) => this.chunk(p.x, p.z).parking.push(i));
    const g = this.graph;
    g.edges.forEach((e, i) => {
      const a = g.nodes[e.a]!, b = g.nodes[e.b]!;
      this.chunk((a.x + b.x) / 2, (a.z + b.z) / 2).edges.push(i);
    });
    g.nodes.forEach((n, i) => this.chunk(n.x, n.z).nodes.push(i));
    // ensure every chunk exists (terrain everywhere)
    for (let cx = 0; cx < CHUNKS_X; cx++) for (let cz = 0; cz < CHUNKS_Z; cz++) {
      const k = chunkKey(cx, cz);
      if (!this.chunks.has(k)) this.chunks.set(k, { cx, cz, buildings: [], props: [], blocks: [], edges: [], nodes: [], parking: [] });
    }
  }

  /** Lane centre position + heading for traffic on an edge (dir 1 = a→b). */
  lanePoint(edgeId: number, t: number, dir: 1 | -1): { x: number; z: number; yaw: number } {
    const g = this.graph;
    const e = g.edges[edgeId]!;
    const a = g.nodes[e.a]!;
    const dx = e.dx * dir, dz = e.dz * dir;
    // right-hand traffic: right of travel direction = (-dz, dx) rotated… heading h: right = (-cos h, sin h)
    const h = Math.atan2(dx, dz);
    const rx = -Math.cos(h), rz = Math.sin(h);
    const off = e.width > 13 ? LANE_OFFSET + 1 : LANE_OFFSET;
    return { x: a.x + e.dx * e.length * t + rx * off, z: a.z + e.dz * e.length * t + rz * off, yaw: h };
  }
}
