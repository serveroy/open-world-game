/** Pure logic shared by side activities (unit-tested). */
import { hash2 } from '../core/rng';

/** Resample a polyline so consecutive points are at most `step` apart. */
export function densify(route: [number, number][], step: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < route.length; i++) {
    const a = route[i]!;
    if (i === 0) {
      out.push([a[0], a[1]]);
      continue;
    }
    const p = route[i - 1]!;
    const d = Math.hypot(a[0] - p[0], a[1] - p[1]);
    if (d < 0.5) continue;
    const n = Math.ceil(d / step);
    for (let k = 1; k <= n; k++) out.push([p[0] + ((a[0] - p[0]) * k) / n, p[1] + ((a[1] - p[1]) * k) / n]);
  }
  return out;
}

/** Pick checkpoints roughly every `spacing` metres along a route (always includes the end). */
export function checkpoints(route: [number, number][], spacing: number): [number, number][] {
  const out: [number, number][] = [];
  let acc = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]!, b = route[i]!;
    acc += Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (acc >= spacing) {
      out.push([b[0], b[1]]);
      acc = 0;
    }
  }
  const last = route[route.length - 1]!;
  const tail = out[out.length - 1];
  if (!tail || Math.hypot(tail[0] - last[0], tail[1] - last[1]) > spacing * 0.4) out.push([last[0], last[1]]);
  else out[out.length - 1] = [last[0], last[1]];
  return out;
}

export function routeLength(route: [number, number][]): number {
  let t = 0;
  for (let i = 1; i < route.length; i++) t += Math.hypot(route[i]![0] - route[i - 1]![0], route[i]![1] - route[i - 1]![1]);
  return t;
}

export interface RacerProgress {
  id: string;
  /** Next checkpoint index (== cps.length when finished). */
  cp: number;
  /** Distance to the next checkpoint. */
  dist: number;
  /** Finish order (1-based) once finished, else 0. */
  finished: number;
}

/** Race standings: finished racers by finish order, then by checkpoint, then by distance. */
export function standings(r: RacerProgress[]): RacerProgress[] {
  return [...r].sort((a, b) => {
    if (a.finished && b.finished) return a.finished - b.finished;
    if (a.finished) return -1;
    if (b.finished) return 1;
    if (a.cp !== b.cp) return b.cp - a.cp;
    return a.dist - b.dist;
  });
}

export function racePrize(base: number, place: number): number {
  return place === 1 ? base : place === 2 ? Math.round(base * 0.4) : place === 3 ? Math.round(base * 0.15) : 0;
}

/** Taxi fare: flag fall + distance + speed bonus when beating the meter. */
export function taxiFare(distance: number, timeTaken: number, timeAllowed: number, damage: number): { fare: number; tip: number } {
  const fare = Math.round(12 + distance * 0.055);
  const spare = Math.max(0, timeAllowed - timeTaken) / Math.max(1, timeAllowed);
  const tip = Math.round(fare * spare * 0.8 * Math.max(0, 1 - damage * 2));
  return { fare, tip };
}

export function taxiTimeAllowed(distance: number): number {
  return Math.round(20 + distance / 11);
}

/** Delivery pay per drop (decays with van damage). */
export function deliveryPay(distance: number, healthFraction: number): number {
  return Math.round((60 + distance * 0.08) * (0.4 + 0.6 * Math.max(0, Math.min(1, healthFraction))));
}

/** Theft contract payout: share of the car's value scaled by condition. */
export function contractPay(value: number, healthFraction: number): number {
  return Math.round((value * 0.14 * (0.3 + 0.7 * Math.max(0, Math.min(1, healthFraction)))) / 10) * 10;
}

/** Rhythm scoring for the club dance mini-game: |offset| seconds from the beat. */
export function judgeBeat(offset: number): 'perfect' | 'good' | 'miss' {
  const o = Math.abs(offset);
  return o < 0.08 ? 'perfect' : o < 0.18 ? 'good' : 'miss';
}

/** Deterministic, well-spread collectible placement from candidate points (seeded). */
export function pickSpread<T extends { x: number; z: number }>(cands: T[], n: number, minDist: number, seed: number): T[] {
  const order = cands.map((c, i) => ({ c, k: hash2(i + 1, seed) })).sort((a, b) => a.k - b.k);
  const out: T[] = [];
  for (const { c } of order) {
    if (out.length >= n) break;
    if (out.every((o) => Math.hypot(o.x - c.x, o.z - c.z) >= minDist)) out.push(c);
  }
  return out;
}
