/**
 * Original vehicle line-up (no real brands). Pure data — physics & mesh builders read it.
 * Dimensions in metres, mass kg, forces N, speeds m/s.
 */
export type VehicleKind = 'car' | 'bike' | 'boat' | 'heli';
export type VehicleClass =
  | 'compact' | 'sedan' | 'muscle' | 'sports' | 'super' | 'suv' | 'pickup' | 'van' | 'taxi'
  | 'police' | 'ambulance' | 'bus' | 'swat' | 'bike' | 'boat' | 'heli';
export type BodyStyle = 'hatch' | 'sedan' | 'muscle' | 'coupe' | 'wedge' | 'suv' | 'pickup' | 'van' | 'box' | 'bus' | 'sportbike' | 'cruiser' | 'skiff' | 'speedboat' | 'heli';
export type Drive = 'fwd' | 'rwd' | 'awd';

export interface VehicleDef {
  id: string;
  name: string;
  kind: VehicleKind;
  cls: VehicleClass;
  style: BodyStyle;
  length: number;
  width: number;
  height: number;
  wheelBase: number;
  wheelRadius: number;
  wheelWidth: number;
  track: number;
  clearance: number;
  mass: number;
  engineForce: number;
  maxSpeed: number;
  brakeForce: number;
  grip: number;
  steer: number;
  drive: Drive;
  suspension: number;
  /** suspension stiffness */
  stiffness: number;
  health: number;
  colors: number[];
  /** Seats (driver first) local offsets for occupants */
  seats: [number, number, number][];
  siren?: boolean;
  armored?: boolean;
  /** Price at mod shop / value for theft contracts */
  value: number;
  /** Spawn weight in traffic by district group */
  traffic: number;
  /** Lights, extras */
  taxi?: boolean;
  /** Gears for RPM sound */
  gears: number;
  /** Engine sound character 0 (small) … 1 (big V8) */
  engineTone: number;
}

const D = (d: VehicleDef): VehicleDef => d;
const CIVIL = [0xc8283c, 0x2850a0, 0xe8e8e8, 0x202020, 0x8a8a90, 0x3a6a3a, 0xe0b030, 0x6a3a8a, 0x2aa0c0, 0x8a4a2a, 0xf0e8d8, 0x4a5a6a];

