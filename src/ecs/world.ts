import { World } from 'miniplex';
import type { Vehicle } from '../vehicles/Vehicle';
import type { Ped } from '../peds/Ped';

/**
 * Shared entity index (miniplex). Simulation lives in explicit system classes; every spawned
 * vehicle and pedestrian is also registered here so systems can run cheap archetype queries
 * (e.g. "all vehicles", "all armed hostiles") without importing each other's managers.
 */
export interface Entity {
  vehicle?: Vehicle;
  ped?: Ped;
  /** Hostile toward the player (gangs, rampage targets, armed mission enemies). */
  hostile?: true;
  /** Siren running (police/emergency) — maintained by VehicleManager. */
  siren?: true;
}

export const ecs = new World<Entity>();
export const vehiclesQ = ecs.with('vehicle');
export const pedsQ = ecs.with('ped');
export const sirensQ = ecs.with('vehicle', 'siren');

const byVehicle = new Map<Vehicle, Entity>();
const byPed = new Map<Ped, Entity>();

export function registerVehicle(v: Vehicle): void {
  if (byVehicle.has(v)) return;
  byVehicle.set(v, ecs.add({ vehicle: v }));
}
export function unregisterVehicle(v: Vehicle): void {
  const e = byVehicle.get(v);
  if (!e) return;
  ecs.remove(e);
  byVehicle.delete(v);
}
export function registerPed(p: Ped): void {
  if (byPed.has(p)) return;
  byPed.set(p, ecs.add({ ped: p }));
}
export function unregisterPed(p: Ped): void {
  const e = byPed.get(p);
  if (!e) return;
  ecs.remove(e);
  byPed.delete(p);
}

/** Keep tag components in sync with entity state (call once per frame). */
export function syncTags(): void {
  for (const [v, e] of byVehicle) {
    if (v.siren && !e.siren) ecs.addComponent(e, 'siren', true);
    else if (!v.siren && e.siren) ecs.removeComponent(e, 'siren');
  }
  for (const [p, e] of byPed) {
    const h = p.hostile && p.alive;
    if (h && !e.hostile) ecs.addComponent(e, 'hostile', true);
    else if (!h && e.hostile) ecs.removeComponent(e, 'hostile');
  }
}
