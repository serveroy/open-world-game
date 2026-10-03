/**
 * Hand-authored layout of the Costa Carmesí region (pure data + analytic helpers).
 * See PLAN.md §2 for the map overview. Units: meters. −Z is north.
 */
import { smoothstep, clamp } from '../core/math';

export type DistrictId =
  | 'docks' | 'rustvale' | 'velvet' | 'downtown' | 'midtown' | 'marina' | 'heights'
  | 'desert' | 'dustwater' | 'coralkeys' | 'pelican' | 'sea' | 'beach';

export interface District {
  id: DistrictId;
  name: string;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Minimap land colour. */
  color: string;
}

/** Ordered: first match wins. */
export const DISTRICTS: District[] = [
  { id: 'dustwater', name: 'Dustwater', x0: 1040, z0: 180, x1: 1330, z1: 470, color: '#b89a6a' },
  { id: 'docks', name: 'Volk Docks', x0: -900, z0: -1100, x1: -500, z1: -340, color: '#5a5f66' },
  { id: 'rustvale', name: 'Rustvale', x0: -500, z0: -1100, x1: 300, z1: -340, color: '#6e6258' },
  { id: 'velvet', name: 'Velvet Row', x0: -900, z0: -340, x1: -450, z1: 340, color: '#6a4a6e' },
  { id: 'downtown', name: 'Downtown Solano', x0: -450, z0: -340, x1: -60, z1: 340, color: '#55606e' },
  { id: 'midtown', name: 'Midtown', x0: -60, z0: -340, x1: 300, z1: 340, color: '#5e6a62' },
  { id: 'marina', name: 'Gull Point Marina', x0: -900, z0: 340, x1: -600, z1: 1100, color: '#5a6e7a' },
  { id: 'heights', name: 'Palm Heights', x0: -600, z0: 340, x1: 300, z1: 1100, color: '#5f7a58' },
  { id: 'coralkeys', name: 'Coral Keys', x0: -1450, z0: -850, x1: -1050, z1: -450, color: '#c8b88a' },
  { id: 'pelican', name: 'Pelican Isle', x0: -1380, z0: 420, x1: -1020, z1: 780, color: '#b8b080' },
  { id: 'desert', name: 'Sal Mesa Desert', x0: 300, z0: -1200, x1: 1600, z1: 1200, color: '#c9a46a' },
];

export function districtAt(x: number, z: number): DistrictId {
  if (isSea(x, z)) return 'sea';
  for (const d of DISTRICTS) if (x >= d.x0 && x < d.x1 && z >= d.z0 && z < d.z1) return d.id;
  return x > 300 ? 'desert' : 'beach';
}

export function districtName(id: DistrictId): string {
  if (id === 'sea') return 'Carmesí Sea';
  if (id === 'beach') return 'Solano Beach';
  return DISTRICTS.find((d) => d.id === id)?.name ?? '';
}

// ---------------------------------------------------------------------------
// Coastline & islands
// ---------------------------------------------------------------------------

/** X of the mainland shoreline at a given z (land is east of it). */
export function coastX(z: number): number {
  let x = -830 + Math.sin(z / 170) * 22 + Math.sin(z / 53 + 1.3) * 8;
  // docks: straight concrete quay
  if (z < -340) x = -805;
  return x;
}

export const ISLANDS = [
  { id: 'coralkeys', x: -1250, z: -650, r: 165, h: 9 },
  { id: 'pelican', x: -1200, z: 600, r: 135, h: 16 },
  { id: 'gullrock', x: -1000, z: 140, r: 40, h: 6 },
];

/** Marina basin carved into the coast (water). */
export const MARINA_BASIN = { x0: -840, x1: -705, z0: 590, z1: 860 };

