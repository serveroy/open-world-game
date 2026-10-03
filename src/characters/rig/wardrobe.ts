import type { Appearance, HatStyle } from '../Appearance';

/**
 * Appearance → dressed parts (Quaternius Ultimate Modular Men / Women, mixed and matched per body
 * type). Pure: the shops and barber keep editing the classic `Appearance` fields (top, bottom,
 * hairstyle, beard, hat, colours) and this maps them onto parts; `variant` picks between equivalent
 * parts for crowd variety.
 */
export interface PartPick {
  head: string;
  body: string;
  legs: string;
  feet: string;
  /** Procedural hat fitted on the head ('none' when the head part already has headwear). */
  hat: HatStyle;
}

const pick = <T,>(list: readonly T[], v: number, salt: number): T => list[Math.abs(Math.floor(v * 977 + salt * 131)) % list.length]!;

export function pickParts(app: Appearance): PartPick {
  return app.female ? pickFemale(app) : pickMale(app);
}

function pickMale(a: Appearance): PartPick {
  const v = a.variant ?? 0;
  if (a.hat === 'helmet') return { head: 'Swat_Head', body: 'Swat_Body', legs: 'Swat_Legs', feet: 'Swat_Feet', hat: 'none' };
  const police = a.hat === 'police';
  const worker = a.top === 'vest';
  // heads: hats sit on close-cut hair (beards are painted on any head)
  let head: string;
  if (worker && a.hat === 'none') head = 'Worker_Head';
  else if (a.hat !== 'none') head = a.hairStyle === 'slick' ? 'Suit_Head' : pick(['Casual_Head', 'Beach_Head', 'Suit_Head'], v, 1);
  else if (a.beard === 'full' && (a.hairStyle === 'short' || a.hairStyle === 'none')) head = 'Adventurer_Head'; // modelled beard
  else {
    const byHair: Record<Appearance['hairStyle'], readonly string[]> = {
      none: ['Beach_Head'], short: ['Casual_Head', 'Beach_Head', 'Suit_Head'], slick: ['Suit_Head'], long: ['Casual2_Head'],
      mohawk: ['Punk_Head'], afro: ['Casual_Head'], bun: ['Casual2_Head'],
    };
    head = pick(byHair[a.hairStyle], v, 1);
  }
  const body = police ? 'Casual2_Body' : ({
    tee: 'Casual2_Body', long: pick(['Casual_Body', 'Farmer_Body'], v, 2), tank: 'Beach_Body', jacket: pick(['Punk_Body', 'Adventurer_Body'], v, 2),
    suit: 'Suit_Body', vest: 'Worker_Body',
  } as const)[a.top];
  let legs: string;
  if (police || a.top === 'suit') legs = 'Suit_Legs';
  else if (worker) legs = 'Worker_Legs';
  else if (a.bottom === 'shorts') legs = pick(['Beach_Legs', 'Casual_Legs'], v, 3);
  else if (a.top === 'jacket') legs = pick(['Punk_Legs', 'Adventurer_Legs', 'Casual2_Legs'], v, 3);
  else legs = pick(['Casual2_Legs', 'Farmer_Legs', 'Punk_Legs'], v, 3);
  let feet: string;
  if (police || a.top === 'suit') feet = 'Suit_Feet';
  else if (worker) feet = 'Worker_Feet';
  else if (a.bottom === 'shorts' && a.top === 'tank') feet = 'Beach_Feet';
  else feet = pick(['Casual_Feet', 'Casual2_Feet', 'Punk_Feet', 'Adventurer_Feet', 'Farmer_Feet'], v, 4);
  return { head, body, legs: legs === 'Farmer_Legs' ? 'Farmer_Pants' : legs, feet, hat: head === 'Worker_Head' ? 'none' : a.hat };
}

