import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { RAGDOLL_BONES, type CharacterRenderer, type RagdollPose } from './CharacterRenderer';
import { mulQ, rotate } from './rig/RigData';

/**
 * 11-body physical ragdoll built on the skeleton: pelvis, chest, head, upper/lower arms, thighs, calves.
 * Bodies start exactly at the bones' world transforms; elbows and knees are limited hinges, the rest
 * ball joints. The renderer drives those bones from the bodies; hands, feet and fingers follow.
 */

/** Parent body per ragdoll body (−1 = none). */
const PARENT = [-1, 0, 1, 1, 3, 1, 5, 0, 7, 0, 9];
/** Child bone whose origin ends each limb segment (for capsule length). */
const CHILD: Record<string, string> = { upperarm_l: 'lowerarm_l', lowerarm_l: 'hand_l', upperarm_r: 'lowerarm_r', lowerarm_r: 'hand_r', thigh_l: 'calf_l', calf_l: 'foot_l', thigh_r: 'calf_r', calf_r: 'foot_r' };
const HINGE = new Set(['lowerarm_l', 'lowerarm_r', 'calf_l', 'calf_r']);

const _p = new Float32Array(3);

export class Ragdoll {
  bodies: RAPIER.RigidBody[] = [];
  private joints: RAPIER.ImpulseJoint[] = [];
  readonly pose: RagdollPose = { p: new Float32Array(RAGDOLL_BONES.length * 3), q: new Float32Array(RAGDOLL_BONES.length * 4) };
  frozen = false;
  calm = 0;
  age = 0;
  owner: unknown;

