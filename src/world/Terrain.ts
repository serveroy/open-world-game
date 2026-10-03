/**
 * Analytic terrain height function for the whole map + heightfield sampling.
 * Pure (no three.js / rapier) so it is shared by physics, rendering and tests.
 */
import { Noise2D } from '../core/noise';
import { clamp, lerp, smoothstep } from '../core/math';
import { DESERT_ROADS, ISLANDS, MESAS, isQuay, landMetric } from './MapData';
import { WATER_Y, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from './constants';

export const HF_CELL = 4;
export const HF_COLS = (WORLD_MAX_X - WORLD_MIN_X) / HF_CELL; // 800 cells along x
export const HF_ROWS = (WORLD_MAX_Z - WORLD_MIN_Z) / HF_CELL; // 600 cells along z

interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export class Terrain {
  private noise: Noise2D;
  private noise2: Noise2D;
  private segs: Seg[] = [];
  private segGrid = new Map<number, Seg[]>();
  private readonly segCell = 100;
  /** Sampled heights (HF_ROWS+1) x (HF_COLS+1), row-major by z then x. */
  heights: Float32Array | null = null;

  constructor(seed: number) {
    this.noise = new Noise2D(seed);
    this.noise2 = new Noise2D(seed * 7 + 3);
    for (const r of DESERT_ROADS) {
      for (let i = 1; i < r.points.length; i++) {
        const [ax, az] = r.points[i - 1]!;
        const [bx, bz] = r.points[i]!;
        const s = { ax, az, bx, bz };
        this.segs.push(s);
        const minx = Math.min(ax, bx) - 60, maxx = Math.max(ax, bx) + 60;
        const minz = Math.min(az, bz) - 60, maxz = Math.max(az, bz) + 60;
        for (let cx = Math.floor(minx / this.segCell); cx <= Math.floor(maxx / this.segCell); cx++)
          for (let cz = Math.floor(minz / this.segCell); cz <= Math.floor(maxz / this.segCell); cz++) {
            const k = cx * 10000 + cz;
            let arr = this.segGrid.get(k);
            if (!arr) this.segGrid.set(k, (arr = []));
            arr.push(s);
          }
      }
    }
  }

  /** Distance to the nearest desert road centreline (∞ if none within ~60 m). */
  roadDist(x: number, z: number): number {
    const arr = this.segGrid.get(Math.floor(x / this.segCell) * 10000 + Math.floor(z / this.segCell));
    if (!arr) return Infinity;
    let best = Infinity;
    for (const s of arr) {
      const abx = s.bx - s.ax, abz = s.bz - s.az;
      const l2 = abx * abx + abz * abz;
      let t = ((x - s.ax) * abx + (z - s.az) * abz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - (s.ax + abx * t), dz = z - (s.az + abz * t);
      const d = dx * dx + dz * dz;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }

  /** Smooth low-frequency desert base (roads ride on this). */
  desertBase(x: number, z: number): number {
    const ramp = smoothstep(280, 520, x);
    return ramp * (4 + this.noise.fbm(x / 700, z / 700, 3) * 7);
  }

  /** Raw analytic height. */
  heightAt(x: number, z: number): number {
    const m = landMetric(x, z);
    // ---- sea ----
    if (m < 0) {
      if (isQuay(x, z) && m > -30) return -9;
      const t = smoothstep(0, 90, -m);
      return WATER_Y - 0.4 - t * 13 + this.noise.noise(x / 40, z / 40) * 0.6 * t;
    }
    // ---- islands ----
    for (const isl of ISLANDS) {
      const d = Math.hypot(x - isl.x, z - isl.z);
      if (d < isl.r * 1.3) {
        const beach = smoothstep(0, 24, m);
        const hill = smoothstep(isl.r * 0.15, isl.r * 0.85, m) * isl.h * (0.75 + this.noise.fbm(x / 60, z / 60, 3) * 0.4);
        return lerp(WATER_Y - 0.4, 0.4, beach) + hill;
      }
    }
    // ---- mainland ----
    let h: number;
    if (isQuay(x, z)) h = 0;
    else h = lerp(WATER_Y - 0.4, 0, smoothstep(0, 40, m));
    if (x < 280) return h;

    // desert
    const base = this.desertBase(x, z);
    const rd = this.roadDist(x, z);
    const roadMask = 1 - smoothstep(13, 50, rd);
    const townMask = Math.max(
      1 - smoothstep(150, 230, Math.hypot(x - 1185, z - 340)),
      1 - smoothstep(55, 95, Math.hypot(x - 625, z + 100)),
      1 - smoothstep(40, 80, Math.hypot(x - 1390, z + 535)),
    );
    const duneMask = smoothstep(330, 560, x) * (1 - roadMask) * (1 - townMask);
    // ridged dunes
    const n = 1 - Math.abs(this.noise2.noise(x / 160, z / 110));
    const dunes = n * n * 16 * duneMask + this.noise.fbm(x / 45, z / 45, 2) * 1.2 * duneMask;
    h = Math.max(h, base + dunes);
    // mesas (steep plateaus)
    for (const ms of MESAS) {
      const d = Math.hypot(x - ms.x, z - ms.z);
      if (d < ms.r * 1.25) {
        const ang = Math.atan2(z - ms.z, x - ms.x);
        const r = ms.r * (0.9 + Math.sin(ang * 3 + ms.x) * 0.08 + this.noise.noise(x / 25, z / 25) * 0.06);
        const plateau = 1 - smoothstep(r * 0.82, r, d);
        const top = base + ms.h + this.noise.noise(x / 30, z / 30) * 1.5;
        h = Math.max(h, lerp(h, top, plateau));
      }
    }
    // world-edge mountains (east, and desert north/south)
    const edge = Math.max(x - 1420, Math.abs(z) - 1040, 0);
    if (edge > 0) h += Math.pow(edge, 1.25) * 0.55 + this.noise.fbm(x / 80, z / 80, 3) * edge * 0.15;
    return h;
  }

  /** Fill the global heightfield samples (call once at load; ~0.3 s). */
  build(onProgress?: (p: number) => void): Float32Array {
    const cols = HF_COLS + 1, rows = HF_ROWS + 1;
    const hs = new Float32Array(cols * rows);
    for (let r = 0; r < rows; r++) {
      const z = WORLD_MIN_Z + r * HF_CELL;
      for (let c = 0; c < cols; c++) hs[r * cols + c] = this.heightAt(WORLD_MIN_X + c * HF_CELL, z);
      if (onProgress && (r & 63) === 0) onProgress(r / rows);
    }
    this.heights = hs;
    return hs;
  }

  /** Bilinear sample of the built heightfield (matches the physics surface). */
  sample(x: number, z: number): number {
    const hs = this.heights;
    if (!hs) return this.heightAt(x, z);
    const fx = clamp((x - WORLD_MIN_X) / HF_CELL, 0, HF_COLS - 0.0001);
    const fz = clamp((z - WORLD_MIN_Z) / HF_CELL, 0, HF_ROWS - 0.0001);
    const c = Math.floor(fx), r = Math.floor(fz);
    const tx = fx - c, tz = fz - r;
    const cols = HF_COLS + 1;
    const h00 = hs[r * cols + c]!, h10 = hs[r * cols + c + 1]!;
    const h01 = hs[(r + 1) * cols + c]!, h11 = hs[(r + 1) * cols + c + 1]!;
    // match Rapier's triangle split (anti-diagonal 10–01); render meshes use the same split
    if (tx + tz <= 1) return h00 + (h10 - h00) * tx + (h01 - h00) * tz;
    return h11 + (h01 - h11) * (1 - tx) + (h10 - h11) * (1 - tz);
  }

  /**
   * Rapier heightfield data: (nrows+1)*(ncols+1) heights, column-major, where rows run
   * along local Z and columns along local X.
   */
  rapierHeights(): Float32Array {
    const hs = this.heights ?? this.build();
    const cols = HF_COLS + 1, rows = HF_ROWS + 1;
    const out = new Float32Array(cols * rows);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) out[c * rows + r] = hs[r * cols + c]!;
    return out;
  }
}
