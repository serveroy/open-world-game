/**
 * Road network graph built from authored street lines + desert polylines.
 * Pure logic (no three.js): used by traffic AI, GPS/A*, police routing, rendering.
 */
import { CITY_STREETS, DESERT_ROADS, type StreetLine } from './MapData';
import { pointSegment2 } from '../core/math';

export type RoadKind = 'city' | 'highway' | 'rural' | 'town';

export interface RoadNode {
  id: number;
  x: number;
  z: number;
  edges: number[];
  /** Has a traffic light (4-way city junctions). */
  light: boolean;
  /** Phase offset for its light cycle (seconds). */
  phase: number;
}

export interface RoadEdge {
  id: number;
  a: number;
  b: number;
  name: string;
  width: number;
  speed: number;
  kind: RoadKind;
  length: number;
  /** Unit direction a → b */
  dx: number;
  dz: number;
}

export type LightColor = 'green' | 'yellow' | 'red';

export const LANE_OFFSET = 2.6;
export const LIGHT_CYCLE = 22; // seconds for a full NS+EW cycle
const GREEN = 8.5;
const YELLOW = 2.5;

export class RoadGraph {
  readonly nodes: RoadNode[] = [];
  readonly edges: RoadEdge[] = [];
  private grid = new Map<number, number[]>();
  private readonly cell = 60;

  addNode(x: number, z: number, tol = 1.5): number {
    for (const n of this.nodes) if (Math.abs(n.x - x) < tol && Math.abs(n.z - z) < tol) return n.id;
    const id = this.nodes.length;
    this.nodes.push({ id, x, z, edges: [], light: false, phase: 0 });
    return id;
  }

  addEdge(a: number, b: number, name: string, width: number, speed: number, kind: RoadKind): number {
    if (a === b) return -1;
    const na = this.nodes[a]!, nb = this.nodes[b]!;
    for (const e of na.edges) {
      const ed = this.edges[e]!;
      if ((ed.a === a && ed.b === b) || (ed.a === b && ed.b === a)) return e;
    }
    const len = Math.hypot(nb.x - na.x, nb.z - na.z);
    const id = this.edges.length;
    this.edges.push({ id, a, b, name, width, speed, kind, length: len, dx: (nb.x - na.x) / len, dz: (nb.z - na.z) / len });
    na.edges.push(id);
    nb.edges.push(id);
    return id;
  }

  other(edge: RoadEdge, node: number): number {
    return edge.a === node ? edge.b : edge.a;
  }

  /** Build spatial index (call after construction). */
  index(): void {
    this.grid.clear();
    for (const e of this.edges) {
      const a = this.nodes[e.a]!, b = this.nodes[e.b]!;
      const steps = Math.max(1, Math.ceil(e.length / (this.cell * 0.5)));
      const seen = new Set<number>();
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
        for (let ox = -1; ox <= 1; ox++)
          for (let oz = -1; oz <= 1; oz++) {
            const k = this.key(cx + ox, cz + oz);
            if (seen.has(k)) continue;
            seen.add(k);
            let arr = this.grid.get(k);
            if (!arr) this.grid.set(k, (arr = []));
            arr.push(e.id);
          }
      }
    }
  }
  private key(cx: number, cz: number): number {
    return (cx + 1000) * 4096 + (cz + 1000);
  }

  /** Nearest edge to a point (within ~90 m), with distance and param t along a→b. */
  nearestEdge(x: number, z: number, maxDist = 90): { edge: RoadEdge; d: number; t: number } | null {
    const arr = this.grid.get(this.key(Math.floor(x / this.cell), Math.floor(z / this.cell)));
    let best: { edge: RoadEdge; d: number; t: number } | null = null;
    const scan = (ids: Iterable<number>): void => {
      for (const id of ids) {
        const e = this.edges[id]!;
        const a = this.nodes[e.a]!, b = this.nodes[e.b]!;
        const r = pointSegment2(x, z, a.x, a.z, b.x, b.z);
        if (r.d <= maxDist && (!best || r.d < best.d)) best = { edge: e, d: r.d, t: r.t };
      }
    };
    if (arr) scan(arr);
    if (!best && maxDist > this.cell) scan(this.edges.map((e) => e.id));
    return best;
  }

  nearestNode(x: number, z: number): RoadNode {
    let best = this.nodes[0]!, bd = Infinity;
    for (const n of this.nodes) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** A* shortest path between nodes; returns node ids or [] if unreachable. */
  path(from: number, to: number): number[] {
    if (from === to) return [from];
    const n = this.nodes.length;
    const g = new Float64Array(n).fill(Infinity);
    const f = new Float64Array(n).fill(Infinity);
    const came = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const goal = this.nodes[to]!;
    const h = (i: number): number => Math.hypot(this.nodes[i]!.x - goal.x, this.nodes[i]!.z - goal.z);
    const heap = new MinHeap();
    g[from] = 0;
    f[from] = h(from);
    heap.push(from, f[from]!);
    while (heap.size) {
      const cur = heap.pop();
      if (cur === to) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      for (const eid of this.nodes[cur]!.edges) {
        const e = this.edges[eid]!;
        const nb = this.other(e, cur);
        if (closed[nb]) continue;
        // prefer faster roads slightly (cost = time-ish)
        const cost = e.length * (16 / Math.max(8, e.speed));
        const ng = g[cur]! + cost;
        if (ng < g[nb]!) {
          g[nb] = ng;
          came[nb] = cur;
          f[nb] = ng + h(nb) * 0.6;
          heap.push(nb, f[nb]!);
        }
      }
    }
    if (came[to] === -1) return [];
    const out: number[] = [to];
    let c = to;
    while (c !== from) {
      c = came[c]!;
      out.push(c);
    }
    return out.reverse();
  }

  /** Route between arbitrary world points, as polyline [x,z][] including endpoints. */
  route(ax: number, az: number, bx: number, bz: number): [number, number][] {
    const ea = this.nearestEdge(ax, az, 400);
    const eb = this.nearestEdge(bx, bz, 400);
    if (!ea || !eb) return [[ax, az], [bx, bz]];
    const startNodes = [ea.edge.a, ea.edge.b];
    const endNodes = [eb.edge.a, eb.edge.b];
    let best: number[] = [];
    let bestLen = Infinity;
    for (const s of startNodes)
      for (const t of endNodes) {
        const p = this.path(s, t);
        if (!p.length) continue;
        let len = Math.hypot(this.nodes[s]!.x - ax, this.nodes[s]!.z - az) + Math.hypot(this.nodes[t]!.x - bx, this.nodes[t]!.z - bz);
        for (let i = 1; i < p.length; i++) len += Math.hypot(this.nodes[p[i]!]!.x - this.nodes[p[i - 1]!]!.x, this.nodes[p[i]!]!.z - this.nodes[p[i - 1]!]!.z);
        if (len < bestLen) {
          bestLen = len;
          best = p;
        }
      }
    const pts: [number, number][] = [[ax, az]];
    // project start onto its edge
    const pa = project(this, ea.edge, ea.t);
    pts.push(pa);
    for (const id of best) pts.push([this.nodes[id]!.x, this.nodes[id]!.z]);
    pts.push(project(this, eb.edge, eb.t));
    pts.push([bx, bz]);
    return pts;
  }

  /** Traffic light colour for an approach along an edge into a node. */
  lightFor(nodeId: number, edge: RoadEdge, time: number): LightColor {
    const n = this.nodes[nodeId]!;
    if (!n.light) return 'green';
    const ns = Math.abs(edge.dz) > Math.abs(edge.dx);
    return lightColor((time + n.phase) % LIGHT_CYCLE, ns);
  }
}

