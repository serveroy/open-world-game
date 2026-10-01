/** IndexedDB save slots (falls back to localStorage, then memory). */
import type { Appearance } from '../characters/Appearance';
import type { ArsenalSave } from '../combat/Weapons';
import type { StoryState } from '../missions/MissionManager';

export const SAVE_VERSION = 3;

export interface GarageCar {
  def: string;
  paint: number;
  mods: { engine: number; brakes: number; armor: number; turbo: boolean; wheels: number };
}

export interface SaveData {
  version: number;
  savedAt: number;
  playTime: number;
  slotName: string;
  player: { x: number; y: number; z: number; yaw: number; health: number; armor: number; appearance: Appearance };
  cash: number;
  arsenal: ArsenalSave;
  story: StoryState;
  hour: number;
  day: number;
  properties: string[];
  businesses: Record<string, number>;
  garages: Record<string, GarageCar[]>;
  shells: number[];
  stats: Record<string, number>;
  activities: Record<string, number>;
  wardrobe: string[];
}

const DB = 'crimson-coast';
const STORE = 'saves';

type Backend = {
  get(key: string): Promise<SaveData | null>;
  put(key: string, v: SaveData): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

function idbBackend(idb: IDBFactory): Backend {
  let dbp: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = idb.open(DB, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  };
  const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((res, rej) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  };
  return {
    get: async (k) => ((await tx('readonly', (s) => s.get(k))) as SaveData | undefined) ?? null,
    put: async (k, v) => void (await tx('readwrite', (s) => s.put(v, k))),
    del: async (k) => void (await tx('readwrite', (s) => s.delete(k))),
    keys: async () => ((await tx('readonly', (s) => s.getAllKeys())) as IDBValidKey[]).map(String),
  };
}

function lsBackend(ls: Storage): Backend {
  const P = 'crimson-coast.save.';
  return {
    get: async (k) => {
      const t = ls.getItem(P + k);
      return t ? (JSON.parse(t) as SaveData) : null;
    },
    put: async (k, v) => ls.setItem(P + k, JSON.stringify(v)),
    del: async (k) => ls.removeItem(P + k),
    keys: async () => Object.keys(ls).filter((x) => x.startsWith(P)).map((x) => x.slice(P.length)),
  };
}

function memBackend(): Backend {
  const m = new Map<string, SaveData>();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, structuredClone(v)),
    del: async (k) => void m.delete(k),
    keys: async () => Array.from(m.keys()),
  };
}

/** Upgrade older saves in place (add new fields with defaults). */
export function migrateSave(s: Partial<SaveData>): SaveData | null {
  if (!s || typeof s !== 'object' || !s.player || !s.story) return null;
  return {
    version: SAVE_VERSION,
    savedAt: s.savedAt ?? Date.now(),
    playTime: s.playTime ?? 0,
    slotName: s.slotName ?? 'Save',
    player: s.player,
    cash: s.cash ?? 0,
    arsenal: s.arsenal ?? { owned: ['fists'], ammo: {}, clip: {}, current: 'fists' },
    story: { completed: s.story.completed ?? [], flags: s.story.flags ?? {}, unlocked: s.story.unlocked ?? [] },
    hour: s.hour ?? 9,
    day: s.day ?? 0,
    properties: s.properties ?? [],
    businesses: s.businesses ?? {},
    garages: s.garages ?? {},
    shells: s.shells ?? [],
    stats: s.stats ?? {},
    activities: s.activities ?? {},
    wardrobe: s.wardrobe ?? [],
  };
}

export class SaveSystem {
  private backend: Backend;
  constructor(backend?: Backend) {
    if (backend) this.backend = backend;
    else {
      let b: Backend | null = null;
      try {
        if (typeof indexedDB !== 'undefined') b = idbBackend(indexedDB);
      } catch {
        b = null;
      }
      if (!b) {
        try {
          if (typeof localStorage !== 'undefined') b = lsBackend(localStorage);
        } catch {
          b = null;
        }
      }
      this.backend = b ?? memBackend();
    }
  }

  static withIndexedDB(idb: IDBFactory): SaveSystem {
    return new SaveSystem(idbBackend(idb));
  }
  static inMemory(): SaveSystem {
    return new SaveSystem(memBackend());
  }

  async save(slot: string, data: SaveData): Promise<boolean> {
    try {
      await this.backend.put(slot, { ...data, version: SAVE_VERSION, savedAt: Date.now() });
      return true;
    } catch {
      return false;
    }
  }

  async load(slot: string): Promise<SaveData | null> {
    try {
      const raw = await this.backend.get(slot);
      return raw ? migrateSave(raw) : null;
    } catch {
      return null;
    }
  }

  async remove(slot: string): Promise<void> {
    try {
      await this.backend.del(slot);
    } catch {
      /* ignore */
    }
  }

  async list(): Promise<{ slot: string; data: SaveData }[]> {
    try {
      const keys = await this.backend.keys();
      const out: { slot: string; data: SaveData }[] = [];
      for (const k of keys) {
        const d = await this.load(k);
        if (d) out.push({ slot: k, data: d });
      }
      return out.sort((a, b) => b.data.savedAt - a.data.savedAt);
    } catch {
      return [];
    }
  }

  /** Most recent save (auto or manual). */
  async latest(): Promise<{ slot: string; data: SaveData } | null> {
    return (await this.list())[0] ?? null;
  }
}