/** Signed distance-ish "inland" metric: >0 land, <0 sea. */
export function landMetric(x: number, z: number): number {
  // world edges: sea to the west/north/south of the city
  let m = x - coastX(z);
  if (x < 300) {
    const north = z - -1110; // positive south of north coast
    const south = 1110 - z;
    m = Math.min(m, north + Math.sin(x / 60) * 6, south + Math.sin(x / 47) * 6);
  }
  if (x > MARINA_BASIN.x0 - 40 && x < MARINA_BASIN.x1 && z > MARINA_BASIN.z0 && z < MARINA_BASIN.z1) {
    const dx = Math.min(x - MARINA_BASIN.x0 + 200, MARINA_BASIN.x1 - x);
    const dz = Math.min(z - MARINA_BASIN.z0, MARINA_BASIN.z1 - z);
    m = Math.min(m, -Math.min(dx, dz));
  }
  for (const isl of ISLANDS) {
    const d = Math.hypot(x - isl.x, z - isl.z);
    const wobble = Math.sin(Math.atan2(z - isl.z, x - isl.x) * 5 + isl.r) * isl.r * 0.12;
    m = Math.max(m, isl.r + wobble - d);
  }
  return m;
}

export function isSea(x: number, z: number): boolean {
  return landMetric(x, z) < 0;
}

/** Quay segments get a vertical sea wall (docks + marina). */
export function isQuay(x: number, z: number): boolean {
  return (z < -340 && x < -700) || (x > MARINA_BASIN.x0 - 60 && x < MARINA_BASIN.x1 + 20 && z > MARINA_BASIN.z0 - 20 && z < MARINA_BASIN.z1 + 20);
}

// ---------------------------------------------------------------------------
// Road layout (authored lines; intersections computed in Roads.ts)
// ---------------------------------------------------------------------------

export interface StreetLine {
  name: string;
  /** 'v' = constant x (north–south), 'h' = constant z (east–west) */
  dir: 'v' | 'h';
  at: number;
  from: number;
  to: number;
  width: number;
  speed: number; // m/s target for traffic
}

const V = (name: string, at: number, from: number, to: number, width = 11, speed = 13): StreetLine => ({ name, dir: 'v', at, from, to, width, speed });
const H = (name: string, at: number, from: number, to: number, width = 11, speed = 13): StreetLine => ({ name, dir: 'h', at, from, to, width, speed });

export const CITY_STREETS: StreetLine[] = [
  V('Beach Boulevard', -690, -1040, 1040, 14, 15),
  V('Harbor Street', -590, -1040, 1040),
  V('Neon Way', -490, -1040, 1040),
  V('Tower Avenue', -400, -1040, 1040, 12, 14),
  V('Bank Street', -310, -340, 380),
  V('Civic Avenue', -220, -1040, 1040, 12, 14),
  V('Plaza Street', -130, -340, 380),
  V('Crosstown Avenue', -40, -1040, 1040, 12, 14),
  V('Market Street', 60, -340, 1040),
  V('Foundry Road', 160, -1040, 1040),
  V('Eastgate Road', 270, -1040, 1040, 12, 15),
  H('North Shore Drive', -1040, -690, 270, 12, 15),
  H('Cannery Row', -900, -690, 270),
  H('Rust Street', -760, -690, 270),
  H('Pipe Lane', -620, -690, 270),
  H('Freight Avenue', -480, -690, 270, 12, 14),
  H('Union Street', -340, -690, 270, 12, 14),
  H('1st Street', -250, -690, 270),
  H('2nd Street', -160, -690, 270),
  H('3rd Street', -70, -690, 270),
  H('Solano Avenue', 20, -690, 270, 14, 15),
  H('5th Street', 110, -690, 270),
  H('6th Street', 200, -690, 270),
  H('7th Street', 290, -690, 270),
  H('Palm Drive', 380, -690, 270, 12, 14),
  H('Sunset Lane', 520, -690, 270),
  H('Orchard Way', 660, -690, 270),
  H('Hillcrest Drive', 800, -690, 270),
  H('Cypress Road', 920, -690, 270),
  H('South Shore Drive', 1040, -690, 270, 12, 15),
];

/** Desert / highway polylines (x,z control points). Nodes are inserted every ~50 m. */
export interface RoadPath {
  name: string;
  points: [number, number][];
  width: number;
  speed: number;
}