export const VEHICLES: VehicleDef[] = [
  D({ id: 'pico', name: 'Pico', kind: 'car', cls: 'compact', style: 'hatch', length: 3.7, width: 1.7, height: 1.45, wheelBase: 2.4, wheelRadius: 0.3, wheelWidth: 0.2, track: 1.45, clearance: 0.18, mass: 950, engineForce: 3600, maxSpeed: 40, brakeForce: 32, grip: 2.6, steer: 0.62, drive: 'fwd', suspension: 0.22, stiffness: 32, health: 750, colors: CIVIL, seats: [[0.35, 0.45, -0.1], [-0.35, 0.45, -0.1]], value: 3200, traffic: 1.2, gears: 4, engineTone: 0.1 }),
  D({ id: 'meridian', name: 'Meridian', kind: 'car', cls: 'sedan', style: 'sedan', length: 4.7, width: 1.85, height: 1.45, wheelBase: 2.8, wheelRadius: 0.33, wheelWidth: 0.22, track: 1.58, clearance: 0.18, mass: 1450, engineForce: 5200, maxSpeed: 47, brakeForce: 42, grip: 2.7, steer: 0.55, drive: 'fwd', suspension: 0.24, stiffness: 30, health: 1000, colors: CIVIL, seats: [[0.38, 0.42, 0], [-0.38, 0.42, 0]], value: 6500, traffic: 2, gears: 5, engineTone: 0.35 }),
  D({ id: 'bruiser', name: 'Bruiser', kind: 'car', cls: 'muscle', style: 'muscle', length: 4.9, width: 1.95, height: 1.32, wheelBase: 2.9, wheelRadius: 0.35, wheelWidth: 0.28, track: 1.64, clearance: 0.16, mass: 1600, engineForce: 8600, maxSpeed: 54, brakeForce: 40, grip: 2.35, steer: 0.5, drive: 'rwd', suspension: 0.24, stiffness: 28, health: 1100, colors: [0x101010, 0xc8283c, 0xe0b030, 0x2a5a2a, 0x2850a0, 0xf0f0f0], seats: [[0.4, 0.38, -0.2], [-0.4, 0.38, -0.2]], value: 18000, traffic: 0.6, gears: 4, engineTone: 1 }),
  D({ id: 'stiletto', name: 'Stiletto', kind: 'car', cls: 'sports', style: 'coupe', length: 4.4, width: 1.9, height: 1.25, wheelBase: 2.6, wheelRadius: 0.34, wheelWidth: 0.26, track: 1.62, clearance: 0.13, mass: 1300, engineForce: 8800, maxSpeed: 60, brakeForce: 52, grip: 3.2, steer: 0.5, drive: 'rwd', suspension: 0.18, stiffness: 42, health: 850, colors: [0xe02020, 0xf0c020, 0x1a1a1a, 0xf0f0f0, 0x2a6ae0, 0x2ac06a], seats: [[0.38, 0.32, -0.15], [-0.38, 0.32, -0.15]], value: 45000, traffic: 0.35, gears: 6, engineTone: 0.6 }),
  D({ id: 'aurelia', name: 'Aurelia GT', kind: 'car', cls: 'super', style: 'wedge', length: 4.6, width: 2.0, height: 1.12, wheelBase: 2.7, wheelRadius: 0.35, wheelWidth: 0.3, track: 1.7, clearance: 0.11, mass: 1400, engineForce: 11500, maxSpeed: 72, brakeForce: 60, grip: 3.6, steer: 0.47, drive: 'awd', suspension: 0.15, stiffness: 50, health: 800, colors: [0xff7a10, 0xf0f0f0, 0x101010, 0xc0ff20, 0xa01aff, 0x10a0ff], seats: [[0.38, 0.26, -0.2], [-0.38, 0.26, -0.2]], value: 120000, traffic: 0.12, gears: 7, engineTone: 0.75 }),
  D({ id: 'ranger', name: 'Ranger XT', kind: 'car', cls: 'suv', style: 'suv', length: 4.8, width: 1.98, height: 1.85, wheelBase: 2.85, wheelRadius: 0.4, wheelWidth: 0.26, track: 1.66, clearance: 0.26, mass: 2100, engineForce: 7200, maxSpeed: 46, brakeForce: 44, grip: 2.5, steer: 0.52, drive: 'awd', suspension: 0.32, stiffness: 26, health: 1300, colors: [0x202020, 0xe8e8e8, 0x4a5a3a, 0x8a1a1a, 0x3a4a6a, 0xb0a080], seats: [[0.42, 0.6, 0.1], [-0.42, 0.6, 0.1]], value: 15000, traffic: 1, gears: 5, engineTone: 0.65 }),
  D({ id: 'mule', name: 'Mule', kind: 'car', cls: 'pickup', style: 'pickup', length: 5.3, width: 1.98, height: 1.8, wheelBase: 3.2, wheelRadius: 0.4, wheelWidth: 0.26, track: 1.66, clearance: 0.28, mass: 2000, engineForce: 6800, maxSpeed: 44, brakeForce: 40, grip: 2.4, steer: 0.5, drive: 'rwd', suspension: 0.32, stiffness: 25, health: 1300, colors: [0xa02a2a, 0x2a4a8a, 0xe8e8e8, 0x6a5a3a, 0x3a3a3a, 0xd8c8a0], seats: [[0.42, 0.6, 0.55], [-0.42, 0.6, 0.55]], value: 9000, traffic: 1, gears: 5, engineTone: 0.8 }),
  D({ id: 'courier', name: 'Courier', kind: 'car', cls: 'van', style: 'van', length: 5.2, width: 2.0, height: 2.3, wheelBase: 3.2, wheelRadius: 0.36, wheelWidth: 0.24, track: 1.7, clearance: 0.2, mass: 2400, engineForce: 6000, maxSpeed: 38, brakeForce: 38, grip: 2.3, steer: 0.5, drive: 'rwd', suspension: 0.28, stiffness: 27, health: 1400, colors: [0xf0f0f0, 0xe0c030, 0x2a5a8a, 0x8a2a2a], seats: [[0.45, 0.75, 1.5], [-0.45, 0.75, 1.5]], value: 7000, traffic: 0.8, gears: 5, engineTone: 0.5 }),
  D({ id: 'cab', name: 'Solano Cab', kind: 'car', cls: 'taxi', style: 'sedan', length: 4.7, width: 1.85, height: 1.45, wheelBase: 2.8, wheelRadius: 0.33, wheelWidth: 0.22, track: 1.58, clearance: 0.18, mass: 1500, engineForce: 5400, maxSpeed: 47, brakeForce: 42, grip: 2.7, steer: 0.55, drive: 'fwd', suspension: 0.24, stiffness: 30, health: 1050, colors: [0xf0c018], seats: [[0.38, 0.42, 0], [-0.38, 0.42, 0]], value: 6000, traffic: 0.8, taxi: true, gears: 5, engineTone: 0.35 }),
  D({ id: 'interceptor', name: 'Interceptor', kind: 'car', cls: 'police', style: 'sedan', length: 4.9, width: 1.9, height: 1.48, wheelBase: 2.9, wheelRadius: 0.34, wheelWidth: 0.24, track: 1.62, clearance: 0.17, mass: 1750, engineForce: 8200, maxSpeed: 58, brakeForce: 55, grip: 3.0, steer: 0.55, drive: 'rwd', suspension: 0.22, stiffness: 34, health: 1500, colors: [0x101418], seats: [[0.4, 0.42, 0], [-0.4, 0.42, 0]], siren: true, value: 0, traffic: 0, gears: 5, engineTone: 0.85 }),
  D({ id: 'medic', name: 'Medic One', kind: 'car', cls: 'ambulance', style: 'box', length: 6.0, width: 2.15, height: 2.7, wheelBase: 3.6, wheelRadius: 0.4, wheelWidth: 0.26, track: 1.78, clearance: 0.24, mass: 3200, engineForce: 8000, maxSpeed: 42, brakeForce: 44, grip: 2.4, steer: 0.48, drive: 'rwd', suspension: 0.3, stiffness: 30, health: 1600, colors: [0xf4f4f4], seats: [[0.48, 0.85, 2.0], [-0.48, 0.85, 2.0]], siren: true, value: 0, traffic: 0.15, gears: 5, engineTone: 0.6 }),
  D({ id: 'coastliner', name: 'Coastliner', kind: 'car', cls: 'bus', style: 'bus', length: 11, width: 2.5, height: 3.1, wheelBase: 6.2, wheelRadius: 0.5, wheelWidth: 0.32, track: 2.1, clearance: 0.3, mass: 9500, engineForce: 21000, maxSpeed: 30, brakeForce: 120, grip: 2.4, steer: 0.55, drive: 'rwd', suspension: 0.3, stiffness: 40, health: 2600, colors: [0x2a8ad0, 0xe04a2a, 0x3ab06a], seats: [[0.7, 1.1, 4.6], [-0.6, 1.1, 2.0]], value: 0, traffic: 0.25, gears: 4, engineTone: 0.9 }),
  D({ id: 'enforcer', name: 'Enforcer', kind: 'car', cls: 'swat', style: 'box', length: 5.8, width: 2.3, height: 2.6, wheelBase: 3.5, wheelRadius: 0.45, wheelWidth: 0.32, track: 1.9, clearance: 0.3, mass: 4500, engineForce: 13000, maxSpeed: 44, brakeForce: 70, grip: 2.6, steer: 0.48, drive: 'awd', suspension: 0.3, stiffness: 36, health: 3500, colors: [0x1c2026], seats: [[0.5, 0.9, 1.8], [-0.5, 0.9, 1.8]], siren: true, armored: true, value: 0, traffic: 0, gears: 5, engineTone: 0.95 }),
  D({ id: 'wasp', name: 'Wasp 250', kind: 'bike', cls: 'bike', style: 'sportbike', length: 2.0, width: 0.7, height: 1.15, wheelBase: 1.35, wheelRadius: 0.3, wheelWidth: 0.14, track: 0.0, clearance: 0.2, mass: 220, engineForce: 2300, maxSpeed: 52, brakeForce: 14, grip: 2.8, steer: 0.45, drive: 'rwd', suspension: 0.2, stiffness: 30, health: 450, colors: [0xe02020, 0x20a0e0, 0xf0c020, 0x101010, 0x30e080], seats: [[0, 0.75, -0.2]], value: 4000, traffic: 0.35, gears: 6, engineTone: 0.2 }),
  D({ id: 'thunder', name: 'Thunder 900', kind: 'bike', cls: 'bike', style: 'cruiser', length: 2.3, width: 0.85, height: 1.15, wheelBase: 1.6, wheelRadius: 0.34, wheelWidth: 0.18, track: 0.0, clearance: 0.16, mass: 320, engineForce: 3000, maxSpeed: 50, brakeForce: 16, grip: 2.6, steer: 0.42, drive: 'rwd', suspension: 0.2, stiffness: 28, health: 550, colors: [0x101010, 0x6a1a1a, 0xd0d0d0, 0x1a2a4a], seats: [[0, 0.68, -0.3]], value: 9000, traffic: 0.25, gears: 5, engineTone: 0.9 }),
  D({ id: 'skiff', name: 'Skiff', kind: 'boat', cls: 'boat', style: 'skiff', length: 4.5, width: 1.9, height: 1.2, wheelBase: 0, wheelRadius: 0, wheelWidth: 0, track: 0, clearance: 0, mass: 650, engineForce: 5200, maxSpeed: 18, brakeForce: 0, grip: 0, steer: 0.6, drive: 'rwd', suspension: 0, stiffness: 0, health: 600, colors: [0xe8e8e8, 0x2a5a8a, 0xc83a2a], seats: [[0, 0.5, -1.2]], value: 6000, traffic: 0, gears: 1, engineTone: 0.3 }),
  D({ id: 'marlin', name: 'Marlin', kind: 'boat', cls: 'boat', style: 'speedboat', length: 7.5, width: 2.6, height: 1.6, wheelBase: 0, wheelRadius: 0, wheelWidth: 0, track: 0, clearance: 0, mass: 1500, engineForce: 19000, maxSpeed: 30, brakeForce: 0, grip: 0, steer: 0.5, drive: 'rwd', suspension: 0, stiffness: 0, health: 900, colors: [0xf4f4f4, 0x101010, 0xd02a2a, 0x1a3a8a], seats: [[0.5, 0.7, 0.2], [-0.5, 0.7, 0.2]], value: 40000, traffic: 0, gears: 1, engineTone: 0.7 }),
  D({ id: 'kestrel', name: 'Kestrel', kind: 'heli', cls: 'heli', style: 'heli', length: 9, width: 2.2, height: 2.8, wheelBase: 0, wheelRadius: 0, wheelWidth: 0, track: 0, clearance: 0, mass: 1600, engineForce: 0, maxSpeed: 55, brakeForce: 0, grip: 0, steer: 0, drive: 'rwd', suspension: 0, stiffness: 0, health: 1000, colors: [0x2a3a5a, 0xe8e8e8, 0xc83a2a], seats: [[0.45, 0.55, 1.0], [-0.45, 0.55, 1.0]], value: 150000, traffic: 0, gears: 1, engineTone: 0.5 }),
];

