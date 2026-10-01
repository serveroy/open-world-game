/** Shop catalogues + pure pricing / application logic for every store in Port Solano. */
import type { Appearance, BeardStyle, BottomStyle, HairStyle, HatStyle, TattooStyle, TopStyle } from '../characters/Appearance';
import { HAIR_COLORS } from '../characters/Appearance';
import { WEAPONS, type WeaponId } from '../combat/Weapons';
import type { VehicleDef } from '../vehicles/VehicleData';

export type ShopKind = 'gunshop' | 'barber' | 'clothes' | 'tattoo' | 'modshop' | 'respray';

export interface ShopItem {
  id: string;
  name: string;
  price: number;
  /** Optional colour swatch (hex) shown on the card. */
  swatch?: number;
  /** Category/tab within the shop. */
  cat: string;
  desc?: string;
  /** Current selection / owned — filled at display time. */
  owned?: boolean;
  disabled?: boolean;
  /** Replaces the price/OWNED line (save slots, garage cars). */
  badge?: string;
}

// ---------------------------------------------------------------- appearance shops
export const HAIR_STYLES: { id: HairStyle; name: string; price: number }[] = [
  { id: 'short', name: 'Crop', price: 40 },
  { id: 'slick', name: 'Slick Back', price: 60 },
  { id: 'mohawk', name: 'Mohawk', price: 80 },
  { id: 'afro', name: 'Afro', price: 70 },
  { id: 'long', name: 'Long', price: 60 },
  { id: 'bun', name: 'Top Knot', price: 55 },
  { id: 'none', name: 'Shaved', price: 25 },
];
export const BEARDS: { id: BeardStyle; name: string; price: number }[] = [
  { id: 'none', name: 'Clean Shave', price: 15 },
  { id: 'stubble', name: 'Stubble', price: 20 },
  { id: 'goatee', name: 'Goatee', price: 35 },
  { id: 'full', name: 'Full Beard', price: 45 },
];
export const DYE_PRICE = 60;

export const TOPS: { id: TopStyle; name: string; price: number }[] = [
  { id: 'tee', name: 'Tee', price: 35 },
  { id: 'long', name: 'Long Sleeve', price: 55 },
  { id: 'tank', name: 'Tank', price: 30 },
  { id: 'jacket', name: 'Bomber Jacket', price: 220 },
  { id: 'vest', name: 'Utility Vest', price: 140 },
  { id: 'suit', name: 'Sharp Suit', price: 900 },
];
export const BOTTOMS: { id: BottomStyle; name: string; price: number }[] = [
  { id: 'pants', name: 'Jeans', price: 60 },
  { id: 'shorts', name: 'Shorts', price: 35 },
];
export const HATS: { id: HatStyle; name: string; price: number }[] = [
  { id: 'none', name: 'No Hat', price: 0 },
  { id: 'cap', name: 'Ball Cap', price: 30 },
  { id: 'beanie', name: 'Beanie', price: 25 },
];
export const CLOTH_COLORS = [0xffffff, 0x202020, 0xc8283c, 0x2850a0, 0x3a8a4a, 0xe0b030, 0x8a3ac8, 0xff7a30, 0x50c0d0, 0x704830, 0xe8e0d0, 0x406080, 0xf0a0b0, 0x3a2a24, 0x5a1a1a];
export const PANTS_COLORS = [0x22304a, 0x1e1e1e, 0x5a4a3a, 0x7a6a50, 0x3a3a48, 0x2a4060, 0xc0b090, 0x4a3020, 0xe8e0d0];
export const SHOE_COLORS = [0x111111, 0xf2f2f2, 0x5a3a20, 0x8a1a1a, 0x303060, 0xe0b030];
export const SHOE_PRICE = 80;

export const TATTOOS: { id: TattooStyle; name: string; price: number }[] = [
  { id: 'none', name: 'Laser Removal', price: 300 },
  { id: 'tribal', name: 'Tide Tribal', price: 250 },
  { id: 'neck', name: 'Neck Piece', price: 350 },
  { id: 'sleeve', name: 'Full Sleeve', price: 700 },
  { id: 'full', name: 'Sleeves + Neck', price: 1100 },
];
export const INK_COLORS = [0x1a2a3a, 0x101010, 0x7a1a1a, 0x1a4a2a, 0x3a1a5a];

export type AppearanceChange =
  | { k: 'hairStyle'; v: HairStyle } | { k: 'beard'; v: BeardStyle } | { k: 'hair'; v: number }
  | { k: 'top'; v: TopStyle } | { k: 'bottom'; v: BottomStyle } | { k: 'hat'; v: HatStyle }
  | { k: 'shirt'; v: number } | { k: 'jacket'; v: number } | { k: 'pants'; v: number } | { k: 'shoes'; v: number } | { k: 'hatColor'; v: number }
  | { k: 'tattoo'; v: TattooStyle } | { k: 'tattooColor'; v: number };

export function applyChange(a: Appearance, c: AppearanceChange): Appearance {
  return { ...a, [c.k]: c.v };
}

