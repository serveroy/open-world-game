/** Weapon definitions & inventory logic (pure — unit-tested). */
import type { HeldItem } from '../characters/CharacterRenderer';

export type WeaponId = 'fists' | 'bat' | 'knife' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'grenade' | 'molotov';
export type WeaponSlot = 'melee' | 'handgun' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'thrown';
export type WeaponKind = 'melee' | 'gun' | 'thrown';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  icon: string;
  slot: WeaponSlot;
  kind: WeaponKind;
  held: HeldItem;
  damage: number;
  /** Shots per second */
  rate: number;
  mag: number;
  maxAmmo: number;
  reload: number;
  /** Spread (radians) hip / aimed */
  spread: number;
  aimSpread: number;
  range: number;
  pellets: number;
  recoil: number;
  auto: boolean;
  driveBy: boolean;
  price: number;
  ammoPrice: number;
  ammoPack: number;
  scope?: boolean;
  /** Melee reach & arc */
  reach?: number;
  arc?: number;
  /** Damage multiplier vs vehicles */
  vehicleMul: number;
  loud: number;
}

const W = (d: WeaponDef): WeaponDef => d;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  fists: W({ id: 'fists', name: 'Fists', icon: '✊', slot: 'melee', kind: 'melee', held: 'none', damage: 12, rate: 2.4, mag: 0, maxAmmo: 0, reload: 0, spread: 0, aimSpread: 0, range: 1.4, pellets: 1, recoil: 0, auto: false, driveBy: false, price: 0, ammoPrice: 0, ammoPack: 0, reach: 1.35, arc: 1.2, vehicleMul: 0.1, loud: 0 }),
  bat: W({ id: 'bat', name: 'Slugger Bat', icon: '🏏', slot: 'melee', kind: 'melee', held: 'bat', damage: 34, rate: 1.4, mag: 0, maxAmmo: 0, reload: 0, spread: 0, aimSpread: 0, range: 1.9, pellets: 1, recoil: 0, auto: false, driveBy: false, price: 150, ammoPrice: 0, ammoPack: 0, reach: 1.8, arc: 1.6, vehicleMul: 1, loud: 0 }),
  knife: W({ id: 'knife', name: 'Switchblade', icon: '🔪', slot: 'melee', kind: 'melee', held: 'knife', damage: 45, rate: 2.0, mag: 0, maxAmmo: 0, reload: 0, spread: 0, aimSpread: 0, range: 1.4, pellets: 1, recoil: 0, auto: false, driveBy: false, price: 200, ammoPrice: 0, ammoPack: 0, reach: 1.35, arc: 0.9, vehicleMul: 0.2, loud: 0 }),
  pistol: W({ id: 'pistol', name: 'P9 Viper', icon: '🔫', slot: 'handgun', kind: 'gun', held: 'pistol', damage: 26, rate: 4, mag: 12, maxAmmo: 240, reload: 1.3, spread: 0.035, aimSpread: 0.012, range: 90, pellets: 1, recoil: 0.025, auto: false, driveBy: true, price: 600, ammoPrice: 60, ammoPack: 24, vehicleMul: 1, loud: 55 }),
  smg: W({ id: 'smg', name: 'Hornet SMG', icon: '🐝', slot: 'smg', kind: 'gun', held: 'smg', damage: 16, rate: 12, mag: 30, maxAmmo: 480, reload: 1.6, spread: 0.06, aimSpread: 0.032, range: 70, pellets: 1, recoil: 0.018, auto: true, driveBy: true, price: 1800, ammoPrice: 90, ammoPack: 60, vehicleMul: 0.9, loud: 60 }),
  shotgun: W({ id: 'shotgun', name: 'Breaker 12', icon: '💥', slot: 'shotgun', kind: 'gun', held: 'shotgun', damage: 14, rate: 1.1, mag: 6, maxAmmo: 96, reload: 2.4, spread: 0.11, aimSpread: 0.075, range: 35, pellets: 9, recoil: 0.09, auto: false, driveBy: false, price: 2500, ammoPrice: 80, ammoPack: 16, vehicleMul: 1.2, loud: 70 }),
  rifle: W({ id: 'rifle', name: 'AR-K Tidal', icon: '🎯', slot: 'rifle', kind: 'gun', held: 'rifle', damage: 30, rate: 9, mag: 30, maxAmmo: 360, reload: 2.0, spread: 0.045, aimSpread: 0.012, range: 140, pellets: 1, recoil: 0.024, auto: true, driveBy: false, price: 4500, ammoPrice: 120, ammoPack: 60, vehicleMul: 1.3, loud: 80 }),
  sniper: W({ id: 'sniper', name: 'Longshot .50', icon: '🔭', slot: 'sniper', kind: 'gun', held: 'sniper', damage: 140, rate: 0.75, mag: 5, maxAmmo: 50, reload: 2.8, spread: 0.08, aimSpread: 0.0008, range: 400, pellets: 1, recoil: 0.12, auto: false, driveBy: false, price: 8000, ammoPrice: 150, ammoPack: 10, scope: true, vehicleMul: 2.5, loud: 100 }),
  grenade: W({ id: 'grenade', name: 'Frag Grenade', icon: '💣', slot: 'thrown', kind: 'thrown', held: 'grenade', damage: 180, rate: 1, mag: 1, maxAmmo: 25, reload: 0.4, spread: 0, aimSpread: 0, range: 40, pellets: 1, recoil: 0, auto: false, driveBy: false, price: 300, ammoPrice: 300, ammoPack: 3, vehicleMul: 1, loud: 100 }),
  molotov: W({ id: 'molotov', name: 'Molotov', icon: '🔥', slot: 'thrown', kind: 'thrown', held: 'molotov', damage: 40, rate: 1, mag: 1, maxAmmo: 25, reload: 0.4, spread: 0, aimSpread: 0, range: 35, pellets: 1, recoil: 0, auto: false, driveBy: false, price: 250, ammoPrice: 250, ammoPack: 3, vehicleMul: 1, loud: 30 }),
};

