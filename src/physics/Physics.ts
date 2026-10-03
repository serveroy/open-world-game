import RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS } from './groups';

export type OwnerKind = 'static' | 'player' | 'ped' | 'vehicle' | 'prop' | 'ragdoll' | 'projectile' | 'sensor';
export interface Owner {
  kind: OwnerKind;
  ref: unknown;
  /** Optional sub-part identifier, e.g. ragdoll limb or vehicle tire index. */
  part?: number;
}

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  distance: number;
  collider: RAPIER.Collider;
  owner: Owner | undefined;
}

export interface ContactForce {
  a: Owner | undefined;
  b: Owner | undefined;
  force: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  colliderA: RAPIER.Collider;
  colliderB: RAPIER.Collider;
}

/** Thin wrapper around a Rapier world with owner lookup and convenience queries. */
export class Physics {
  readonly world: RAPIER.World;
  readonly events: RAPIER.EventQueue;
  private owners = new Map<number, Owner>();
  private ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  readonly contactListeners: ((c: ContactForce) => void)[] = [];
  readonly fixedDt = 1 / 60;

  constructor() {
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.world.timestep = this.fixedDt;
    this.world.integrationParameters.numSolverIterations = 4;
    this.events = new RAPIER.EventQueue(true);
  }

  step(): void {
    this.world.step(this.events);
    if (this.contactListeners.length === 0) {
      this.events.clear();
      return;
    }
    this.events.drainContactForceEvents((ev) => {
      const c1 = this.world.getCollider(ev.collider1());
      const c2 = this.world.getCollider(ev.collider2());
      if (!c1 || !c2) return;
      const d = ev.maxForceDirection();
      const cf: ContactForce = {
        a: this.owners.get(c1.handle),
        b: this.owners.get(c2.handle),
        force: ev.maxForceMagnitude(),
        dirX: d.x, dirY: d.y, dirZ: d.z,
        colliderA: c1,
        colliderB: c2,
      };
      for (const l of this.contactListeners) l(cf);
    });
    this.events.drainCollisionEvents(() => undefined);
  }

  setOwner(c: RAPIER.Collider, owner: Owner): void {
    this.owners.set(c.handle, owner);
  }
  ownerOf(c: RAPIER.Collider | null | undefined): Owner | undefined {
    return c ? this.owners.get(c.handle) : undefined;
  }
  removeCollider(c: RAPIER.Collider): void {
    this.owners.delete(c.handle);
    this.world.removeCollider(c, false);
  }
  removeBody(b: RAPIER.RigidBody): void {
    const n = b.numColliders();
    for (let i = 0; i < n; i++) this.owners.delete(b.collider(i).handle);
    this.world.removeRigidBody(b);
  }

  /** Cast a ray; dir need not be normalised (it is normalised here). */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
    filterGroups: number = GROUPS.rayWorld,
    excludeBody?: RAPIER.RigidBody,
    predicate?: (c: RAPIER.Collider) => boolean,
  ): RayHit | null {
    const len = Math.hypot(dx, dy, dz) || 1;
    const r = this.ray;
    r.origin.x = ox; r.origin.y = oy; r.origin.z = oz;
    r.dir.x = dx / len; r.dir.y = dy / len; r.dir.z = dz / len;
    const hit = this.world.castRayAndGetNormal(r, maxDist, true, undefined, filterGroups, undefined, excludeBody, predicate);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return {
      x: ox + r.dir.x * t, y: oy + r.dir.y * t, z: oz + r.dir.z * t,
      nx: hit.normal.x, ny: hit.normal.y, nz: hit.normal.z,
      distance: t,
      collider: hit.collider,
      owner: this.owners.get(hit.collider.handle),
    };
  }

  /** Ground height under (x,z) by downward ray from `fromY`. Returns -Infinity if none. */
  groundY(x: number, z: number, fromY = 200, filter: number = GROUPS.rayWorld): number {
    const h = this.raycast(x, fromY, z, 0, -1, 0, fromY + 100, filter);
    return h ? h.y : -Infinity;
  }

  /** Line-of-sight test against static geometry (and optionally vehicles). */
  lineOfSight(ax: number, ay: number, az: number, bx: number, by: number, bz: number, includeVehicles = false): boolean {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const d = Math.hypot(dx, dy, dz);
    if (d < 0.01) return true;
    const h = this.raycast(ax, ay, az, dx, dy, dz, d - 0.05, includeVehicles ? GROUPS.rayWorldVehicles : GROUPS.rayWorld);
    return h === null;
  }

  /** Collect owners of colliders intersecting a sphere. */
  overlapSphere(x: number, y: number, z: number, r: number, filterGroups: number, out: Owner[] = []): Owner[] {
    const shape = new RAPIER.Ball(r);
    this.world.intersectionsWithShape({ x, y, z }, { x: 0, y: 0, z: 0, w: 1 }, shape, (c) => {
      const o = this.owners.get(c.handle);
      if (o && !out.includes(o)) out.push(o);
      return true;
    }, undefined, filterGroups);
    return out;
  }

  /** Static cuboid helper (rotation around Y only). */
  addStaticBox(x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0, owner: Owner = { kind: 'static', ref: null }): RAPIER.Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setCollisionGroups(GROUPS.static)
      .setFriction(0.8);
    if (yaw !== 0) {
      const s = Math.sin(yaw / 2), c = Math.cos(yaw / 2);
      desc.setRotation({ x: 0, y: s, z: 0, w: c });
    }
    const col = this.world.createCollider(desc);
    this.owners.set(col.handle, owner);
    return col;
  }
}

export { RAPIER };
