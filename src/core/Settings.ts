/** Persistent per-device settings (localStorage). Save games live in IndexedDB instead. */
export type QualityLevel = 'low' | 'med' | 'high';
export type ColorblindMode = 'off' | 'protanopia' | 'deuteranopia' | 'tritanopia';

export interface HudLayout {
  /** Global HUD button scale (0.7 – 1.5). */
  buttonScale: number;
  /** Per-button offset overrides in px from default anchor: id → [dx, dy]. */
  offsets: Record<string, [number, number]>;
  opacity: number;
  leftHanded: boolean;
}

export interface SettingsData {
  version: number;
  quality: QualityLevel | 'auto';
  dynamicResolution: boolean;
  fpsCap: 30 | 60 | 0;
  shadows: boolean;
  bloom: boolean;
  viewDistance: number; // 0.5 – 1.5 multiplier
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  radioStation: number;
  lookSensitivity: number;
  aimSensitivity: number;
  invertY: boolean;
  aimAssist: 'off' | 'light' | 'full';
  gyroAim: boolean;
  subtitles: boolean;
  /** Dialogue voices: device speech, synthetic babble, or none. */
  voice: 'speech' | 'babble' | 'off';
  subtitleSize: number;
  colorblind: ColorblindMode;
  haptics: boolean;
  screenShake: number;
  showFps: boolean;
  dayLengthMinutes: number;
  hud: HudLayout;
  units: 'metric' | 'imperial';
}

export const DEFAULT_SETTINGS: SettingsData = {
  version: 2,
  quality: 'auto',
  dynamicResolution: true,
  fpsCap: 60,
  shadows: true,
  bloom: true,
  viewDistance: 1,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.9,
  radioStation: 0,
  lookSensitivity: 1,
  aimSensitivity: 0.8,
  invertY: false,
  aimAssist: 'full',
  gyroAim: false,
  subtitles: true,
  voice: 'speech',
  subtitleSize: 1,
  colorblind: 'off',
  haptics: true,
  screenShake: 1,
  showFps: false,
  dayLengthMinutes: 24,
  hud: { buttonScale: 1, offsets: {}, opacity: 0.85, leftHanded: false },
  units: 'metric',
};

const KEY = 'crimson-coast.settings';

/** Merge unknown stored data onto defaults, dropping invalid types (forward/backward compatible). */
export function migrateSettings(raw: unknown): SettingsData {
  const out: SettingsData = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return out;
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(out) as (keyof SettingsData)[]) {
    if (k === 'version' || k === 'hud') continue;
    const v = src[k];
    if (v !== undefined && typeof v === typeof out[k]) (out as unknown as Record<string, unknown>)[k] = v;
  }
  const hud = src.hud as Partial<HudLayout> | undefined;
  if (hud && typeof hud === 'object') {
    if (typeof hud.buttonScale === 'number') out.hud.buttonScale = Math.min(1.5, Math.max(0.7, hud.buttonScale));
    if (typeof hud.opacity === 'number') out.hud.opacity = hud.opacity;
    if (typeof hud.leftHanded === 'boolean') out.hud.leftHanded = hud.leftHanded;
    if (hud.offsets && typeof hud.offsets === 'object') out.hud.offsets = { ...hud.offsets };
  }
  return out;
}

type SettingsListener = (s: SettingsData) => void;

export class Settings {
  data: SettingsData;
  private listeners = new Set<SettingsListener>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    let raw: unknown = null;
    try {
      const txt = this.storage?.getItem(KEY);
      raw = txt ? JSON.parse(txt) : null;
    } catch {
      raw = null;
    }
    this.data = migrateSettings(raw);
  }
  set<K extends keyof SettingsData>(key: K, value: SettingsData[K]): void {
    this.data[key] = value;
    this.save();
  }
  save(): void {
    try {
      this.storage?.setItem(KEY, JSON.stringify(this.data));
    } catch {
      /* storage unavailable (private mode) — settings stay in memory */
    }
    for (const l of this.listeners) l(this.data);
  }
  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  reset(): void {
    this.data = structuredClone(DEFAULT_SETTINGS);
    this.save();
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}
