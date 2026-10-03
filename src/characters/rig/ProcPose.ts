import type { Pose } from '../Pose';
import { mulQ, rotate, type RigData } from './RigData';
import { forwardKinematics, LocalPose, ModelPose, blendClip, restPose } from './PoseEval';

/**
 * Retargets the procedural joint-angle `Pose` (characters/Pose.ts) onto the UAL skeleton, so actions
 * with no matching motion clip (hands up, cower, kick, lockpick, bike riding…) still animate.
 *
 * Each Pose segment's model-space rotation (same Euler conventions as the old box renderer) is
 * applied as a delta on top of a reference standing pose (Idle_Loop frame 0): zero angles = idle.
 */
export class ProcRetarget {
  private readonly ref: LocalPose;
  private readonly refModel: ModelPose;
  private readonly model: ModelPose;
  /** Segment id per bone (−1 = keep reference local rotation). */
  private readonly seg: Int8Array;
  /** For spine/neck: fraction along the parent→child segment rotation. */
  private readonly frac: Float32Array;
  private readonly segQ = new Float32Array(SEG_COUNT * 4);
  private readonly up = new Float32Array(3);
  private readonly tmp = new Float32Array(4);

  constructor(private rig: RigData) {
    const nb = rig.boneNames.length;
    const body = rig.bodies[0]!;
    this.ref = new LocalPose(nb);
    restPose(body, this.ref, rig.pelvis);
    const idle = rig.clips[rig.clipIndex.get('Idle_Loop') ?? 0]!;
    blendClip(rig, idle, 0, 1, this.ref);
    this.refModel = new ModelPose(nb);
    forwardKinematics(rig, body, this.ref, this.refModel);
    this.model = new ModelPose(nb);
    this.seg = new Int8Array(nb).fill(-1);
    this.frac = new Float32Array(nb).fill(1);
    const set = (name: string, s: Seg, f = 1): void => {
      const i = rig.boneNames.indexOf(name);
      if (i >= 0) {
        this.seg[i] = s;
        this.frac[i] = f;
      }
    };
    set('pelvis', Seg.Pelvis);
    set('spine_01', Seg.Spine, 1 / 3);
    set('spine_02', Seg.Spine, 2 / 3);
    set('spine_03', Seg.Spine);
    set('neck_01', Seg.Head, 0.5);
    set('Head', Seg.Head);
    for (const s of ['l', 'r'] as const) {
      const L = s === 'l';
      set(`clavicle_${s}`, Seg.Spine);
      set(`upperarm_${s}`, L ? Seg.LShoulder : Seg.RShoulder);
      set(`lowerarm_${s}`, L ? Seg.LElbow : Seg.RElbow);
      set(`hand_${s}`, L ? Seg.LElbow : Seg.RElbow);
      set(`thigh_${s}`, L ? Seg.LHip : Seg.RHip);
      set(`calf_${s}`, L ? Seg.LKnee : Seg.RKnee);
      set(`foot_${s}`, L ? Seg.LFoot : Seg.RFoot);
    }
    // model "up" in the root bone's local frame (pelvis translation is expressed there)
    const r = 0;
    const q = this.refModel.q;
    rotate(-q[r]!, -q[r + 1]!, -q[r + 2]!, q[r + 3]!, 0, 1, 0, this.up, 0);
  }

  /** Convert `pose` into a local pose on the rig. */
  apply(pose: Pose, out: LocalPose): void {
    this.segments(pose);
    const rig = this.rig, nb = out.nb, par = rig.parents;
    const RM = this.refModel.q, RL = this.ref.q, M = this.model.q, S = this.segQ, t = this.tmp;
    for (let i = 0; i < nb; i++) {
      const j = i * 4, p = par[i]!;
      const s = this.seg[i]!;
      if (s < 0) {
        // keep the reference local rotation; model = parent ⊗ local
        if (p < 0) M.set(RL.subarray(j, j + 4), j);
        else mulQ(M[p * 4]!, M[p * 4 + 1]!, M[p * 4 + 2]!, M[p * 4 + 3]!, RL[j]!, RL[j + 1]!, RL[j + 2]!, RL[j + 3]!, M, j);
      } else {
        // delta (old-convention segment rotation, partially toward it for spine/neck) ⊗ reference model
        const f = this.frac[i]!;
        const k = s * 4;
        if (f >= 1) {
          t[0] = S[k]!; t[1] = S[k + 1]!; t[2] = S[k + 2]!; t[3] = S[k + 3]!;
        } else {
          const pk = (s === Seg.Spine ? Seg.Pelvis : Seg.Spine) * 4;
          nlerp(S, pk, S, k, f, t);
        }
        mulQ(t[0]!, t[1]!, t[2]!, t[3]!, RM[j]!, RM[j + 1]!, RM[j + 2]!, RM[j + 3]!, M, j);
      }
      // local = parent⁻¹ ⊗ model
      if (p < 0) out.q.set(M.subarray(j, j + 4), j);
      else mulQ(-M[p * 4]!, -M[p * 4 + 1]!, -M[p * 4 + 2]!, M[p * 4 + 3]!, M[j]!, M[j + 1]!, M[j + 2]!, M[j + 3]!, out.q, j);
    }
    const y = pose.rootY;
    out.pelvis[0] = this.ref.pelvis[0]! + this.up[0]! * y;
    out.pelvis[1] = this.ref.pelvis[1]! + this.up[1]! * y;
    out.pelvis[2] = this.ref.pelvis[2]! + this.up[2]! * y;
  }