/** Price of an appearance change (0 when it's what you already have). */
export function changePrice(a: Appearance, c: AppearanceChange): number {
  if (a[c.k] === c.v) return 0;
  switch (c.k) {
    case 'hairStyle': return HAIR_STYLES.find((h) => h.id === c.v)?.price ?? 50;
    case 'beard': return BEARDS.find((h) => h.id === c.v)?.price ?? 25;
    case 'hair': return DYE_PRICE;
    case 'top': return TOPS.find((h) => h.id === c.v)?.price ?? 50;
    case 'bottom': return BOTTOMS.find((h) => h.id === c.v)?.price ?? 50;
    case 'hat': return HATS.find((h) => h.id === c.v)?.price ?? 25;
    case 'shirt': case 'jacket': case 'pants': case 'hatColor': return 25;
    case 'shoes': return SHOE_PRICE;
    case 'tattoo': return TATTOOS.find((h) => h.id === c.v)?.price ?? 300;
    case 'tattooColor': return 120;
  }
}

export const HAIR_DYES = HAIR_COLORS;

// ---------------------------------------------------------------- gun shop
export const ARMOR_PRICE = 250;
export const GUNSHOP_STOCK: WeaponId[] = ['bat', 'knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'grenade', 'molotov'];
/** Weapons that need story progress before they appear in the shop. */
export const GUN_UNLOCK: Partial<Record<WeaponId, string>> = { rifle: 'm08_route9', sniper: 'm12_rooftops', grenade: 'm06_hotpursuit', shotgun: 'm05_shotsfired' };

export function weaponPrice(id: WeaponId): number {
  return WEAPONS[id].price;
}
export function ammoPrice(id: WeaponId): { price: number; amount: number } {
  return { price: WEAPONS[id].ammoPrice, amount: WEAPONS[id].ammoPack };
}

// ---------------------------------------------------------------- mod shop
export type ModKind = 'engine' | 'brakes' | 'armor' | 'turbo' | 'wheels';
export const MOD_LEVELS: Record<ModKind, number> = { engine: 4, brakes: 3, armor: 4, turbo: 1, wheels: 3 };
export const MOD_NAMES: Record<ModKind, string[]> = {
  engine: ['Stock', 'Street Tune', 'Sport Tune', 'Race Tune', 'Tidal Tune'],
  brakes: ['Stock', 'Street Brakes', 'Sport Brakes', 'Race Brakes'],
  armor: ['None', 'Armor 25%', 'Armor 50%', 'Armor 75%', 'Armor 100%'],
  turbo: ['None', 'Turbo'],
  wheels: ['Stock Tyres', 'Sport Compound', 'Semi-Slick', 'Full Race Slick'],
};
const MOD_BASE: Record<ModKind, number> = { engine: 900, brakes: 500, armor: 1100, turbo: 4000, wheels: 600 };

export interface VehicleMods { engine: number; brakes: number; armor: number; turbo: boolean; wheels: number }

export function modLevel(m: VehicleMods, k: ModKind): number {
  return k === 'turbo' ? (m.turbo ? 1 : 0) : m[k];
}

/** Price of buying mod `k` at `level` for this vehicle — scales with the vehicle's value. */
export function modPrice(def: VehicleDef, k: ModKind, level: number): number {
  if (level <= 0) return 0;
  const scale = 0.7 + Math.min(2.5, Math.sqrt(Math.max(3000, def.value) / 6000) * 0.6);
  return Math.round((MOD_BASE[k] * level * (1 + (level - 1) * 0.35) * scale) / 10) * 10;
}

/** Apply a mod purchase; returns the new mods (doesn't mutate). */
export function applyMod(m: VehicleMods, k: ModKind, level: number): VehicleMods {
  const n = { ...m };
  if (k === 'turbo') n.turbo = level > 0;
  else n[k] = Math.max(0, Math.min(MOD_LEVELS[k], level));
  return n;
}

/** Effective handling numbers after mods (mirrors Vehicle.stepGround). */
export function moddedStats(def: VehicleDef, m: VehicleMods): { engine: number; maxSpeed: number; brake: number; grip: number; armor: number } {
  return {
    engine: def.engineForce * (1 + m.engine * 0.12) * (m.turbo ? 1.15 : 1),
    maxSpeed: def.maxSpeed * (1 + m.engine * 0.04),
    brake: def.brakeForce * 1.45 * (1 + m.brakes * 0.15),
    grip: def.grip * (1 + m.wheels * 0.05),
    armor: 1 - m.armor * 0.15,
  };
}

export const PAINTS: { name: string; hex: number }[] = [
  { name: 'Coast Red', hex: 0xc8283c }, { name: 'Midnight', hex: 0x101418 }, { name: 'Pearl', hex: 0xf0f0f0 },
  { name: 'Harbor Blue', hex: 0x2850a0 }, { name: 'Lime Rush', hex: 0x9ae020 }, { name: 'Sunset Orange', hex: 0xff7a10 },
  { name: 'Ultraviolet', hex: 0x8a2ae0 }, { name: 'Gold Leaf', hex: 0xd8a830 }, { name: 'Gunmetal', hex: 0x4a5058 },
  { name: 'Teal Tide', hex: 0x10a0a0 }, { name: 'Hot Pink', hex: 0xff3aa0 }, { name: 'Forest', hex: 0x2a5a2a },
  { name: 'Sand', hex: 0xd8c8a0 }, { name: 'Cherry Black', hex: 0x3a0a10 }, { name: 'Sky', hex: 0x6ac0ff },
];
export const PAINT_PRICE = 400;
export const RESPRAY_PRICE = 150;

/** Repair cost by missing health fraction. */
export function repairPrice(def: VehicleDef, healthFraction: number): number {
  const missing = Math.max(0, 1 - healthFraction);
  if (missing < 0.01) return 0;
  return Math.max(50, Math.round((missing * (200 + def.value * 0.02)) / 10) * 10);
}
