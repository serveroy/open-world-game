import { describe, expect, it, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier3d-compat';

beforeAll(async () => {
  await RAPIER.init();
});

describe('rapier heightfield layout', () => {
  it('rows along Z, cols along X, column-major, centred', () => {
    const nrows = 4, ncols = 8; // cells
    const sx = 80, sz = 40; // extents
    const heights = new Float32Array((nrows + 1) * (ncols + 1));
    // h = x index * 1 + z index * 100 (distinguishable)
    for (let c = 0; c <= ncols; c++) for (let r = 0; r <= nrows; r++) heights[c * (nrows + 1) + r] = c * 1 + r * 0.1;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.heightfield(nrows, ncols, heights, { x: sx, y: 1, z: sz }));
    world.step();
    const at = (x: number, z: number): number => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
      return hit ? 50 - hit.timeOfImpact : NaN;
    };
    // corner (-40,-20) → c=0,r=0 → 0 ; (+40,-20) → c=8 → 8 ; (-40, 20) → r=4 → 0.4
    expect(at(-39.99, -19.99)).toBeCloseTo(0, 1);
    expect(at(39.99, -19.99)).toBeCloseTo(8, 1);
    expect(at(-39.99, 19.99)).toBeCloseTo(0.4, 1);
    expect(at(0, 0)).toBeCloseTo(4.2, 1);
  });
});

describe('rapier heightfield triangle split', () => {
  it('diagonal orientation', () => {
    const heights = new Float32Array([0, 0, 0, 4]); // c0r0, c0r1, c1r0, c1r1
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.createCollider(RAPIER.ColliderDesc.heightfield(1, 1, heights, { x: 4, y: 1, z: 4 }));
    world.step();
    const at = (x: number, z: number): number => {
      const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true);
      return hit ? 50 - hit.timeOfImpact : NaN;
    };
    // tx = 0.75, tz = 0.25 → local x = 1, z = -1
    // anti-diagonal split: both points lie in the low triangles
    expect(at(1, -1)).toBeCloseTo(0, 2);
    expect(at(-1, 1)).toBeCloseTo(0, 2);
    expect(at(1.5, 1.5)).toBeGreaterThan(1);
  });
});
