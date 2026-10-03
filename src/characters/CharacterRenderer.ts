import * as THREE from 'three';
import type { AnimState, Pose } from './Pose';
import type { Appearance } from './Appearance';
import type { RigData } from './rig/RigData';
import { LocalPose, ModelPose, boneWorld, forwardKinematics, writeSkin } from './rig/PoseEval';
import { AnimController, AnimLibrary, type AnimStyle } from './rig/AnimGraph';
import { HAIR_IDS, HAT_IDS, ITEM_IDS, OUTER_IDS } from './rig/regions';
import { SkinnedCrowd, type InstanceLook } from './SkinnedCrowd';

/** Items a character can hold in the right hand. */
export type HeldItem = 'none' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'bat' | 'knife' | 'grenade' | 'molotov' | 'phone' | 'lockpick' | 'baton';

/** Joint ids for world-position lookups. */
export const enum Joint {
  Pelvis = 0,
  Chest = 1,
  Head = 2,
  RHand = 3,
  LHand = 4,
  RFoot = 5,
  LFoot = 6,
  Muzzle = 7,
}

/** Bones simulated by the ragdoll, in body-part order (part 1 = torso, 2 = head, as used by combat). */
export const RAGDOLL_BONES = ['pelvis', 'spine_02', 'Head', 'upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r', 'thigh_l', 'calf_l', 'thigh_r', 'calf_r'] as const;

/** World transform of each ragdoll bone (position + quaternion), refreshed by the physics ragdoll. */
export interface RagdollPose {
  p: Float32Array; // n × 3
  q: Float32Array; // n × 4
}

interface Slot {
  used: boolean;
  app: Appearance;
  body: number;
  scale: number;
  ctrl: AnimController;
  local: LocalPose;
  model: ModelPose;
  joints: THREE.Vector3[];
  x: number;
  y: number;
  z: number;
  yaw: number;
  frame: number;
  /** Frame of the last full pose evaluation (animation LOD). */
  evalFrame: number;
  posed: boolean;
}

const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _pm = new THREE.Matrix4();
const _o = { x: 0, y: 0, z: 0 };
const _c = new THREE.Color();

/** Muzzle distance along the barrel per held item (metres from the grip). */
const MUZZLE: Partial<Record<HeldItem, number>> = { sniper: 0.82, rifle: 0.56, shotgun: 0.56, smg: 0.36 };

/**
 * All humanoids: motion-captured skeletal animation (Quaternius Universal Animation Library, CC0) on
 * GPU-skinned, instanced bodies. Each character occupies a slot; call `update(slot, …)` each frame,
 * then `commit()` once.
 */
export class CharacterRenderer {
  readonly crowd: SkinnedCrowd;
  readonly lib: AnimLibrary;
  private slots: Slot[] = [];
  private frameNo = 0;
  private dt = 1 / 60;
  private readonly nb: number;
  private readonly b: Record<'pelvis' | 'chest' | 'head' | 'handR' | 'handL' | 'footR' | 'footL', number>;
  /** Characters posed / drawn last frame (perf overlay). */
  stats = { posed: 0, drawn: 0 };

  constructor(scene: THREE.Scene, readonly capacity: number, castShadow: boolean, readonly rig: RigData, private camera: THREE.Camera) {
    this.crowd = new SkinnedCrowd(scene, rig, capacity, castShadow);
    this.lib = new AnimLibrary(rig);
    this.nb = rig.boneNames.length;
    this.b = {
      pelvis: rig.bone('pelvis'), chest: rig.bone('spine_03'), head: rig.bone('Head'),
      handR: rig.bone('hand_r'), handL: rig.bone('hand_l'), footR: rig.bone('foot_r'), footL: rig.bone('foot_l'),
    };
  }

  get group(): THREE.Group {
    return this.crowd.group;
  }

  setShadows(on: boolean): void {
    this.crowd.setShadows(on);
  }

