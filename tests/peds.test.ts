import { describe, expect, it } from 'vitest';
import { perimeterLength, perimeterPoint, perimeterProject } from '../src/peds/PedManager';
import type { Block } from '../src/world/CityGen';

const b: Block = { id: 0, x0: 0, z0: 0, x1: 50, z1: 30, district: 'downtown', y: 0.16 };

describe('ped sidewalk loops', () => {
  it('perimeter length matches inset rectangle', () => {
    expect(perimeterLength(b)).toBeCloseTo(2 * (50 - 3.4) + 2 * (30 - 3.4));
  });
  it('points lie on the loop and wrap around', () => {
    const o = { x: 0, z: 0, dx: 0, dz: 0 };
    const P = perimeterLength(b);
    for (let s = -P; s < P * 2; s += 3.7) {
      perimeterPoint(b, s, o);
      const onX = Math.abs(o.x - 1.7) < 1e-6 || Math.abs(o.x - 48.3) < 1e-6;
      const onZ = Math.abs(o.z - 1.7) < 1e-6 || Math.abs(o.z - 28.3) < 1e-6;
      expect(onX || onZ).toBe(true);
      expect(Math.hypot(o.dx, o.dz)).toBeCloseTo(1);
    }
  });
  it('projection inverts point', () => {
    const o = { x: 0, z: 0, dx: 0, dz: 0 };
    for (const s of [5, 50, 70, 100, 140]) {
      perimeterPoint(b, s, o);
      const s2 = perimeterProject(b, o.x, o.z);
      perimeterPoint(b, s2, o);
      const o2 = { ...o };
      perimeterPoint(b, s, o);
      expect(Math.hypot(o.x - o2.x, o.z - o2.z)).toBeLessThan(0.01);
    }
  });
});
