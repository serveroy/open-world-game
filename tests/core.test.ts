import { describe, expect, it } from 'vitest';
import { Rng, hash2 } from '../src/core/rng';
import { angleDiff, clamp, formatMoney, wrapAngle, pointSegment2 } from '../src/core/math';
import { Noise2D } from '../src/core/noise';
import { EventBus } from '../src/core/events';
import { Pool } from '../src/core/Pool';
import { SpatialHash } from '../src/core/SpatialHash';

describe('Rng', () => {
  it('is deterministic per seed', () => {
    const a = new Rng(42), b = new Rng(42);
    for (let i = 0; i < 100; i++) expect(a.next()).toBe(b.next());
  });
  it('stays in range', () => {
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const v = r.int(3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });
  it('hash2 is stable', () => {
    expect(hash2(1, 2)).toBe(hash2(1, 2));
    expect(hash2(1, 2)).not.toBe(hash2(2, 1));
  });
});

describe('math', () => {
  it('wraps angles', () => {
    expect(wrapAngle(Math.PI * 2.5)).toBeCloseTo(Math.PI * 0.5);
    expect(angleDiff(0.1, -0.1)).toBeCloseTo(-0.2);
    expect(angleDiff(3, -3)).toBeCloseTo(2 * Math.PI - 6);
  });
  it('clamps and formats', () => {
    expect(clamp(5, 0, 2)).toBe(2);
    expect(formatMoney(1234567)).toBe('$1,234,567');
    expect(formatMoney(-50)).toBe('-$50');
  });
  it('point-segment distance', () => {
    const r = pointSegment2(5, 3, 0, 0, 10, 0);
    expect(r.d).toBeCloseTo(3);
    expect(r.t).toBeCloseTo(0.5);
  });
});

describe('noise', () => {
  it('is deterministic and bounded', () => {
    const n1 = new Noise2D(3), n2 = new Noise2D(3);
    for (let i = 0; i < 200; i++) {
      const v = n1.fbm(i * 0.37, i * 0.11);
      expect(v).toBe(n2.fbm(i * 0.37, i * 0.11));
      expect(Math.abs(v)).toBeLessThanOrEqual(1.01);
    }
  });
});

describe('EventBus/Pool/SpatialHash', () => {
  it('emits typed events', () => {
    const bus = new EventBus<{ hit: number }>();
    let got = 0;
    const off = bus.on('hit', (n) => (got += n));
    bus.emit('hit', 3);
    off();
    bus.emit('hit', 3);
    expect(got).toBe(3);
  });
  it('pools objects', () => {
    let made = 0;
    const p = new Pool(() => ({ id: made++ }));
    const a = p.acquire();
    p.release(a);
    expect(p.acquire()).toBe(a);
    expect(made).toBe(1);
  });
  it('spatial hash queries radius', () => {
    const h = new SpatialHash<{ x: number; z: number }>(10);
    h.insert({ x: 0, z: 0 });
    h.insert({ x: 25, z: 0 });
    let n = 0;
    h.query(1, 1, 5, () => n++);
    expect(n).toBe(1);
  });
});

describe('ecs index', async () => {
  const { registerVehicle, unregisterVehicle, registerPed, unregisterPed, vehiclesQ, sirensQ, pedsQ, syncTags, ecs } = await import('../src/ecs/world');
  it('tracks spawned entities and tag components', () => {
    const v = { siren: false } as unknown as import('../src/vehicles/Vehicle').Vehicle;
    const p = { hostile: true, alive: true } as unknown as import('../src/peds/Ped').Ped;
    registerVehicle(v);
    registerVehicle(v);
    registerPed(p);
    expect(vehiclesQ.entities.length).toBe(1);
    expect(pedsQ.entities.length).toBe(1);
    (v as { siren: boolean }).siren = true;
    syncTags();
    expect(sirensQ.entities.length).toBe(1);
    expect(ecs.with('ped', 'hostile').entities.length).toBe(1);
    unregisterVehicle(v);
    unregisterPed(p);
    expect(vehiclesQ.entities.length + pedsQ.entities.length + sirensQ.entities.length).toBe(0);
  });
});