  /** Call once per rendered frame before characters are updated. */
  beginFrame(dt: number): void {
    this.frameNo++;
    this.dt = Math.min(0.1, Math.max(0, dt));
    const cam = this.camera;
    cam.updateMatrixWorld();
    _pm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_pm);
    this.stats.posed = 0;
  }

  alloc(app: Appearance): number {
    let i = this.slots.findIndex((s) => !s.used);
    if (i < 0) {
      if (this.slots.length >= this.capacity) return -1;
      i = this.slots.length;
      this.slots.push({
        used: false, app, body: 0, scale: 1, ctrl: new AnimController(this.lib), local: new LocalPose(this.nb), model: new ModelPose(this.nb),
        joints: Array.from({ length: 8 }, () => new THREE.Vector3()), x: 0, y: 0, z: 0, yaw: 0, frame: -1, evalFrame: -1, posed: false,
      });
    }
    const s = this.slots[i]!;
    s.used = true;
    s.posed = false;
    s.frame = s.evalFrame = -1;
    s.ctrl = new AnimController(this.lib);
    this.setAppearance(i, app);
    this.crowd.setItem(i, 0);
    this.crowd.setVisible(i, false);
    return i;
  }

  free(slot: number): void {
    const s = this.slots[slot];
    if (!s) return;
    s.used = false;
    this.crowd.setVisible(slot, false);
  }

  get used(): number {
    let n = 0;
    for (const s of this.slots) if (s.used) n++;
    return n;
  }

  setAppearance(slot: number, app: Appearance): void {
    const s = this.slots[slot]!;
    s.app = app;
    s.body = app.female ? 1 : 0;
    s.scale = app.height;
    this.crowd.setBody(slot, s.body);
    this.crowd.setLook(slot, lookOf(app));
    s.ctrl.style = { gait: app.top === 'suit' ? 'formal' : 'normal', folded: false };
  }

  /** Body-language variety (gait, idle) for a slot. */
  setStyle(slot: number, style: AnimStyle): void {
    this.slots[slot]!.ctrl.style = style;
  }

  hide(slot: number): void {
    this.crowd.setVisible(slot, false);
  }

  jointWorld(slot: number, j: Joint): THREE.Vector3 {
    return this.slots[slot]!.joints[j]!;
  }

  /** Model-space pose of a slot (bone transforms before placement), for ragdoll spawning. */
  placement(slot: number): { model: ModelPose; local: LocalPose; x: number; y: number; z: number; yaw: number; scale: number; body: number } {
    const s = this.slots[slot]!;
    return { model: s.model, local: s.local, x: s.x, y: s.y, z: s.z, yaw: s.yaw, scale: s.scale, body: s.body };
  }

  /**
   * Pose a character. `anim` drives clip-based animation; without it the procedural `pose` is
   * retargeted onto the skeleton. `yaw` 0 faces +Z.
   */
  update(slot: number, x: number, y: number, z: number, yaw: number, pose: Pose, held: HeldItem, anim?: AnimState | null): void {
    const s = this.slots[slot];
    if (!s || !s.used) return;
    s.x = x; s.y = y; s.z = z; s.yaw = yaw;
    this.crowd.setItem(slot, ITEM_IDS[held]);
    const first = s.frame !== this.frameNo;
    s.frame = this.frameNo;
    if (anim && first) s.ctrl.update(anim, this.dt);
    const sc = s.scale;
    _sphere.center.set(x, y + 0.9 * sc, z);
    _sphere.radius = 1.3 * sc;
    const inView = _frustum.intersectsSphere(_sphere);
    if (!inView) {
      // off-screen: keep gameplay joints plausible without evaluating the skeleton
      this.crowd.setVisible(slot, false);
      if (!s.posed) this.approxJoints(s);
      else this.fillJoints(s, held);
      return;
    }
    // animation LOD: distant characters re-evaluate every other frame (placement still updates)
    const cam = this.camera.position;
    const far = (x - cam.x) ** 2 + (z - cam.z) ** 2 > 55 * 55;
    if (!far || !s.posed || this.frameNo - s.evalFrame >= 2 || !first) {
      if (anim) s.ctrl.evaluate(anim, s.local);
      else this.lib.proc.apply(pose, s.local);
      forwardKinematics(this.rig, this.rig.bodies[s.body]!, s.local, s.model, anim ? s.ctrl.pre : null);
      s.evalFrame = this.frameNo;
      s.posed = true;
      this.stats.posed++;
    }
    writeSkin(this.rig.bodies[s.body]!, s.model, x, y, z, yaw, sc, this.crowd.poseData, this.crowd.rowOffset(slot));
    this.crowd.setVisible(slot, true);
    this.fillJoints(s, held);
  }

  /** Render a ragdoll: physics-driven bones in world space, the rest follow their last local pose. */
  updateRagdoll(slot: number, rd: RagdollPose, fixed: Uint8Array, boneIdx: number[]): void {
    const s = this.slots[slot];
    if (!s || !s.used) return;
    const m = s.model, inv = 1 / s.scale;
    for (let k = 0; k < boneIdx.length; k++) {
      const b = boneIdx[k]!;
      m.q.set(rd.q.subarray(k * 4, k * 4 + 4), b * 4);
      m.p[b * 3] = rd.p[k * 3]! * inv;
      m.p[b * 3 + 1] = rd.p[k * 3 + 1]! * inv;
      m.p[b * 3 + 2] = rd.p[k * 3 + 2]! * inv;
    }
    // root (unused by the mesh) sits under the pelvis so FK of non-driven children stays sane
    forwardKinematics(this.rig, this.rig.bodies[s.body]!, s.local, m, null, fixed);
    s.x = rd.p[0]!; s.y = rd.p[1]!; s.z = rd.p[2]!;
    s.yaw = 0;
    _sphere.center.set(s.x, s.y, s.z);
    _sphere.radius = 1.6 * s.scale;
    if (!_frustum.intersectsSphere(_sphere)) {
      this.crowd.setVisible(slot, false);
      return;
    }
    writeSkin(this.rig.bodies[s.body]!, m, 0, 0, 0, 0, s.scale, this.crowd.poseData, this.crowd.rowOffset(slot));
    this.crowd.setVisible(slot, true);
    // joints in world space (identity placement, model positions are world / scale)
    const J = s.joints, b = this.b, sc = s.scale;
    const wp = (bone: number, out: THREE.Vector3, ox = 0, oy = 0, oz = 0): void => {
      boneWorld(m, bone, 0, 0, 0, 0, sc, _o, ox, oy, oz);
      out.set(_o.x, _o.y, _o.z);
    };
    wp(b.pelvis, J[Joint.Pelvis]!);
    wp(b.chest, J[Joint.Chest]!, 0, 0.1, 0);
    wp(b.head, J[Joint.Head]!, 0, 0.1, 0);
    wp(b.handR, J[Joint.RHand]!, 0, 0.08, 0);
    wp(b.handL, J[Joint.LHand]!, 0, 0.08, 0);
    wp(b.footR, J[Joint.RFoot]!);
    wp(b.footL, J[Joint.LFoot]!);
    J[Joint.Muzzle]!.copy(J[Joint.RHand]!);
  }

  private fillJoints(s: Slot, held: HeldItem): void {
    const J = s.joints, m = s.model, b = this.b, sc = s.scale;
    const wp = (bone: number, out: THREE.Vector3, ox = 0, oy = 0, oz = 0): void => {
      boneWorld(m, bone, s.x, s.y, s.z, s.yaw, sc, _o, ox, oy, oz);
      out.set(_o.x, _o.y, _o.z);
    };
    wp(b.pelvis, J[Joint.Pelvis]!);
    wp(b.chest, J[Joint.Chest]!, 0, 0.1, 0);
    wp(b.head, J[Joint.Head]!, 0, 0.1, 0.02);
    wp(b.handR, J[Joint.RHand]!, 0, 0.08, 0);
    wp(b.handL, J[Joint.LHand]!, 0, 0.08, 0);
    wp(b.footR, J[Joint.RFoot]!);
    wp(b.footL, J[Joint.LFoot]!);
    // muzzle: along the fingers from the grip (see Outfits.addItems: barrel = hand +Y, up = hand +Z)
    const len = MUZZLE[held] ?? 0.16;
    wp(b.handR, J[Joint.Muzzle]!, -0.028 + 0, 0.075 + len, 0.04);
  }

  private approxJoints(s: Slot): void {
    const J = s.joints, sc = s.scale;
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    J[Joint.Pelvis]!.set(s.x, s.y + 0.95 * sc, s.z);
    J[Joint.Chest]!.set(s.x, s.y + 1.4 * sc, s.z);
    J[Joint.Head]!.set(s.x, s.y + 1.68 * sc, s.z);
    J[Joint.RHand]!.set(s.x - fz * 0.25 + fx * 0.2, s.y + 1.1 * sc, s.z + fx * 0.25 + fz * 0.2);
    J[Joint.LHand]!.set(s.x + fz * 0.25, s.y + 1.0 * sc, s.z - fx * 0.25);
    J[Joint.RFoot]!.set(s.x - fz * 0.1, s.y + 0.08, s.z + fx * 0.1);
    J[Joint.LFoot]!.set(s.x + fz * 0.1, s.y + 0.08, s.z - fx * 0.1);
    J[Joint.Muzzle]!.set(s.x + fx * 0.6, s.y + 1.35 * sc, s.z + fz * 0.6);
  }

  commit(): void {
    let high = 0;
    for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i]!.used) {
      high = i + 1;
      break;
    }
    this.crowd.commit(high);
    this.stats.drawn = this.crowd.drawn;
  }
}

