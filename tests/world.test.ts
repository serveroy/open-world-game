import { describe, expect, it } from 'vitest';
import { WorldData } from '../src/world/CityGen';
import { buildRoadGraph, lightColor, LIGHT_CYCLE } from '../src/world/Roads';
import { districtAt, LANDMARKS, isSea } from '../src/world/MapData';
import { Terrain } from '../src/world/Terrain';

describe('road graph', () => {
  const g = buildRoadGraph();
  it('is connected', () => {
    const seen = new Set<number>([0]);
    const stack = [0];
    while (stack.length) {
      const n = stack.pop()!;
      for (const e of g.nodes[n]!.edges) {
        const o = g.other(g.edges[e]!, n);
        if (!seen.has(o)) {
          seen.add(o);
          stack.push(o);
        }
      }
    }
    expect(seen.size).toBe(g.nodes.length);
  });
  it('routes from docks to Dustwater', () => {
    const r = g.route(-650, -900, 1180, 340);
    expect(r.length).toBeGreaterThan(5);
    const last = r[r.length - 1]!;
    expect(last[0]).toBe(1180);
  });
  it('traffic lights alternate axes', () => {
    for (let t = 0; t < LIGHT_CYCLE; t += 0.5) {
      const ns = lightColor(t, true), ew = lightColor(t, false);
      expect(ns === 'green' && ew === 'green').toBe(false);
    }
  });
});

describe('world data', () => {
  const t0 = performance.now();
  const w = new WorldData(1337);
  const ms = performance.now() - t0;
  it('generates content quickly', () => {
    expect(w.buildings.length).toBeGreaterThan(400);
    expect(w.props.length).toBeGreaterThan(2000);
    expect(w.parking.length).toBeGreaterThan(100);
    expect(ms).toBeLessThan(3000);
  });
  it('is deterministic', () => {
    const w2 = new WorldData(1337);
    expect(w2.buildings.length).toBe(w.buildings.length);
    expect(w2.buildings[100]!.h).toBe(w.buildings[100]!.h);
  });
  it('places every landmark building', () => {
    for (const l of LANDMARKS) expect(w.buildings.some((b) => b.landmark === l.id), l.id).toBe(true);
  });
  it('keeps buildings off road corridors', () => {
    const g = w.graph;
    let bad = 0;
    for (const b of w.buildings) {
      for (const e of g.edges) {
        const a = g.nodes[e.a]!, c = g.nodes[e.b]!;
        // sample along edge
        for (let s = 0; s <= 1; s += 0.05) {
          const x = a.x + (c.x - a.x) * s, z = a.z + (c.z - a.z) * s;
          const dx = Math.max(0, Math.abs(x - b.x) - b.hx), dz = Math.max(0, Math.abs(z - b.z) - b.hz);
          if (Math.hypot(dx, dz) < e.width / 2) {
            bad++;
            break;
          }
        }
      }
    }
    expect(bad).toBe(0);
  });
  it('landmark doors are on land', () => {
    for (const l of LANDMARKS) expect(isSea(l.x, l.z), l.id).toBe(false);
  });
  it('districts resolve', () => {
    expect(districtAt(-260, 0)).toBe('downtown');
    expect(districtAt(-1500, 0)).toBe('sea');
    expect(districtAt(1180, 330)).toBe('dustwater');
  });
  it('terrain is flat in the city and dry at landmarks', () => {
    const t = new Terrain(1337);
    expect(t.heightAt(-260, 0)).toBe(0);
    expect(t.heightAt(-1500, 0)).toBeLessThan(-5);
    for (const l of LANDMARKS) expect(t.heightAt(l.x, l.z), l.id).toBeGreaterThan(-0.9);
  });
});
