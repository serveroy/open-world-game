/** Per-vertex region ids painted by the character shader (body ids match scripts/build-characters.mjs). */
export const enum Region {
  Head = 0,
  Neck = 1,
  Chest = 2,
  Belly = 3,
  Hips = 4,
  UpperArm = 5,
  LowerArm = 6,
  Hand = 7,
  Thigh = 8,
  Calf = 9,
  Foot = 10,
  Eye = 11,
  // accessories (built at runtime)
  Hair = 16,
  Beard = 17,
  Hat = 18,
  HatTrim = 19,
  Item = 20,
  Outer = 22,
  Vest = 24,
}

/** Accessory categories; a vertex shows only if the instance selected its (category, id). */
export const enum Cat {
  Body = 0,
  Hair = 1,
  Beard = 2,
  Hat = 3,
  Item = 4,
  Outer = 5,
}

export const HAIR_IDS = { none: 0, short: 1, long: 2, mohawk: 3, bun: 4, afro: 5, slick: 6 } as const;
export const BEARD_IDS = { none: 0, stubble: 0, full: 1, goatee: 2 } as const;
export const HAT_IDS = { none: 0, cap: 1, police: 2, helmet: 3, beanie: 4 } as const;
export const ITEM_IDS = { none: 0, pistol: 1, smg: 2, shotgun: 3, rifle: 4, sniper: 5, bat: 6, knife: 7, grenade: 8, molotov: 9, phone: 10, lockpick: 11, baton: 12 } as const;
export const OUTER_IDS = { none: 0, jacket: 1, suit: 2, vest: 3 } as const;

/** Variant attribute value for (category, id). */
export const variant = (cat: Cat, id: number): number => cat * 32 + id;
