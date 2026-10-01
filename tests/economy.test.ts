import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { Wallet } from '../src/economy/Wallet';
import { Estate, PROPERTIES, PROPERTY_BY_ID } from '../src/economy/Estate';
import { applyChange, applyMod, changePrice, modPrice, moddedStats, repairPrice, MOD_LEVELS } from '../src/economy/Catalog';
import { defaultPlayerAppearance } from '../src/characters/Appearance';
import { vehicleDef } from '../src/vehicles/VehicleData';
import { LANDMARKS } from '../src/world/MapData';
import { SaveSystem, migrateSave, SAVE_VERSION, type SaveData } from '../src/core/SaveSystem';
import { PlayerStats } from '../src/game/PlayerStats';

function sampleSave(over: Partial<SaveData> = {}): SaveData {
  return {
    version: SAVE_VERSION, savedAt: 0, playTime: 120, slotName: 'Test',
    player: { x: 1, y: 2, z: 3, yaw: 0.5, health: 90, armor: 10, appearance: defaultPlayerAppearance() },
    cash: 1234, arsenal: { owned: ['fists', 'pistol'], ammo: { pistol: 30 }, clip: { pistol: 12 }, current: 'pistol' },
    story: { completed: ['m01_homecoming'], flags: { a: 'b' }, unlocked: ['property:safehouse_rustvale'] },
    hour: 13, day: 2, properties: ['safehouse_rustvale'], businesses: {}, garages: { safehouse_rustvale: [] },
    shells: [1, 5], stats: { kills: 3 }, activities: { race_harbor: 1 }, wardrobe: [],
    ...over,
  };
}

describe('estate', () => {
  it('every property maps to a landmark', () => {
    const ids = new Set(LANDMARKS.map((l) => l.id));
    for (const p of PROPERTIES) expect(ids.has(p.id), p.id).toBe(true);
  });

  it('buys properties only when affordable and unlocked', () => {
    const w = new Wallet(10000);
    const e = new Estate();
    expect(e.buy('safehouse_heights', w, 0)).toBe('funds');
    expect(e.buy('safehouse_rustvale', w, 0)).toBe('locked');
    expect(e.buy('biz_taco', w, 0)).toBe('ok');
    expect(w.cash).toBe(10000 - PROPERTY_BY_ID.biz_taco!.price);
    expect(e.buy('biz_taco', w, 0)).toBe('owned');
  });

  it('story unlock grants free safehouses with a garage', () => {
    const e = new Estate();
    expect(e.unlock('safehouse_rustvale', 0)).toBe(true);
    expect(e.owned.has('safehouse_rustvale')).toBe(true);
    expect(e.garageCapacity('safehouse_rustvale')).toBe(1);
    const car = { def: 'bruiser', paint: 0xff0000, mods: { engine: 1, brakes: 0, armor: 0, turbo: false, wheels: 0 } };
    expect(e.store('safehouse_rustvale', car)).toBe(true);
    expect(e.store('safehouse_rustvale', car)).toBe(false); // full
    expect(e.takeOut('safehouse_rustvale', 0)?.def).toBe('bruiser');
    expect(e.takeOut('safehouse_rustvale', 0)).toBeNull();
  });

  it('businesses accrue capped daily income', () => {
    const w = new Wallet(50000);
    const e = new Estate();
    e.buy('biz_arcade', w, 3);
    const inc = PROPERTY_BY_ID.biz_arcade!.income;
    expect(e.pending('biz_arcade', 3.9)).toBe(0);
    expect(e.pending('biz_arcade', 5.2)).toBe(2 * inc);
    expect(e.pending('biz_arcade', 40)).toBe(5 * inc); // capped
    const before = w.cash;
    expect(e.collect('biz_arcade', w, 5.2)).toBe(2 * inc);
    expect(w.cash).toBe(before + 2 * inc);
    expect(e.pending('biz_arcade', 5.9)).toBe(0);
    expect(e.dailyIncome()).toBe(inc);
  });

  it('round-trips through save()/load()', () => {
    const w = new Wallet(1e6);
    const e = new Estate();
    e.buy('safehouse_marina', w, 1);
    e.store('safehouse_marina', { def: 'stiletto', paint: 1, mods: { engine: 2, brakes: 1, armor: 0, turbo: true, wheels: 1 } });
    const e2 = new Estate();
    e2.load(JSON.parse(JSON.stringify(e.save())));
    expect([...e2.owned]).toEqual(['safehouse_marina']);
    expect(e2.garages.get('safehouse_marina')![0]!.mods.turbo).toBe(true);
  });
});