export const WHEEL_ORDER: WeaponId[] = ['fists', 'bat', 'knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'grenade', 'molotov'];

export interface ArsenalSave {
  owned: WeaponId[];
  ammo: Partial<Record<WeaponId, number>>;
  clip: Partial<Record<WeaponId, number>>;
  current: WeaponId;
}

export type FireResult = 'none' | 'fired' | 'empty' | 'reloading' | 'cooldown';

/** Player/NPC weapon inventory with magazines & reloads. */
export class Arsenal {
  owned = new Set<WeaponId>(['fists']);
  /** Reserve ammo (not in magazine) */
  ammo: Partial<Record<WeaponId, number>> = {};
  /** Rounds in the magazine */
  clip: Partial<Record<WeaponId, number>> = {};
  current: WeaponId = 'fists';
  cooldown = 0;
  reloading = 0;
  infinite = false;

  get def(): WeaponDef {
    return WEAPONS[this.current];
  }

  give(id: WeaponId, ammo = 0): void {
    const d = WEAPONS[id];
    const isNew = !this.owned.has(id);
    this.owned.add(id);
    if (d.kind === 'gun' || d.kind === 'thrown') {
      const total = (this.ammo[id] ?? 0) + (this.clip[id] ?? 0) + ammo;
      const capped = Math.min(total, d.maxAmmo + d.mag);
      const inClip = Math.min(d.mag, capped);
      this.clip[id] = inClip;
      this.ammo[id] = capped - inClip;
    }
    if (isNew && WHEEL_ORDER.indexOf(id) > WHEEL_ORDER.indexOf(this.current) && d.kind === 'gun' && this.current === 'fists') this.current = id;
  }

  addAmmo(id: WeaponId, n: number): number {
    const d = WEAPONS[id];
    const before = (this.ammo[id] ?? 0) + (this.clip[id] ?? 0);
    const after = Math.min(before + n, d.maxAmmo + d.mag);
    this.ammo[id] = after - (this.clip[id] ?? 0);
    return after - before;
  }

  total(id: WeaponId): number {
    return (this.ammo[id] ?? 0) + (this.clip[id] ?? 0);
  }

  has(id: WeaponId): boolean {
    if (!this.owned.has(id)) return false;
    const d = WEAPONS[id];
    return d.kind === 'melee' || this.total(id) > 0 || this.infinite;
  }

  select(id: WeaponId): boolean {
    if (!this.has(id)) return false;
    if (id !== this.current) {
      this.current = id;
      this.reloading = 0;
      this.cooldown = Math.max(this.cooldown, 0.25);
    }
    return true;
  }

  cycle(dir: 1 | -1): WeaponId {
    const i = WHEEL_ORDER.indexOf(this.current);
    for (let k = 1; k <= WHEEL_ORDER.length; k++) {
      const id = WHEEL_ORDER[(i + dir * k + WHEEL_ORDER.length * 2) % WHEEL_ORDER.length]!;
      if (this.has(id)) {
        this.select(id);
        break;
      }
    }
    return this.current;
  }

  /** Attempt to fire/swing/throw once. */
  fire(): FireResult {
    const d = this.def;
    if (this.reloading > 0) return 'reloading';
    if (this.cooldown > 0) return 'cooldown';
    if (d.kind === 'melee') {
      this.cooldown = 1 / d.rate;
      return 'fired';
    }
    const c = this.clip[d.id] ?? 0;
    if (c <= 0 && !this.infinite) {
      if ((this.ammo[d.id] ?? 0) > 0) this.startReload();
      else {
        this.cooldown = 0.3;
        return 'empty';
      }
      return 'reloading';
    }
    if (!this.infinite) this.clip[d.id] = c - 1;
    this.cooldown = 1 / d.rate;
    if (d.kind === 'thrown' && (this.clip[d.id] ?? 0) <= 0 && (this.ammo[d.id] ?? 0) > 0) {
      this.clip[d.id] = 1;
      this.ammo[d.id] = (this.ammo[d.id] ?? 0) - 1;
    }
    return 'fired';
  }

  startReload(): boolean {
    const d = this.def;
    if (d.kind !== 'gun' || this.reloading > 0) return false;
    const c = this.clip[d.id] ?? 0;
    if (c >= d.mag || (this.ammo[d.id] ?? 0) <= 0) return false;
    this.reloading = d.reload;
    return true;
  }

  tick(dt: number): boolean {
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) {
        this.reloading = 0;
        const d = this.def;
        const need = d.mag - (this.clip[d.id] ?? 0);
        const take = Math.min(need, this.ammo[d.id] ?? 0);
        this.clip[d.id] = (this.clip[d.id] ?? 0) + take;
        this.ammo[d.id] = (this.ammo[d.id] ?? 0) - take;
        return true;
      }
    }
    // auto-switch away from empty throwables
    if (!this.has(this.current)) this.cycle(-1);
    return false;
  }

  /** Lose all weapons except fists (busted). */
  strip(): void {
    this.owned = new Set(['fists']);
    this.ammo = {};
    this.clip = {};
    this.current = 'fists';
  }

  save(): ArsenalSave {
    return { owned: Array.from(this.owned), ammo: { ...this.ammo }, clip: { ...this.clip }, current: this.current };
  }
  load(s: ArsenalSave): void {
    this.owned = new Set(s.owned.length ? s.owned : ['fists']);
    this.ammo = { ...s.ammo };
    this.clip = { ...s.clip };
    this.current = this.owned.has(s.current) ? s.current : 'fists';
  }

  ammoText(): string {
    const d = this.def;
    if (d.kind === 'melee') return '';
    if (d.kind === 'thrown') return `${this.total(d.id)}`;
    return `${this.clip[d.id] ?? 0} / ${this.ammo[d.id] ?? 0}`;
  }
}
