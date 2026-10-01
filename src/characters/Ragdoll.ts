import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import type { CharacterRenderer, HeldItem } from './CharacterRenderer';
import { SK } from './CharacterRenderer';
import { makePose } from './Pose';

/**
 * 7-body physical ragdoll: pelvis, torso, head, 2 arms, 2 legs (spherical joints).
 * Body frames coincide with CharacterRenderer joint frames so matrices map 1:1.
 */
export class Ragdoll {
  bodies: RAPIER.RigidBody[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  readonly mats: THREE.Matrix4[] = Array.from({ length: 7 }, () => new THREE.Matrix4());
  frozen = false;
  calm = 0;
  age = 0;
  owner: unknown;

  constructor(private physics: Physics, readonly slot: number, frames: THREE.Matrix4[], vel: THREE.Vector3, owner: unknown) {
    this.owner = owner;
    const w = physics.world;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    const mk = (i: number, desc: RAPIER.ColliderDesc, density: number): RAPIER.RigidBody => {
      frames[i]!.decompose(p, q, s);
      const b = w.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p.x, p.y, p.z)
          .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
          .setLinvel(vel.x, vel.y, vel.z)
          .setLinearDamping(0.15)
          .setAngularDamping(1.6)
          .setCcdEnabled(i < 2),
      );
      const c = w.createCollider(desc.setDensity(density).setCollisionGroups(GROUPS.ragdoll).setFriction(0.9).setRestitution(0.05), b);
      physics.setOwner(c, { kind: 'ragdoll', ref: owner, part: i });
      this.bodies.push(b);
      return b;
    };
    const pelvis = mk(0, RAPIER.ColliderDesc.cuboid(0.16, 0.1, 0.1).setTranslation(0, -0.04, 0), 900);
    const torso = mk(1, RAPIER.ColliderDesc.capsule(0.13, 0.15).setTranslation(0, 0.27, 0), 700);
    const head = mk(2, RAPIER.ColliderDesc.ball(0.12).setTranslation(0, SK.headY, 0), 600);
    const armL = mk(3, RAPIER.ColliderDesc.capsule(0.22, 0.05).setTranslation(0, -0.27, 0), 700);
    const armR = mk(4, RAPIER.ColliderDesc.capsule(0.22, 0.05).setTranslation(0, -0.27, 0), 700);
    const legL = mk(5, RAPIER.ColliderDesc.capsule(0.36, 0.075).setTranslation(0, -0.44, 0), 900);
    const legR = mk(6, RAPIER.ColliderDesc.capsule(0.36, 0.075).setTranslation(0, -0.44, 0), 900);
    const J = (a: RAPIER.RigidBody, b: RAPIER.RigidBody, ax: number, ay: number, az: number): void => {
      // anchor in body a's frame; body b's origin is the joint
      this.joints.push(w.createImpulseJoint(RAPIER.JointData.spherical({ x: ax, y: ay, z: az }, { x: 0, y: 0, z: 0 }), a, b, true));
    };
    J(pelvis, torso, 0, SK.spineUp, 0);
    J(torso, head, 0, SK.torsoH, 0);
    J(torso, armL, SK.shoulderX, SK.shoulderY, 0);
    J(torso, armR, -SK.shoulderX, SK.shoulderY, 0);
    J(pelvis, legL, SK.hipX, SK.hipY, 0);
    J(pelvis, legR, -SK.hipX, SK.hipY, 0);
    this.read();
  }

  /** Apply an impulse to a body part (e.g. bullet hit). */
  impulse(part: number, x: number, y: number, z: number): void {
    this.bodies[Math.max(0, Math.min(6, part))]?.applyImpulse({ x, y, z }, true);
  }

  read(): void {
    for (let i = 0; i < 7; i++) {
      const b = this.bodies[i]!;
      const t = b.translation(), r = b.rotation();
      this.mats[i]!.compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
    }
  }

  /** Pelvis world position. */
  position(out: THREE.Vector3): THREE.Vector3 {
    return out.setFromMatrixPosition(this.mats[0]!);
  }

  update(dt: number): void {
    if (this.frozen) return;
    this.age += dt;
    this.read();
    let maxV = 0;
    for (const b of this.bodies) {
      const v = b.linvel();
      maxV = Math.max(maxV, Math.hypot(v.x, v.y, v.z));
    }
    if (maxV < 0.25) this.calm += dt;
    else this.calm = 0;
  }

  /** Remove physics bodies but keep the last pose. */
  freeze(): void {
    if (this.frozen) return;
    this.read();
    for (const j of this.joints) this.physics.world.removeImpulseJoint(j, true);
    for (const b of this.bodies) this.physics.removeBody(b);
    this.joints = [];
    this.bodies = [];
    this.frozen = true;
  }

  dispose(): void {
    if (!this.frozen) this.freeze();
  }
}

/** Manages active ragdolls (max N simulated; oldest frozen first). */
export class RagdollSystem {
  readonly list: Ragdoll[] = [];
  private readonly idle = makePose();
  constructor(private physics: Physics, private chars: CharacterRenderer, private maxActive = 6) {}

  spawn(slot: number, vel: THREE.Vector3, owner: unknown): Ragdoll {
    this.remove(slot);
    const active = this.list.filter((r) => !r.frozen);
    if (active.length >= this.maxActive) active[0]!.freeze();
    const r = new Ragdoll(this.physics, slot, this.chars.framesOf(slot), vel, owner);
    this.list.push(r);
    return r;
  }

  remove(slot: number): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i]!.slot === slot) {
        this.list[i]!.dispose();
        this.list.splice(i, 1);
      }
    }
  }

  of(slot: number): Ragdoll | undefined {
    return this.list.find((r) => r.slot === slot);
  }

  update(dt: number): void {
    for (const r of this.list) {
      r.update(dt);
      if (!r.frozen && (r.calm > 1.5 || r.age > 12)) r.freeze();
      this.chars.update(r.slot, 0, 0, 0, 0, this.idle, 'none' as HeldItem, r.mats);
    }
  }
}
