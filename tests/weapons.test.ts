import { describe, expect, it } from 'vitest';
import { Arsenal, WEAPONS } from '../src/combat/Weapons';

describe('Arsenal', () => {
  it('starts with fists and picks up guns', () => {
    const a = new Arsenal();
    expect(a.current).toBe('fists');
    a.give('pistol', 36);
    expect(a.current).toBe('pistol');
    expect(a.clip.pistol).toBe(12);
    expect(a.ammo.pistol).toBe(24);
  });
  it('fires, empties the magazine, reloads', () => {
    const a = new Arsenal();
    a.give('pistol', 14);
    let fired = 0;
    for (let i = 0; i < 40 && a.current === 'pistol'; i++) {
      if (a.fire() === 'fired') fired++;
      a.tick(0.3);
    }
    expect(fired).toBe(14);
    expect(a.total('pistol')).toBe(0);
    // out of ammo → falls back to fists
    expect(a.current).toBe('fists');
  });
  it('respects fire rate and reload time', () => {
    const a = new Arsenal();
    a.give('rifle', 60);
    expect(a.fire()).toBe('fired');
    expect(a.fire()).toBe('cooldown');
    a.tick(1 / WEAPONS.rifle.rate + 0.001);
    expect(a.fire()).toBe('fired');
    a.startReload();
    expect(a.fire()).toBe('reloading');
    a.tick(WEAPONS.rifle.reload + 0.01);
    expect(a.clip.rifle).toBe(30);
  });
  it('caps ammo at the maximum', () => {
    const a = new Arsenal();
    a.give('shotgun', 9999);
    expect(a.total('shotgun')).toBe(WEAPONS.shotgun.maxAmmo + WEAPONS.shotgun.mag);
  });
  it('throwables count down and switch away when empty', () => {
    const a = new Arsenal();
    a.give('grenade', 2);
    a.select('grenade');
    a.tick(0.3);
    expect(a.fire()).toBe('fired');
    a.tick(1.1);
    expect(a.total('grenade')).toBe(1);
    expect(a.fire()).toBe('fired');
    a.tick(1.1);
    expect(a.total('grenade')).toBe(0);
    expect(a.current).not.toBe('grenade');
  });
  it('cycles only through usable weapons, strips on bust, saves/loads', () => {
    const a = new Arsenal();
    a.give('bat');
    a.give('smg', 60);
    a.select('fists');
    expect(a.cycle(1)).toBe('bat');
    expect(a.cycle(1)).toBe('smg');
    expect(a.cycle(1)).toBe('fists');
    const s = a.save();
    const b = new Arsenal();
    b.load(s);
    expect(b.total('smg')).toBe(60);
    b.strip();
    expect(b.owned.size).toBe(1);
  });
});