export function lightColor(t: number, northSouth: boolean): LightColor {
  // [0, G) NS green, [G, G+Y) NS yellow, [G+Y, 2G+Y) EW green, [2G+Y, 2G+2Y) EW yellow
  const half = GREEN + YELLOW;
  const local = northSouth ? t : (t + half) % LIGHT_CYCLE;
  if (local < GREEN) return 'green';
  if (local < half) return 'yellow';
  return 'red';
}

function project(g: RoadGraph, e: RoadEdge, t: number): [number, number] {
  const a = g.nodes[e.a]!, b = g.nodes[e.b]!;
  return [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
}

class MinHeap {
  private ids: number[] = [];
  private keys: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  push(id: number, key: number): void {
    const ids = this.ids, keys = this.keys;
    let i = ids.length;
    ids.push(id);
    keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= key) break;
      ids[i] = ids[p]!;
      keys[i] = keys[p]!;
      i = p;
    }
    ids[i] = id;
    keys[i] = key;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys;
    const top = ids[0]!;
    const lastId = ids.pop()!;
    const lastKey = keys.pop()!;
    if (ids.length) {
      let i = 0;
      const n = ids.length;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        let mk = lastKey;
        if (l < n && keys[l]! < mk) {
          m = l;
          mk = keys[l]!;
        }
        if (r < n && keys[r]! < mk) m = r;
        if (m === i) break;
        ids[i] = ids[m]!;
        keys[i] = keys[m]!;
        i = m;
      }
      ids[i] = lastId;
      keys[i] = lastKey;
    }
    return top;
  }
}

/** Build the full network deterministically. */
export function buildRoadGraph(): RoadGraph {
  const g = new RoadGraph();
  const streets = CITY_STREETS;
  const covers = (s: StreetLine, v: number): boolean => v >= s.from - 0.01 && v <= s.to + 0.01;
  for (const s of streets) {
    const cuts: number[] = [s.from, s.to];
    for (const o of streets) {
      if (o.dir === s.dir) continue;
      if (covers(s, o.at) && covers(o, s.at)) cuts.push(o.at);
    }
    const uniq = Array.from(new Set(cuts.map((c) => Math.round(c * 10) / 10))).sort((a, b) => a - b);
    let prev = -1;
    for (const c of uniq) {
      const id = s.dir === 'v' ? g.addNode(s.at, c) : g.addNode(c, s.at);
      if (prev >= 0) g.addEdge(prev, id, s.name, s.width, s.speed, 'city');
      prev = id;
    }
  }
  for (const r of DESERT_ROADS) {
    const kind: RoadKind = r.name === 'Route 9' ? 'highway' : r.width <= 11 ? 'town' : 'rural';
    let prev = -1;
    for (let i = 0; i < r.points.length; i++) {
      const [x, z] = r.points[i]!;
      if (i > 0) {
        const [px, pz] = r.points[i - 1]!;
        const len = Math.hypot(x - px, z - pz);
        const steps = Math.max(1, Math.round(len / 55));
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const id = g.addNode(px + (x - px) * t, pz + (z - pz) * t, 0.5);
          g.addEdge(prev, id, r.name, r.width, r.speed, kind);
          prev = id;
        }
      }
      const id = g.addNode(x, z, 2);
      if (prev >= 0) g.addEdge(prev, id, r.name, r.width, r.speed, kind);
      prev = id;
    }
  }
  // traffic lights at city junctions with ≥3 edges (not along the beach boulevard ends)
  for (const n of g.nodes) {
    if (n.x <= 275 && n.edges.length >= 3) {
      n.light = n.edges.length >= 4 || Math.abs(n.x - -690) > 1;
      n.phase = ((Math.abs(n.x * 7 + n.z * 13) | 0) % LIGHT_CYCLE);
    }
  }
  g.index();
  return g;
}
