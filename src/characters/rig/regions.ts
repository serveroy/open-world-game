/**
 * Paint slots of the dressed parts (per vertex; keep in sync with scripts/build-characters.mjs `P`)
 * and of the procedural accessories (hats, held items).
 */
export const enum Paint {
  Skin = 0,
  Hair = 1,
  Brow = 2,
  Eye = 3,
  Top1 = 4,
  Top2 = 5,
  Bottom = 6,
  Shoes = 7,
  Hat = 8,
  Fixed = 9,
  Face = 10,
  // accessories
  ProcHat = 16,
  ProcHatTrim = 17,
  Item = 20,
}

/** Accessory categories; a vertex shows only if the instance selected its (category, id). */
export const enum Cat {
  Part = 0,
  Hat = 3,
  Item = 4,
}

export const HAT_IDS = { none: 0, cap: 1, police: 2, helmet: 3, beanie: 4 } as const;
export const ITEM_IDS = { none: 0, pistol: 1, smg: 2, shotgun: 3, rifle: 4, sniper: 5, bat: 6, knife: 7, grenade: 8, molotov: 9, phone: 10, lockpick: 11, baton: 12 } as const;

/** Variant attribute value for (category, id). */
export const variant = (cat: Cat, id: number): number => cat * 32 + id;
