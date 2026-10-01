/** Rapier interaction-group helpers. groups = (membership << 16) | filter. */
export const G = {
  STATIC: 1 << 0,
  PLAYER: 1 << 1,
  PED: 1 << 2,
  VEHICLE: 1 << 3,
  PROP: 1 << 4,
  RAGDOLL: 1 << 5,
  PROJECTILE: 1 << 6,
  SENSOR: 1 << 7,
  WATER: 1 << 8,
} as const;

export const ALL = 0xffff;

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16) | (filter & 0xffff);
}

export const GROUPS = {
  static: groups(G.STATIC, ALL & ~G.STATIC),
  player: groups(G.PLAYER, G.STATIC | G.PROP | G.SENSOR),
  ped: groups(G.PED, G.STATIC | G.PROP),
  vehicle: groups(G.VEHICLE, G.STATIC | G.VEHICLE | G.PROP | G.RAGDOLL | G.PROJECTILE | G.SENSOR),
  prop: groups(G.PROP, ALL),
  ragdoll: groups(G.RAGDOLL, G.STATIC | G.VEHICLE | G.PROP),
  projectile: groups(G.PROJECTILE, G.STATIC | G.VEHICLE | G.PROP),
  sensor: groups(G.SENSOR, G.PLAYER | G.VEHICLE),
  /** Ray filters */
  rayWorld: groups(ALL, G.STATIC),
  rayWorldVehicles: groups(ALL, G.STATIC | G.VEHICLE),
  rayBullets: groups(ALL, G.STATIC | G.VEHICLE | G.PED | G.PLAYER | G.PROP | G.RAGDOLL),
  rayCamera: groups(ALL, G.STATIC),
  /** Character controllers move against these */
  kccPlayer: groups(ALL, G.STATIC | G.VEHICLE | G.PROP | G.PED),
  kccPed: groups(ALL, G.STATIC | G.VEHICLE | G.PROP),
  /** Note: player/ped colliders don't generate contacts with vehicles; car-vs-human hits are
   *  resolved by proximity queries (knockdown/ragdoll), so cars never stop dead on a capsule. */
  /** vehicle wheel rays */
  wheels: groups(ALL, G.STATIC | G.PROP),
} as const;