export const DESERT_ROADS: RoadPath[] = [
  {
    name: 'Route 9',
    width: 15,
    speed: 26,
    points: [[270, 20], [380, 18], [520, -20], [650, -60], [790, -40], [920, 60], [1040, 200], [1130, 300], [1180, 310], [1230, 310], [1330, 300], [1460, 230], [1540, 120]],
  },
  {
    name: 'Mesa Loop',
    width: 12,
    speed: 22,
    points: [[650, -60], [720, -220], [860, -380], [1040, -470], [1240, -510], [1400, -500], [1480, -380], [1470, -200], [1400, -20], [1300, 140], [1230, 310]],
  },
  {
    name: 'Old Mine Road',
    width: 10,
    speed: 18,
    points: [[790, -40], [800, 160], [760, 380], [700, 600], [640, 820], [560, 960]],
  },
  { name: 'Dustwater Main', width: 11, speed: 12, points: [[1130, 300], [1130, 420]] },
  { name: 'Mesa Street', width: 11, speed: 12, points: [[1230, 310], [1230, 430]] },
  { name: 'Cactus Row', width: 11, speed: 12, points: [[1080, 420], [1130, 420], [1230, 430], [1290, 430]] },
];

// ---------------------------------------------------------------------------
// Landmarks & points of interest
// ---------------------------------------------------------------------------

export type LandmarkKind =
  | 'police' | 'hospital' | 'gunshop' | 'respray' | 'modshop' | 'barber' | 'clothes' | 'tattoo'
  | 'safehouse' | 'club' | 'gas' | 'bank' | 'helipad' | 'boatrental' | 'diner' | 'lighthouse' | 'villa'
  | 'business' | 'warehouse' | 'property';

export interface Landmark {
  id: string;
  name: string;
  kind: LandmarkKind;
  /** Door / interaction marker position */
  x: number;
  z: number;
  /** Facing of the door (heading). */
  yaw: number;
  /** Building footprint (center + half sizes), reserves the lot. */
  bx: number;
  bz: number;
  hx: number;
  hz: number;
  height: number;
  color?: number;
}

const L = (id: string, name: string, kind: LandmarkKind, x: number, z: number, yaw: number, bx: number, bz: number, hx: number, hz: number, height: number, color?: number): Landmark =>
  ({ id, name, kind, x, z, yaw, bx, bz, hx, hz, height, color });

