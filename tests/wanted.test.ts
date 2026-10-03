import { describe, expect, it } from 'vitest';
import { WantedSystem } from '../src/police/Wanted';

describe('WantedSystem', () => {
  it('ignores unwitnessed crimes', () => {
    const w = new WantedSystem();
    w.crime('assault', false, false, 0, 0);
    expect(w.stars).toBe(0);
  });
  it('witnessed crimes raise stars; cops force minimums', () => {
    const w = new WantedSystem();
    w.crime('carjack', true, false, 0, 0);
    expect(w.stars).toBe(1);
    w.crime('copMurder', true, true, 0, 0);
    expect(w.stars).toBeGreaterThanOrEqual(3);
  });
  it('stealing a police car is always a crime', () => {
    const w = new WantedSystem();
    w.crime('stealPolice', false, false, 0, 0);
    expect(w.stars).toBe(1);
  });
  it('escalates to 5 stars with enough heat and caps there', () => {
    const w = new WantedSystem();
    for (let i = 0; i < 20; i++) w.crime('copMurder', true, true, 0, 0);
    expect(w.stars).toBe(5);
  });
  it('enters search mode when unseen, flashes, then clears', () => {
    const w = new WantedSystem();
    w.set(2);
    let changes = 0;
    w.onChange = () => changes++;
    w.update(1, true, 0, 0);
    expect(w.searching).toBe(false);
    for (let t = 0; t < 4.5; t += 0.5) w.update(0.5, false, 0, 0);
    expect(w.searching).toBe(true);
    expect(w.flashing).toBe(true);
    // being seen again cancels search
    w.update(0.1, true, 10, 0);
    expect(w.searching).toBe(false);
    // escape far outside the radius → faster loss
    for (let t = 0; t < 30; t += 0.5) w.update(0.5, false, 1000, 1000);
    expect(w.stars).toBe(0);
    expect(changes).toBe(1);
  });
  it('respray only works unseen', () => {
    const w = new WantedSystem();
    w.set(3);
    expect(w.respray(true)).toBe(false);
    expect(w.stars).toBe(3);
    expect(w.respray(false)).toBe(true);
    expect(w.stars).toBe(0);
  });
  it('mission minimum stars cannot be lost', () => {
    const w = new WantedSystem();
    w.minStars = 3;
    w.set(3);
    for (let t = 0; t < 100; t += 1) w.update(1, false, 5000, 5000);
    expect(w.stars).toBe(3);
  });
});
