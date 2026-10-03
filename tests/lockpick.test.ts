import { describe, expect, it } from 'vitest';
import { LockpickGame } from '../src/peds/Lockpick';

describe('LockpickGame', () => {
  it('succeeds after hitting all pins', () => {
    const g = new LockpickGame(() => 0.5);
    for (let i = 0; i < 3; i++) {
      // move needle to zone centre
      let guard = 0;
      while (Math.abs(g.needle - g.zoneCenter) > g.zoneWidth / 4 && guard++ < 10000) g.tick(0.001);
      const r = g.press();
      expect(r === 'hit' || r === 'success').toBe(true);
    }
    expect(g.succeeded).toBe(true);
  });
  it('fails after two misses', () => {
    const g = new LockpickGame(() => 0.9);
    g.needle = 0;
    expect(g.press()).toBe('miss');
    expect(g.press()).toBe('fail');
    expect(g.done).toBe(true);
    expect(g.succeeded).toBe(false);
  });
  it('needle bounces between 0 and 1', () => {
    const g = new LockpickGame();
    for (let i = 0; i < 500; i++) {
      g.tick(0.05);
      expect(g.needle).toBeGreaterThanOrEqual(0);
      expect(g.needle).toBeLessThanOrEqual(1);
    }
  });
});
