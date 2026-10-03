import { describe, expect, it } from 'vitest';
import { checkpoints, contractPay, deliveryPay, densify, judgeBeat, pickSpread, racePrize, routeLength, standings, taxiFare, taxiTimeAllowed } from '../src/activities/logic';
import { RACES } from '../src/activities/Race';
import { WorldData } from '../src/world/CityGen';
import { shellSpots, SHELL_COUNT } from '../src/activities/Collectibles';
import { isSea } from '../src/world/MapData';

describe('activity logic', () => {
  it('densifies and picks checkpoints along a route', () => {
    const r = densify([[0, 0], [100, 0], [100, 100]], 20);
    expect(r.length).toBeGreaterThanOrEqual(10);
    for (let i = 1; i < r.length; i++) expect(Math.hypot(r[i]![0] - r[i - 1]![0], r[i]![1] - r[i - 1]![1])).toBeLessThanOrEqual(20.001);
    expect(routeLength(r)).toBeCloseTo(200, 3);
    const cps = checkpoints(r, 60);
    expect(cps[cps.length - 1]).toEqual([100, 100]);
    expect(cps.length).toBe(3);
  });

  it('ranks racers: finishers first, then checkpoint, then distance', () => {
    const t = standings([
      { id: 'a', cp: 3, dist: 50, finished: 0 },
      { id: 'b', cp: 3, dist: 10, finished: 0 },
      { id: 'c', cp: 9, dist: 0, finished: 2 },
      { id: 'd', cp: 9, dist: 0, finished: 1 },
      { id: 'e', cp: 5, dist: 80, finished: 0 },
    ]);
    expect(t.map((x) => x.id)).toEqual(['d', 'c', 'e', 'b', 'a']);
    expect(racePrize(1000, 1)).toBe(1000);
    expect(racePrize(1000, 2)).toBe(400);
    expect(racePrize(1000, 4)).toBe(0);
  });

  it('pays fares, deliveries and contracts sensibly', () => {
    const fast = taxiFare(1000, 30, taxiTimeAllowed(1000), 0);
    const slow = taxiFare(1000, 200, taxiTimeAllowed(1000), 0);
    const crashed = taxiFare(1000, 30, taxiTimeAllowed(1000), 0.5);
    expect(fast.fare).toBe(slow.fare);
    expect(fast.tip).toBeGreaterThan(0);
    expect(slow.tip).toBe(0);
    expect(crashed.tip).toBe(0);
    expect(deliveryPay(500, 1)).toBeGreaterThan(deliveryPay(500, 0.3));
    expect(contractPay(45000, 1)).toBeGreaterThan(contractPay(45000, 0.2));
    expect(contractPay(45000, 1) % 10).toBe(0);
  });

  it('judges dance beats', () => {
    expect(judgeBeat(0.02)).toBe('perfect');
    expect(judgeBeat(-0.12)).toBe('good');
    expect(judgeBeat(0.3)).toBe('miss');
  });

  it('spreads picks deterministically', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: (i % 20) * 30, z: Math.floor(i / 20) * 30 }));
    const a = pickSpread(pts, 10, 100, 5), b = pickSpread(pts, 10, 100, 5);
    expect(a).toEqual(b);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(Math.hypot(a[i]!.x - a[j]!.x, a[i]!.z - a[j]!.z)).toBeGreaterThanOrEqual(100);
  });
});

describe('activity data vs world', () => {
  const wd = new WorldData(1337);

  it('race courses route over the road graph and stay on land', () => {
    for (const r of RACES) {
      for (const [x, z] of r.anchors) expect(isSea(x, z), `${r.id} ${x},${z}`).toBe(false);
      if (!r.direct) {
        for (let i = 1; i < r.anchors.length; i++) {
          const seg = wd.graph.route(r.anchors[i - 1]![0], r.anchors[i - 1]![1], r.anchors[i]![0], r.anchors[i]![1]);
          expect(seg.length, r.id).toBeGreaterThan(1);
        }
      }
    }
  });

  it('places 30 Saint Shells on land, spread out', () => {
    const s = shellSpots(wd);
    expect(s.length).toBe(SHELL_COUNT);
    for (const p of s) expect(isSea(p.x, p.z), `${p.x},${p.z}`).toBe(false);
    let minD = Infinity;
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) minD = Math.min(minD, Math.hypot(s[i]!.x - s[j]!.x, s[i]!.z - s[j]!.z));
    expect(minD).toBeGreaterThan(40);
  });
});