  constructor(private physics: Physics, readonly slot: number, chars: CharacterRenderer, vel: THREE.Vector3, owner: unknown) {
    this.owner = owner;
    const w = physics.world;
    const rig = chars.rig;
    const pl = chars.placement(slot);
    const body = rig.bodies[pl.body]!;
    const s = pl.scale;
    const hy = Math.sin(pl.yaw / 2), hw = Math.cos(pl.yaw / 2);
    const idx = RAGDOLL_BONES.map((n) => rig.bone(n));
    // world transforms of the ragdoll bones from the last animated pose
    idx.forEach((b, k) => {
      const m = pl.model;
      mulQ(0, hy, 0, hw, m.q[b * 4]!, m.q[b * 4 + 1]!, m.q[b * 4 + 2]!, m.q[b * 4 + 3]!, this.pose.q, k * 4);
      rotate(0, hy, 0, hw, m.p[b * 3]! * s, m.p[b * 3 + 1]! * s, m.p[b * 3 + 2]! * s, _p, 0);
      this.pose.p[k * 3] = _p[0]! + pl.x;
      this.pose.p[k * 3 + 1] = _p[1]! + pl.y;
      this.pose.p[k * 3 + 2] = _p[2]! + pl.z;
    });
    const restLen = (child: string): number => {
      const c = rig.bone(child);
      return Math.hypot(body.restT[c * 3]!, body.restT[c * 3 + 1]!, body.restT[c * 3 + 2]!) * s;
    };
    RAGDOLL_BONES.forEach((name, k) => {
      const p = this.pose.p, q = this.pose.q;
      const rb = w.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic()
          .setTranslation(p[k * 3]!, p[k * 3 + 1]!, p[k * 3 + 2]!)
          .setRotation({ x: q[k * 4]!, y: q[k * 4 + 1]!, z: q[k * 4 + 2]!, w: q[k * 4 + 3]! })
          .setLinvel(vel.x, vel.y, vel.z)
          .setLinearDamping(0.15)
          .setAngularDamping(1.8)
          .setCcdEnabled(k < 2),
      );
      let desc: RAPIER.ColliderDesc;
      let density = 900;
      if (name === 'pelvis') desc = RAPIER.ColliderDesc.cuboid(0.14 * s, 0.09 * s, 0.1 * s);
      else if (name === 'spine_02') {
        desc = RAPIER.ColliderDesc.capsule(0.12 * s, 0.13 * s).setTranslation(0, 0.12 * s, 0);
        density = 700;
      } else if (name === 'Head') {
        desc = RAPIER.ColliderDesc.ball(0.11 * s).setTranslation(0, 0.1 * s, 0.02 * s);
        density = 600;
      } else {
        const len = restLen(CHILD[name]!) + (name.startsWith('lowerarm') ? 0.07 * s : name.startsWith('calf') ? 0.05 * s : 0);
        const r = (name.startsWith('upperarm') ? 0.05 : name.startsWith('lowerarm') ? 0.042 : name.startsWith('thigh') ? 0.075 : 0.058) * s;
        desc = RAPIER.ColliderDesc.capsule(Math.max(0.02, len / 2 - r), r).setTranslation(0, len / 2, 0);
        density = name.startsWith('thigh') || name.startsWith('calf') ? 950 : 700;
      }
      const c = w.createCollider(desc.setDensity(density).setCollisionGroups(GROUPS.ragdoll).setFriction(0.9).setRestitution(0.05), rb);
      physics.setOwner(c, { kind: 'ragdoll', ref: owner, part: k });
      this.bodies.push(rb);
    });
    // joints: anchor at the child's origin, expressed in the parent body's frame
    RAGDOLL_BONES.forEach((name, k) => {
      const pk = PARENT[k]!;
      if (pk < 0) return;
      const P = this.pose.p, Q = this.pose.q;
      rotate(-Q[pk * 4]!, -Q[pk * 4 + 1]!, -Q[pk * 4 + 2]!, Q[pk * 4 + 3]!, P[k * 3]! - P[pk * 3]!, P[k * 3 + 1]! - P[pk * 3 + 1]!, P[k * 3 + 2]! - P[pk * 3 + 2]!, _p, 0);
      const a1 = { x: _p[0]!, y: _p[1]!, z: _p[2]! }, a2 = { x: 0, y: 0, z: 0 };
      let j: RAPIER.ImpulseJoint;
      if (HINGE.has(name)) {
        j = w.createImpulseJoint(RAPIER.JointData.revolute(a1, a2, { x: 1, y: 0, z: 0 }), this.bodies[pk]!, this.bodies[k]!, true);
        (j as RAPIER.RevoluteImpulseJoint).setLimits(-0.05, name.startsWith('calf') ? 2.3 : 2.5);
      } else j = w.createImpulseJoint(RAPIER.JointData.spherical(a1, a2), this.bodies[pk]!, this.bodies[k]!, true);
      j.setContactsEnabled(false);
      this.joints.push(j);
    });
    this.read();
  }

  /** Apply an impulse to a body part (e.g. bullet hit). Part 1 = chest, 2 = head. */
  impulse(part: number, x: number, y: number, z: number): void {
    this.bodies[Math.max(0, Math.min(this.bodies.length - 1, part))]?.applyImpulse({ x, y, z }, true);
  }

  read(): void {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i]!;
      const t = b.translation(), r = b.rotation();
      this.pose.p[i * 3] = t.x; this.pose.p[i * 3 + 1] = t.y; this.pose.p[i * 3 + 2] = t.z;
      this.pose.q[i * 4] = r.x; this.pose.q[i * 4 + 1] = r.y; this.pose.q[i * 4 + 2] = r.z; this.pose.q[i * 4 + 3] = r.w;
    }
  }

  /** Pelvis world position. */
  position(out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.pose.p[0]!, this.pose.p[1]!, this.pose.p[2]!);
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
  private readonly fixed: Uint8Array;
  private readonly boneIdx: number[];
  constructor(private physics: Physics, private chars: CharacterRenderer, private maxActive = 6) {
    this.boneIdx = RAGDOLL_BONES.map((n) => chars.rig.bone(n));
    this.fixed = new Uint8Array(chars.rig.boneNames.length);
    for (const b of this.boneIdx) this.fixed[b] = 1;
  }

  spawn(slot: number, vel: THREE.Vector3, owner: unknown): Ragdoll {
    this.remove(slot);
    const active = this.list.filter((r) => !r.frozen);
    if (active.length >= this.maxActive) active[0]!.freeze();
    const r = new Ragdoll(this.physics, slot, this.chars, vel, owner);
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
      this.chars.updateRagdoll(r.slot, r.pose, this.fixed, this.boneIdx);
    }
  }
}