const hex = (c: number): number => _c.setHex(c).getHex();

/** Appearance → per-instance shader parameters. */
export function lookOf(app: Appearance): InstanceLook {
  const covered = app.top === 'long' || app.top === 'jacket' || app.top === 'suit';
  const hatHidesHair = app.hat === 'helmet' || (app.hat !== 'none' && (app.hairStyle === 'afro' || app.hairStyle === 'mohawk' || app.hairStyle === 'bun'));
  const hair = hatHidesHair ? (app.hat === 'helmet' ? 'none' : 'short') : app.hairStyle;
  const tattoo = { none: 0, tribal: 1, sleeve: 2, neck: 3, full: 4 }[app.tattoo];
  const flags = (app.beard === 'stubble' ? 1 : 0) | (hair !== 'none' ? 2 : 0) | (hair === 'mohawk' ? 4 : 0) | (tattoo << 3);
  return {
    skin: hex(app.skin),
    hair: hex(app.hair),
    top: hex(app.top === 'suit' ? 0xeeeae2 : app.shirt),
    outer: hex(app.top === 'vest' ? 0x2a2e34 : app.jacket),
    bottom: hex(app.top === 'suit' ? app.jacket : app.pants),
    shoes: hex(app.shoes),
    hat: hex(app.hatColor),
    tattoo: hex(app.tattooColor || 0x1a2a3a),
    sleeve: app.top === 'tank' || app.top === 'vest' ? 0 : covered ? 1.02 : 0.36,
    legs: app.bottom === 'shorts' ? 0.42 : 1.02,
    outerId: app.top === 'jacket' || app.top === 'suit' ? OUTER_IDS.jacket : app.top === 'vest' ? OUTER_IDS.vest : OUTER_IDS.none,
    hairId: HAIR_IDS[hair],
    beardId: app.beard === 'full' ? 1 : app.beard === 'goatee' ? 2 : 0,
    hatId: HAT_IDS[app.hat],
    topKind: { tee: 0, long: 1, tank: 2, jacket: 3, suit: 4, vest: 5 }[app.top],
    flags,
  };
}