  /** Old renderer's joint frames, as model-space quaternions (character facing +Z, left = +X). */
  private segments(p: Pose): void {
    const S = this.segQ;
    euler(p.rootPitch, p.pelvisYaw, p.rootRoll, 'YXZ', S, Seg.Pelvis * 4);
    chain(S, Seg.Pelvis, p.spinePitch, p.spineYaw - p.pelvisYaw, p.spineRoll, 'YXZ', Seg.Spine);
    chain(S, Seg.Spine, p.headPitch, p.headYaw, 0, 'YXZ', Seg.Head);
    chain(S, Seg.Spine, -p.lShoulderPitch, p.lShoulderYaw, p.lShoulderRoll, 'ZYX', Seg.LShoulder);
    chain(S, Seg.Spine, -p.rShoulderPitch, -p.rShoulderYaw, -p.rShoulderRoll, 'ZYX', Seg.RShoulder);
    chain(S, Seg.LShoulder, -p.lElbow, 0, 0, 'XYZ', Seg.LElbow);
    chain(S, Seg.RShoulder, -p.rElbow, 0, 0, 'XYZ', Seg.RElbow);
    chain(S, Seg.Pelvis, -p.lHip, 0, p.lHipRoll * 0.5, 'ZYX', Seg.LHip);
    chain(S, Seg.Pelvis, -p.rHip, 0, -p.rHipRoll * 0.5, 'ZYX', Seg.RHip);
    chain(S, Seg.LHip, p.lKnee, 0, 0, 'XYZ', Seg.LKnee);
    chain(S, Seg.RHip, p.rKnee, 0, 0, 'XYZ', Seg.RKnee);
    chain(S, Seg.LKnee, -p.lKnee * 0.3, 0, 0, 'XYZ', Seg.LFoot);
    chain(S, Seg.RKnee, -p.rKnee * 0.3, 0, 0, 'XYZ', Seg.RFoot);
  }
}

const enum Seg {
  Pelvis = 0, Spine, Head, LShoulder, RShoulder, LElbow, RElbow, LHip, RHip, LKnee, RKnee, LFoot, RFoot,
}
const SEG_COUNT = 13;
const _e = new Float32Array(4);

function chain(S: Float32Array, parent: Seg, x: number, y: number, z: number, order: 'XYZ' | 'YXZ' | 'ZYX', out: Seg): void {
  euler(x, y, z, order, _e, 0);
  const k = parent * 4;
  mulQ(S[k]!, S[k + 1]!, S[k + 2]!, S[k + 3]!, _e[0]!, _e[1]!, _e[2]!, _e[3]!, S, out * 4);
}

/** Quaternion from Euler angles (same formulas as three.js Quaternion.setFromEuler). */
export function euler(x: number, y: number, z: number, order: 'XYZ' | 'YXZ' | 'ZYX', out: Float32Array, o: number): void {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  if (order === 'XYZ') {
    out[o] = s1 * c2 * c3 + c1 * s2 * s3;
    out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
    out[o + 2] = c1 * c2 * s3 + s1 * s2 * c3;
    out[o + 3] = c1 * c2 * c3 - s1 * s2 * s3;
  } else if (order === 'YXZ') {
    out[o] = s1 * c2 * c3 + c1 * s2 * s3;
    out[o + 1] = c1 * s2 * c3 - s1 * c2 * s3;
    out[o + 2] = c1 * c2 * s3 - s1 * s2 * c3;
    out[o + 3] = c1 * c2 * c3 + s1 * s2 * s3;
  } else {
    out[o] = s1 * c2 * c3 - c1 * s2 * s3;
    out[o + 1] = c1 * s2 * c3 + s1 * c2 * s3;
    out[o + 2] = c1 * c2 * s3 - s1 * s2 * c3;
    out[o + 3] = c1 * c2 * c3 + s1 * s2 * s3;
  }
}

/** out = normalize(lerp(A[a], B[b], t)) along the short arc. */
function nlerp(A: Float32Array, a: number, B: Float32Array, b: number, t: number, out: Float32Array): void {
  let bx = B[b]!, by = B[b + 1]!, bz = B[b + 2]!, bw = B[b + 3]!;
  const ax = A[a]!, ay = A[a + 1]!, az = A[a + 2]!, aw = A[a + 3]!;
  if (ax * bx + ay * by + az * bz + aw * bw < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
  }
  const x = ax + (bx - ax) * t, y = ay + (by - ay) * t, z = az + (bz - az) * t, w = aw + (bw - aw) * t;
  const l = 1 / Math.sqrt(x * x + y * y + z * z + w * w);
  out[0] = x * l; out[1] = y * l; out[2] = z * l; out[3] = w * l;
}
