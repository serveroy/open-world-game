import { describe, expect, it } from 'vitest';
import { Vitals } from '../src/player/Stats';
import { computePose, makeAnimState, makePose, advancePhase, blendPose, POSE_KEYS } from '../src/characters/Pose';
import { migrateSettings, DEFAULT_SETTINGS, Settings } from '../src/core/Settings';

describe('Vitals', () => {
  it('armor absorbs 70% until depleted', () => {
    const v = new Vitals();
    v.armor = 50;
    const lost = v.damage(40);
    expect(v.armor).toBeCloseTo(22);
    expect(lost).toBeCloseTo(12);
    v.damage(1000);
    expect(v.dead).toBe(true);
    expect(v.health).toBe(0);
  });
  it('stamina regenerates after cooldown', () => {
    const v = new Vitals();
    v.useStamina(50);
    v.update(0.5);
    expect(v.stamina).toBe(50);
    v.update(0.6);
    v.update(1);
    expect(v.stamina).toBeGreaterThan(60);
  });
});

describe('Pose', () => {
  it('produces finite values for every state', () => {
    const p = makePose();
    const s = makeAnimState();
    const states: Partial<ReturnType<typeof makeAnimState>>[] = [
      { speed: 0 }, { speed: 1.5 }, { speed: 7 }, { grounded: false, vy: 3 }, { swimming: true, speed: 2 },
      { crouch: 1 }, { aim: 'pistol' }, { aim: 'rifle', aimPitch: 0.5 }, { driving: true, steer: 1 }, { driving: true, bike: true },
      { action: 'punch', actionT: 0.3 }, { action: 'dance' }, { action: 'pullout', actionT: 0.6 }, { action: 'cower' },
    ];
    for (const st of states) {
      Object.assign(s, makeAnimState(), st);
      advancePhase(s, 0.1);
      computePose(p, s);
      for (const k of POSE_KEYS) expect(Number.isFinite(p[k])).toBe(true);
    }
  });
  it('walking swings legs in opposition', () => {
    const p = makePose();
    const s = makeAnimState();
    s.speed = 1.6;
    s.phase = Math.PI / 2;
    computePose(p, s);
    expect(Math.sign(p.lHip)).toBe(-Math.sign(p.rHip));
  });
  it('blends toward target', () => {
    const a = makePose(), b = makePose();
    b.lHip = 1;
    blendPose(a, b, 0.5);
    expect(a.lHip).toBeCloseTo(0.5);
  });
});

describe('Settings', () => {
  it('migrates partial / invalid data onto defaults', () => {
    const s = migrateSettings({ masterVolume: 0.2, quality: 5, hud: { buttonScale: 9 } });
    expect(s.masterVolume).toBe(0.2);
    expect(s.quality).toBe(DEFAULT_SETTINGS.quality);
    expect(s.hud.buttonScale).toBe(1.5);
  });
  it('persists through storage', () => {
    const mem = new Map<string, string>();
    const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const a = new Settings(store);
    a.set('invertY', true);
    const b = new Settings(store);
    expect(b.data.invertY).toBe(true);
  });
});