export const VEHICLE_BY_ID: Record<string, VehicleDef> = Object.fromEntries(VEHICLES.map((v) => [v.id, v]));

export function vehicleDef(id: string): VehicleDef {
  const d = VEHICLE_BY_ID[id];
  if (!d) throw new Error(`unknown vehicle ${id}`);
  return d;
}

/** Traffic pick lists per district group. */
export function trafficPool(district: string, night: boolean): { ids: string[]; weights: number[] } {
  const base = VEHICLES.filter((v) => v.traffic > 0 && v.kind !== 'boat' && v.kind !== 'heli');
  const mult = (v: VehicleDef): number => {
    let w = v.traffic;
    if (district === 'heights' || district === 'marina') w *= v.cls === 'suv' || v.cls === 'sports' || v.cls === 'super' ? 2 : v.cls === 'bus' || v.cls === 'van' ? 0.4 : 1;
    if (district === 'rustvale' || district === 'docks') w *= v.cls === 'compact' || v.cls === 'pickup' || v.cls === 'van' || v.cls === 'muscle' ? 1.8 : v.cls === 'super' ? 0.1 : 1;
    if (district === 'downtown' || district === 'midtown') w *= v.cls === 'taxi' || v.cls === 'bus' ? 2.2 : 1;
    if (district === 'velvet') w *= v.cls === 'sports' || v.cls === 'super' || v.cls === 'taxi' ? 2.5 : 1;
    if (district === 'desert' || district === 'dustwater') w *= v.cls === 'pickup' || v.cls === 'suv' || v.cls === 'muscle' ? 2.5 : v.cls === 'taxi' || v.cls === 'bus' ? 0.1 : 0.8;
    if (night && v.cls === 'bus') w *= 0.3;
    return w;
  };
  return { ids: base.map((v) => v.id), weights: base.map(mult) };
}
