import { describe, expect, it } from 'vitest';
import { renderPixelRatio, PRESETS } from '../src/render/Renderer';
import { speakerFor } from '../src/audio/Voice';
import { migrateSave } from '../src/core/SaveSystem';
import { defaultPlayerAppearance } from '../src/characters/Appearance';

describe('render resolution', () => {
  it('renders a short, dense phone viewport sharply (not at 1 CSS px)', () => {
    // iPhone in landscape inside an app frame: 572×307 CSS px at 3×
    const low = renderPixelRatio(3, 572, 307, PRESETS.low);
    const med = renderPixelRatio(3, 572, 307, PRESETS.med);
    expect(low.pr).toBeGreaterThan(1.6);
    expect(307 * low.pr).toBeGreaterThanOrEqual(PRESETS.low.minHeight);
    expect(med.pr).toBeGreaterThan(low.pr);
    expect(572 * 307 * med.pr * med.pr).toBeLessThanOrEqual(PRESETS.med.maxPixels * 1.01);
  });
  it('never exceeds device pixel ratio and keeps desktops at ~1×', () => {
    expect(renderPixelRatio(1, 1920, 1080, PRESETS.high).pr).toBe(1);
    expect(renderPixelRatio(2, 400, 200, PRESETS.high).pr).toBeLessThanOrEqual(2);
  });
  it('dynamic resolution stays within [min, max]', () => {
    const r = renderPixelRatio(3, 572, 307, PRESETS.med, 0.1);
    expect(r.pr).toBe(r.min);
    expect(r.min * 307).toBeGreaterThanOrEqual(PRESETS.med.minHeight - 1);
  });
});

describe('dialogue voices', () => {
  it('maps story characters to stable genders', () => {
    expect(speakerFor('Lena').female).toBe(true);
    expect(speakerFor('Izzy').female).toBe(true);
    expect(speakerFor('Nico').female).toBe(false);
    expect(speakerFor('Sal').female).toBe(false);
    expect(speakerFor('Theo')).toEqual(speakerFor('Theo'));
    const s = speakerFor('Fare');
    expect(s.seed).toBeGreaterThanOrEqual(0);
    expect(s.seed).toBeLessThan(1);
  });
});

describe('saved vehicle', () => {
  it('survives migration and defaults to none', () => {
    const base = { player: { x: 0, y: 0, z: 0, yaw: 0, health: 100, armor: 0, appearance: defaultPlayerAppearance() }, story: { completed: [], flags: {}, unlocked: [] } };
    expect(migrateSave(base)!.vehicle).toBeNull();
    const v = { def: 'stiletto', paint: 0xff0000, mods: { engine: 2, brakes: 0, armor: 1, turbo: true, wheels: 0 }, health: 0.8, yaw: 1 };
    expect(migrateSave({ ...base, vehicle: v })!.vehicle).toEqual(v);
  });
});