function pickFemale(a: Appearance): PartPick {
  const v = a.variant ?? 0;
  const police = a.hat === 'police';
  const swat = a.hat === 'helmet';
  const worker = a.top === 'vest' && !swat;
  let head: string;
  if (worker && a.hat === 'none') head = 'Worker_Head';
  else if (a.hat !== 'none') head = pick(['Soldier_Head', 'Adventurer_Head'], v, 1);
  else {
    const byHair: Record<Appearance['hairStyle'], readonly string[]> = {
      none: ['Soldier_Head'], short: ['Soldier_Head', 'Adventurer_Head'], slick: ['Suit_Head'], long: ['Casual_Head', 'Suit_Head'],
      mohawk: ['Punk_Head'], afro: ['Formal_Head'], bun: ['Formal_Head'],
    };
    head = pick(byHair[a.hairStyle], v, 1);
  }
  const dress = a.top === 'tank' && a.bottom === 'shorts';
  let body: string;
  if (police || swat) body = 'Soldier_Body';
  else if (dress) body = 'Formal_Body';
  else body = ({
    tee: 'Casual_Body', long: pick(['Adventurer_Body', 'Soldier_Body'], v, 2), tank: pick(['Casual_Body', 'Punk_Body'], v, 2),
    jacket: pick(['Adventurer_Body', 'Punk_Body'], v, 2), suit: 'Suit_Body', vest: 'Worker_Body',
  } as const)[a.top];
  let legs: string;
  if (police || swat) legs = 'Soldier_Legs';
  else if (dress) legs = 'Formal_Legs';
  else if (a.top === 'suit') legs = 'Suit_Legs';
  else if (worker) legs = 'Worker_Legs';
  else if (a.bottom === 'shorts') legs = 'Adventurer_Legs';
  else legs = pick(['Casual_Legs', 'Suit_Legs', 'Punk_Legs'], v, 3);
  let feet: string;
  if (police || swat) feet = 'Soldier_Feet';
  else if (dress) feet = 'Formal_Feet';
  else if (a.top === 'suit') feet = 'Suit_Feet';
  else if (worker) feet = 'Worker_Feet';
  else feet = pick(['Casual_Feet', 'Punk_Feet', 'Adventurer_Feet'], v, 4);
  return { head, body, legs, feet, hat: head === 'Worker_Head' ? 'none' : a.hat };
}

/** Every part name the wardrobe can return, per body type (asset completeness test). */
export const WARDROBE_PARTS = {
  male: [
    'Swat_Head', 'Swat_Body', 'Swat_Legs', 'Swat_Feet', 'Worker_Head', 'Casual_Head', 'Beach_Head', 'Suit_Head', 'Adventurer_Head', 'Casual2_Head', 'Punk_Head',
    'Casual2_Body', 'Casual_Body', 'Farmer_Body', 'Beach_Body', 'Punk_Body', 'Adventurer_Body', 'Suit_Body', 'Worker_Body',
    'Suit_Legs', 'Worker_Legs', 'Beach_Legs', 'Casual_Legs', 'Punk_Legs', 'Adventurer_Legs', 'Casual2_Legs', 'Farmer_Pants',
    'Suit_Feet', 'Worker_Feet', 'Beach_Feet', 'Casual_Feet', 'Casual2_Feet', 'Punk_Feet', 'Adventurer_Feet', 'Farmer_Feet',
  ],
  female: [
    'Worker_Head', 'Soldier_Head', 'Adventurer_Head', 'Suit_Head', 'Casual_Head', 'Punk_Head', 'Formal_Head',
    'Soldier_Body', 'Formal_Body', 'Casual_Body', 'Adventurer_Body', 'Punk_Body', 'Suit_Body', 'Worker_Body',
    'Soldier_Legs', 'Formal_Legs', 'Suit_Legs', 'Worker_Legs', 'Adventurer_Legs', 'Casual_Legs', 'Punk_Legs',
    'Soldier_Feet', 'Formal_Feet', 'Suit_Feet', 'Worker_Feet', 'Casual_Feet', 'Punk_Feet', 'Adventurer_Feet',
  ],
} as const;