describe('catalog', () => {
  it('appearance changes cost money only when different', () => {
    const a = defaultPlayerAppearance();
    expect(changePrice(a, { k: 'hairStyle', v: a.hairStyle })).toBe(0);
    expect(changePrice(a, { k: 'hairStyle', v: 'mohawk' })).toBeGreaterThan(0);
    const b = applyChange(a, { k: 'tattoo', v: 'sleeve' });
    expect(b.tattoo).toBe('sleeve');
    expect(a.tattoo).toBe('tribal'); // immutable
  });

  it('mod prices scale with level and vehicle value; stats improve', () => {
    const pico = vehicleDef('pico'), gt = vehicleDef('aurelia');
    expect(modPrice(pico, 'engine', 2)).toBeGreaterThan(modPrice(pico, 'engine', 1));
    expect(modPrice(gt, 'engine', 1)).toBeGreaterThan(modPrice(pico, 'engine', 1));
    let m = { engine: 0, brakes: 0, armor: 0, turbo: false, wheels: 0 };
    const s0 = moddedStats(pico, m);
    m = applyMod(applyMod(applyMod(m, 'engine', 9), 'turbo', 1), 'wheels', 2);
    expect(m.engine).toBe(MOD_LEVELS.engine);
    const s1 = moddedStats(pico, m);
    expect(s1.engine).toBeGreaterThan(s0.engine * 1.5);
    expect(s1.grip).toBeGreaterThan(s0.grip);
  });

  it('repair price grows with damage', () => {
    const d = vehicleDef('meridian');
    expect(repairPrice(d, 1)).toBe(0);
    expect(repairPrice(d, 0.2)).toBeGreaterThan(repairPrice(d, 0.8));
  });
});

describe('save system', () => {
  it('round-trips save/load/list through IndexedDB', async () => {
    const s = SaveSystem.withIndexedDB(new IDBFactory());
    expect(await s.save('auto', sampleSave())).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(await s.save('slot1', sampleSave({ cash: 99 }))).toBe(true);
    const got = await s.load('auto');
    expect(got?.cash).toBe(1234);
    expect(got?.player.appearance.hairStyle).toBe('short');
    const list = await s.list();
    expect(list.map((x) => x.slot)).toEqual(['slot1', 'auto']);
    expect((await s.latest())?.data.cash).toBe(99);
    await s.remove('slot1');
    expect((await s.list()).length).toBe(1);
    expect(await s.load('nope')).toBeNull();
  });

  it('migrates old saves and rejects garbage', () => {
    const old = { player: sampleSave().player, story: { completed: ['m01_homecoming'] }, cash: 5 } as unknown as Partial<SaveData>;
    const m = migrateSave(old)!;
    expect(m.version).toBe(SAVE_VERSION);
    expect(m.story.flags).toEqual({});
    expect(m.properties).toEqual([]);
    expect(migrateSave({} as Partial<SaveData>)).toBeNull();
  });

  it('memory backend works without IndexedDB', async () => {
    const s = SaveSystem.inMemory();
    await s.save('a', sampleSave());
    expect((await s.load('a'))?.shells).toEqual([1, 5]);
  });
});

describe('player stats', () => {
  it('counts and formats', () => {
    const p = new PlayerStats();
    p.inc('kills');
    p.inc('kills', 2);
    p.max('maxWanted', 3);
    p.max('maxWanted', 2);
    p.inc('playTime', 3725);
    expect(p.get('kills')).toBe(3);
    expect(p.get('maxWanted')).toBe(3);
    expect(p.format('playTime')).toBe('1h 02m');
    const q = new PlayerStats();
    q.load(p.save());
    expect(q.get('kills')).toBe(3);
  });
});
