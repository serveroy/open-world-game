/** Typed game event map for the global EventBus. */
export type CrimeType =
  | 'assault' | 'theft' | 'carjack' | 'shooting' | 'murder' | 'copAssault' | 'copMurder'
  | 'explosion' | 'vehicleDamage' | 'stealPolice' | 'trespass' | 'alarm' | 'hitAndRun' | 'reported';

export interface GameEvents {
  appHidden: Record<string, never>;
  crime: { type: CrimeType; x: number; z: number; witnessed: boolean; byCop: boolean };
  shot: { x: number; y: number; z: number; weapon: string; byPlayer: boolean; silenced?: boolean };
  explosion: { x: number; y: number; z: number; radius: number; byPlayer: boolean };
  pedKilled: { ped: unknown; byPlayer: boolean; cop: boolean; x: number; z: number; weapon: string };
  pedHurt: { ped: unknown; byPlayer: boolean; cop: boolean };
  vehicleDestroyed: { vehicle: unknown; byPlayer: boolean };
  vehicleEntered: { vehicle: unknown; stolen: boolean };
  vehicleExited: { vehicle: unknown };
  playerDied: { cause: string };
  playerBusted: Record<string, never>;
  playerRespawned: { where: 'hospital' | 'police' | 'safehouse' | 'checkpoint' };
  cashChanged: { amount: number; delta: number };
  missionStarted: { id: string };
  missionPassed: { id: string; reward: number };
  missionFailed: { id: string; reason: string };
  wantedChanged: { stars: number; prev: number };
  zoneEntered: { id: string; name: string };
  pickup: { kind: string; amount: number };
  saveRequested: { reason: string };
  noise: { x: number; z: number; radius: number; kind: 'gunshot' | 'explosion' | 'alarm' | 'horn' | 'scream' };
}
