import { Rng } from '../core/rng';

export type HairStyle = 'none' | 'short' | 'long' | 'mohawk' | 'bun' | 'afro' | 'slick';
export type BeardStyle = 'none' | 'stubble' | 'full' | 'goatee';
export type HatStyle = 'none' | 'cap' | 'police' | 'helmet' | 'beanie';
export type TopStyle = 'tee' | 'long' | 'tank' | 'jacket' | 'suit' | 'vest';
export type BottomStyle = 'pants' | 'shorts';
export type TattooStyle = 'none' | 'tribal' | 'sleeve' | 'neck' | 'full';

export interface Appearance {
  skin: number;
  shirt: number;
  jacket: number;
  pants: number;
  shoes: number;
  hair: number;
  hairStyle: HairStyle;
  beard: BeardStyle;
  hat: HatStyle;
  hatColor: number;
  top: TopStyle;
  bottom: BottomStyle;
  tattoo: TattooStyle;
  tattooColor: number;
  height: number; // scale ~0.92..1.08
  build: number; // torso width scale ~0.88..1.15
  female: boolean;
  /** 0..1: picks between equivalent clothing / head parts (crowd variety). */
  variant?: number;
}

export const SKIN_TONES = [0xf1c8a5, 0xe0ac85, 0xc68b62, 0xa86d47, 0x8a5434, 0x5f3a24, 0xffdbc0];
export const HAIR_COLORS = [0x1a1210, 0x2d1d14, 0x4a2e1c, 0x7a4b2a, 0xb08850, 0xd8c08a, 0x8a8a8a, 0xb02020, 0x3050c0, 0xe060a0];
const SHIRT = [0xffffff, 0x202020, 0xc8283c, 0x2850a0, 0x3a8a4a, 0xe0b030, 0x8a3ac8, 0xff7a30, 0x50c0d0, 0x704830, 0xe8e0d0, 0x406080, 0xf0a0b0];
const PANTS = [0x22304a, 0x1e1e1e, 0x5a4a3a, 0x7a6a50, 0x3a3a48, 0x2a4060, 0xc0b090, 0x4a3020];
const SHOES = [0x111111, 0xf2f2f2, 0x5a3a20, 0x8a1a1a, 0x303060];

export function defaultPlayerAppearance(): Appearance {
  return {
    skin: 0xc68b62, shirt: 0xe8e0d0, jacket: 0x3a2a24, pants: 0x22304a, shoes: 0x111111,
    hair: 0x1a1210, hairStyle: 'short', beard: 'stubble', hat: 'none', hatColor: 0x222222,
    top: 'jacket', bottom: 'pants', tattoo: 'tribal', tattooColor: 0x1a2a3a,
    height: 1.0, build: 1.04, female: false,
  };
}

export function randomAppearance(rng: Rng, opts: { female?: boolean; nightlife?: boolean; desert?: boolean } = {}): Appearance {
  const female = opts.female ?? rng.chance(0.5);
  const hairStyle: HairStyle = female
    ? rng.pick(['long', 'bun', 'long', 'afro', 'short'] as const)
    : rng.pick(['short', 'short', 'none', 'mohawk', 'afro', 'slick', 'short'] as const);
  const top: TopStyle = opts.nightlife
    ? rng.pick(['tank', 'jacket', 'suit', 'tee'] as const)
    : rng.pick(['tee', 'tee', 'long', 'jacket', 'tank', 'vest', 'suit'] as const);
  return {
    skin: rng.pick(SKIN_TONES),
    shirt: rng.pick(SHIRT),
    jacket: rng.pick([0x202020, 0x3a2a24, 0x2a3a5a, 0x5a1a1a, 0x4a4a4a, 0x6a5a40]),
    pants: rng.pick(PANTS),
    shoes: rng.pick(SHOES),
    hair: rng.pick(HAIR_COLORS.slice(0, opts.nightlife ? 10 : 7)),
    hairStyle,
    beard: female ? 'none' : rng.pick(['none', 'none', 'stubble', 'full', 'goatee'] as const),
    hat: opts.desert && rng.chance(0.4) ? 'cap' : rng.chance(0.12) ? rng.pick(['cap', 'beanie'] as const) : 'none',
    hatColor: rng.pick([0x202020, 0xc8283c, 0x2850a0, 0xe8e0d0, 0x3a6a3a]),
    top,
    bottom: rng.chance(0.25) ? 'shorts' : 'pants',
    tattoo: rng.chance(0.15) ? rng.pick(['tribal', 'sleeve', 'neck'] as const) : 'none',
    tattooColor: 0x1a2a3a,
    height: female ? rng.range(0.94, 1.02) : rng.range(0.95, 1.06),
    build: female ? rng.range(0.85, 0.95) : rng.range(0.95, 1.15),
    female,
    variant: rng.next(),
  };
}

export function policeAppearance(rng: Rng, swat = false): Appearance {
  const female = rng.chance(0.25);
  return {
    skin: rng.pick(SKIN_TONES), shirt: swat ? 0x1e2228 : 0x24365a, jacket: 0x1a2236, pants: swat ? 0x1e2228 : 0x1a2236,
    shoes: 0x111111, hair: rng.pick(HAIR_COLORS.slice(0, 6)), hairStyle: female ? 'bun' : 'short',
    beard: 'none', hat: swat ? 'helmet' : 'police', hatColor: swat ? 0x15181c : 0x1a2236,
    top: swat ? 'vest' : 'long', bottom: 'pants', tattoo: 'none', tattooColor: 0,
    height: rng.range(0.97, 1.06), build: swat ? 1.18 : rng.range(1.0, 1.12), female, variant: rng.next(),
  };
}

export function medicAppearance(rng: Rng): Appearance {
  const a = randomAppearance(rng);
  return { ...a, shirt: 0xf0f0f0, pants: 0x2a6a5a, top: 'long', bottom: 'pants', hat: 'none' };
}
