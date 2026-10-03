import type { Appearance } from '../characters/Appearance';

/** Named story characters (original cast). */
export interface StoryCharacter {
  id: string;
  name: string;
  role: string;
  bio: string;
  phone: string;
  app: Appearance;
}

const base: Appearance = {
  skin: 0xc68b62, shirt: 0xffffff, jacket: 0x202020, pants: 0x22304a, shoes: 0x111111, hair: 0x1a1210, hairStyle: 'short',
  beard: 'none', hat: 'none', hatColor: 0x222222, top: 'tee', bottom: 'pants', tattoo: 'none', tattooColor: 0x1a2a3a, height: 1, build: 1, female: false,
};
const C = (o: Partial<Appearance>): Appearance => ({ ...base, ...o });

export const CHARACTERS: Record<string, StoryCharacter> = {
  nico: { id: 'nico', name: 'Nico Reyes', role: 'Protagonist', bio: 'Former getaway driver. Five years inside for a job that went wrong. Wants the truth.', phone: '', app: C({}) },
  lena: { id: 'lena', name: 'Lena Reyes', role: 'Sister · mechanic', bio: "Runs Reyes' Body & Paint in Rustvale. Fixes cars, and her brother.", phone: '555-0142', app: C({ skin: 0xc68b62, female: true, hairStyle: 'bun', hair: 0x2d1d14, top: 'tank', shirt: 0x3a6a8a, pants: 0x3a3a48, build: 0.9, height: 0.95, tattoo: 'sleeve', tattooColor: 0x2a3a5a }) },
  theo: { id: 'theo', name: 'Theo Marsh', role: 'Old partner', bio: "Nico's partner on the Westbank job. Supposed to be dead.", phone: '555-0199', app: C({ skin: 0xe0ac85, hairStyle: 'slick', hair: 0xb08850, beard: 'stubble', top: 'suit', jacket: 0x2a2a3a, shirt: 0xe8e0d0, pants: 0x2a2a3a, build: 1.0, height: 1.04 }) },
  dima: { id: 'dima', name: 'Dmitri "Dima" Volk', role: 'Dock boss', bio: 'Runs Volk Shipping and everything that moves through the port.', phone: '555-0107', app: C({ skin: 0xf1c8a5, hairStyle: 'none', beard: 'full', hair: 0x4a2e1c, top: 'jacket', jacket: 0x3a2a24, shirt: 0x202020, pants: 0x202020, build: 1.2, height: 1.06, tattoo: 'neck' }) },
  izzy: { id: 'izzy', name: 'Isabel "Izzy" Navarro', role: 'Club owner · broker', bio: 'Owns Club Halcyon. Knows everyone, owes no one.', phone: '555-0177', app: C({ skin: 0xa86d47, female: true, hairStyle: 'long', hair: 0x1a1210, top: 'suit', jacket: 0x8a1a3a, shirt: 0x101010, pants: 0x101010, build: 0.88, height: 0.97 }) },
  price: { id: 'price', name: 'Capt. Harlan Price', role: 'Corrupt police captain', bio: "Solano PD's most decorated officer. Runs the city's protection racket.", phone: '', app: C({ skin: 0xf1c8a5, hairStyle: 'short', hair: 0x8a8a8a, beard: 'goatee', top: 'long', shirt: 0x24365a, pants: 0x1a2236, hat: 'police', hatColor: 0x1a2236, build: 1.12, height: 1.03 }) },
  sal: { id: 'sal', name: '"Old Sal" Moreno', role: 'Dustwater fixer', bio: 'Taught Nico to drive. Retired to the desert. Mostly.', phone: '555-0150', app: C({ skin: 0x8a5434, hairStyle: 'short', hair: 0xd8d8d8, beard: 'full', top: 'vest', shirt: 0xc8a070, pants: 0x5a4a3a, hat: 'cap', hatColor: 0x8a6a4a, build: 1.08, height: 0.97 }) },
  juno: { id: 'juno', name: 'Juno Park', role: 'Hacker · dispatcher', bio: "Nineteen, works the radio at Lena's. Can get into anything with a chip.", phone: '555-0123', app: C({ skin: 0xe0ac85, female: true, hairStyle: 'short', hair: 0x8a3ac8, top: 'jacket', jacket: 0x2a5a2a, shirt: 0xe0e0e0, pants: 0x3a3a3a, build: 0.86, height: 0.92, hat: 'beanie', hatColor: 0x2a2a2a }) },
  rico: { id: 'rico', name: 'Rico Moreno', role: "Sal's nephew", bio: 'Fast, loud, and certain he is the best driver in Sal Mesa.', phone: '', app: C({ skin: 0x8a5434, hairStyle: 'mohawk', hair: 0x1a1210, top: 'tank', shirt: 0xe04a2a, pants: 0x2a4060, build: 0.95 }) },
  mika: { id: 'mika', name: 'Mika', role: 'Halcyon regular', bio: 'Dances like nobody is watching. Somebody always is.', phone: '', app: C({ skin: 0xf1c8a5, female: true, hairStyle: 'long', hair: 0xd8c08a, top: 'tank', shirt: 0xff2a8a, pants: 0x101010, bottom: 'shorts', build: 0.86, height: 0.95 }) },
};