/** Door yaw: 0 = door faces +Z (south). */
export const LANDMARKS: Landmark[] = [
  L('police_hq', 'Solano PD Headquarters', 'police', -265, -97, 0, -265, -125, 32, 22, 26, 0x6e7a8a),
  L('hospital', 'Solano General Hospital', 'hospital', 110, 92, 0, 110, 65, 36, 22, 30, 0xe8e8e8),
  L('gunshop', 'Iron & Ember', 'gunshop', 15, -199, 0, 15, -215, 14, 12, 7, 0x4a3a30),
  L('respray', "Reyes' Body & Paint", 'respray', -100, -682, 0, -100, -700, 18, 14, 7, 0x8a4a3a),
  L('respray2', 'Pump & Paint', 'respray', 600, -97, 0, 600, -114, 12, 10, 6, 0x9a7a5a),
  L('modshop', 'Chrome Daddy Customs', 'modshop', 215, -548, Math.PI, 215, -530, 20, 14, 8, 0x3a3a4a),
  L('barber', 'Fade Factory', 'barber', -546, -110, -Math.PI / 2, -530, -110, 12, 10, 8, 0x6a2a5a),
  L('clothes', 'Threadline', 'clothes', -175, 122, Math.PI, -175, 140, 16, 14, 12, 0xd0c0b0),
  L('tattoo', 'Ink Tide', 'tattoo', -544, 65, -Math.PI / 2, -530, 65, 10, 10, 8, 0x2a2a3a),
  L('safehouse_heights', 'Palm Heights Bungalow', 'safehouse', -170, 588, 0, -170, 575, 10, 9, 6, 0xd8c8a8),
  L('safehouse_rustvale', 'Rustvale Walk-up', 'safehouse', 10, -832, 0, 10, -845, 10, 9, 9, 0x8a6a5a),
  L('safehouse_marina', 'Gull Point Condo', 'safehouse', -641, 720, -Math.PI / 2, -625, 720, 12, 14, 18, 0xe0e0f0),
  L('safehouse_dustwater', "Sal's Spare Room", 'safehouse', 1180, 367, Math.PI, 1180, 380, 10, 9, 6, 0xc8a87a),
  L('club_halcyon', 'Club Halcyon', 'club', -542, 245, -Math.PI / 2, -520, 245, 18, 16, 14, 0x2a1a3a),
  L('club_ember', 'The Ember Room', 'club', -538, -200, -Math.PI / 2, -520, -200, 14, 12, 10, 0x3a1a1a),
  L('bank', 'First Solano Bank', 'bank', -355, 77, 0, -355, 55, 24, 18, 40, 0xc8c0b0),
  L('gas_pump49', 'Pump 49', 'gas', 640, -95, 0, 640, -112, 10, 7, 5, 0xe8d8b8),
  L('gas_lastchance', 'Last Chance Gas', 'gas', 1390, -533, 0, 1390, -550, 10, 7, 5, 0xd8c8a8),
  L('helipad', 'Skyline Tower Helipad', 'helipad', -355, -180, 0, -355, -205, 22, 22, 72, 0x5a6a7a),
  L('boatrental', 'Gull Point Boat Rental', 'boatrental', -702, 560, Math.PI / 2, -712, 560, 6, 6, 4, 0x6a8aa0),
  L('diner', 'Dusty Spoon Diner', 'diner', 1113, 360, Math.PI / 2, 1095, 360, 14, 9, 5, 0xc87a5a),
  L('lighthouse', 'Pelican Point Lighthouse', 'lighthouse', -1300, 568, 0, -1300, 560, 5, 5, 26, 0xf0f0f0),
  L('villa', 'Price Villa', 'villa', -1180, 652, Math.PI, -1180, 670, 22, 16, 9, 0xf0e8d8),
  L('volk_yard', 'Volk Shipping Yard', 'warehouse', -612, -700, Math.PI / 2, -640, -700, 26, 40, 13, 0x5a6a7a),
  L('biz_carwash', 'Sudz Car Wash', 'business', 120, -428, Math.PI, 120, -415, 14, 9, 6, 0x4a8aca),
  L('biz_taco', 'Taco Tide', 'business', -455, 467, 0, -455, 455, 10, 8, 5, 0xe0a030),
  L('biz_arcade', 'Pixel Palace Arcade', 'business', -175, -60, Math.PI, -175, -45, 14, 12, 12, 0x8a3ac8),
  L('biz_motel', 'Mirage Motel', 'business', 1290, 372, Math.PI, 1290, 385, 30, 10, 6, 0xd8a870),
  L('biz_scrapyard', 'Rustvale Scrap', 'business', 215, -835, 0, 215, -860, 28, 22, 5, 0x6a5a4a),
];

export function landmark(id: string): Landmark {
  const l = LANDMARKS.find((x) => x.id === id);
  if (!l) throw new Error(`unknown landmark ${id}`);
  return l;
}

/** Respawn points. */
export const SPAWNS = {
  start: { x: -100, z: -672, yaw: 0 },
  hospital: { x: 110, z: 98, yaw: 0 },
  police: { x: -265, z: -92, yaw: 0 },
};

/** Desert scenery: mesas (flat-topped rocks). */
export const MESAS: { x: number; z: number; r: number; h: number }[] = [
  { x: 560, z: -420, r: 50, h: 34 },
  { x: 900, z: -720, r: 80, h: 48 },
  { x: 1240, z: -820, r: 60, h: 40 },
  { x: 980, z: 520, r: 70, h: 38 },
  { x: 1420, z: 700, r: 90, h: 55 },
  { x: 560, z: 600, r: 45, h: 28 },
  { x: 1180, z: -250, r: 40, h: 26 },
  { x: 400, z: -880, r: 55, h: 30 },
  { x: 1340, z: 980, r: 60, h: 36 },
];

/** Smoothly flatten towards 0 near the given radius. Utility for terrain. */
export function radialMask(x: number, z: number, cx: number, cz: number, r0: number, r1: number): number {
  const d = Math.hypot(x - cx, z - cz);
  return 1 - smoothstep(r0, r1, d);
}

export function inWorld(x: number, z: number): boolean {
  return x > -1580 && x < 1580 && z > -1180 && z < 1180;
}

export const clampWorld = (x: number, z: number): [number, number] => [clamp(x, -1570, 1570), clamp(z, -1170, 1170)];
