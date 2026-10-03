import { mulQ, rotate, type RigBody, type RigClip, type RigData } from './RigData';

/**
 * Pose evaluation for the skinned characters (pure math on typed arrays, no allocation per call):
 * clip sampling + weighted blending in local space, forward kinematics with model-space overrides
 * (aim pitch, lower-body twist, ragdoll-driven bones) and skin-matrix output for the GPU.
 */

/** Local pose: bone rotations + pelvis translation. */
export class LocalPose {
  readonly q: Float32Array;
  readonly pelvis = new Float32Array(3);
  constructor(readonly nb: number) {
    this.q = new Float32Array(nb * 4);
  }
  copy(o: LocalPose): this {
    this.q.set(o.q);
    this.pelvis.set(o.pelvis);
    return this;
  }
}

/** Model-space bone transforms (rotation + position, character root at origin facing +Z). */
export class ModelPose {
  readonly q: Float32Array;
  readonly p: Float32Array;
  constructor(readonly nb: number) {
    this.q = new Float32Array(nb * 4);
    this.p = new Float32Array(nb * 3);
  }
}

/** Frame index pair + blend for time `t` (seconds) in a clip. */
function frameAt(clip: RigClip, fps: number, t: number, out: { f0: number; f1: number; a: number }): void {
  const n = clip.frames;
  if (n <= 1) {
    out.f0 = out.f1 = 0;
    out.a = 0;
    return;
  }
  let fp = t * fps;
  if (clip.loop) {
    fp %= n;
    if (fp < 0) fp += n;
    const f0 = Math.floor(fp);
    out.f0 = f0;
    out.f1 = f0 + 1 >= n ? 0 : f0 + 1;
    out.a = fp - f0;
  } else {
    if (fp <= 0) {
      out.f0 = out.f1 = 0;
      out.a = 0;
      return;
    }
    if (fp >= n - 1) {
      out.f0 = out.f1 = n - 1;
      out.a = 0;
      return;
    }
    const f0 = Math.floor(fp);
    out.f0 = f0;
    out.f1 = f0 + 1;
    out.a = fp - f0;
  }
}
const _fr = { f0: 0, f1: 0, a: 0 };

/**
 * Blend clip `clip` at time `t` into `out` with weight `w` (per-bone `mask` multiplies w).
 * w = 1 with no mask overwrites. Rotations use normalized lerp along the short arc.
 */
export function blendClip(rig: RigData, clip: RigClip, t: number, w: number, out: LocalPose, mask?: Float32Array | null, pelvisW = 1): void {
  if (w <= 0) return;
  frameAt(clip, rig.fps, t, _fr);
  const nb = out.nb;
  const r = clip.rot;
  const o0 = _fr.f0 * nb * 4, o1 = _fr.f1 * nb * 4, a = _fr.a, b = 1 - a;
  const q = out.q;
  for (let i = 0; i < nb; i++) {
    const wi = mask ? w * mask[i]! : w;
    if (wi <= 0) continue;
    const j = i * 4;
    let x = r[o0 + j]!, y = r[o0 + j + 1]!, z = r[o0 + j + 2]!, ww = r[o0 + j + 3]!;
    if (a > 0) {
      let x1 = r[o1 + j]!, y1 = r[o1 + j + 1]!, z1 = r[o1 + j + 2]!, w1 = r[o1 + j + 3]!;
      if (x * x1 + y * y1 + z * z1 + ww * w1 < 0) {
        x1 = -x1; y1 = -y1; z1 = -z1; w1 = -w1;
      }
      x = x * b + x1 * a; y = y * b + y1 * a; z = z * b + z1 * a; ww = ww * b + w1 * a;
    }
    if (wi >= 1) {
      const l = 1 / Math.sqrt(x * x + y * y + z * z + ww * ww);
      q[j] = x * l; q[j + 1] = y * l; q[j + 2] = z * l; q[j + 3] = ww * l;
    } else {
      let qx = q[j]!, qy = q[j + 1]!, qz = q[j + 2]!, qw = q[j + 3]!;
      if (qx * x + qy * y + qz * z + qw * ww < 0) {
        x = -x; y = -y; z = -z; ww = -ww;
      }
      qx += (x - qx) * wi; qy += (y - qy) * wi; qz += (z - qz) * wi; qw += (ww - qw) * wi;
      const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      q[j] = qx * l; q[j + 1] = qy * l; q[j + 2] = qz * l; q[j + 3] = qw * l;
    }
  }
  const pw = mask ? w * pelvisW : w;
  if (pw > 0) {
    const p = clip.pelvis, P = out.pelvis;
    const px = p[_fr.f0 * 3]! * b + p[_fr.f1 * 3]! * a, py = p[_fr.f0 * 3 + 1]! * b + p[_fr.f1 * 3 + 1]! * a, pz = p[_fr.f0 * 3 + 2]! * b + p[_fr.f1 * 3 + 2]! * a;
    const k = Math.min(1, pw);
    P[0]! += (px - P[0]!) * k;
    P[1]! += (py - P[1]!) * k;
    P[2]! += (pz - P[2]!) * k;
  }
}

/** Blend another local pose into `out`. */
export function blendPoseInto(src: LocalPose, w: number, out: LocalPose, mask?: Float32Array | null, pelvisW = 1): void {
  if (w <= 0) return;
  const q = out.q, s = src.q;
  for (let i = 0; i < out.nb; i++) {
    const wi = Math.min(1, mask ? w * mask[i]! : w);
    if (wi <= 0) continue;
    const j = i * 4;
    let x = s[j]!, y = s[j + 1]!, z = s[j + 2]!, ww = s[j + 3]!;
    let qx = q[j]!, qy = q[j + 1]!, qz = q[j + 2]!, qw = q[j + 3]!;
    if (qx * x + qy * y + qz * z + qw * ww < 0) {
      x = -x; y = -y; z = -z; ww = -ww;
    }
    qx += (x - qx) * wi; qy += (y - qy) * wi; qz += (z - qz) * wi; qw += (ww - qw) * wi;
    const l = 1 / Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    q[j] = qx * l; q[j + 1] = qy * l; q[j + 2] = qz * l; q[j + 3] = qw * l;
  }
  const k = Math.min(1, mask ? w * pelvisW : w);
  for (let a = 0; a < 3; a++) out.pelvis[a]! += (src.pelvis[a]! - out.pelvis[a]!) * k;
}

/** Model-space rotation applied to a bone (and so its children) during FK, about the bone's origin. */
export interface BoneOverride {
  bone: number;
  q: Float32Array; // xyzw, model space
}

/**
 * Forward kinematics. `pre[bone]` (optional) is a model-space rotation pre-multiplied onto the bone
 * (aim pitch, lower-body twist). `fixed[bone]` = 1 marks bones whose model transform is already in
 * `out` (ragdoll-driven) and must not be recomputed.
 */
export function forwardKinematics(rig: RigData, body: RigBody, pose: LocalPose, out: ModelPose, pre?: (Float32Array | null)[] | null, fixed?: Uint8Array | null): void {
  const par = rig.parents, T = body.restT, L = pose.q, Q = out.q, P = out.p;
  const nb = out.nb, pelvis = rig.pelvis;
  for (let i = 0; i < nb; i++) {
    if (fixed && fixed[i]) continue;
    const p = par[i]!;
    const j = i * 4;
    if (p < 0) {
      Q[j] = L[j]!; Q[j + 1] = L[j + 1]!; Q[j + 2] = L[j + 2]!; Q[j + 3] = L[j + 3]!;
      P[i * 3] = T[i * 3]!; P[i * 3 + 1] = T[i * 3 + 1]!; P[i * 3 + 2] = T[i * 3 + 2]!;
    } else {
      const k = p * 4;
      const px = Q[k]!, py = Q[k + 1]!, pz = Q[k + 2]!, pw = Q[k + 3]!;
      mulQ(px, py, pz, pw, L[j]!, L[j + 1]!, L[j + 2]!, L[j + 3]!, Q, j);
      const isPelvis = i === pelvis;
      const po = body.pelvisOffset;
      const tx = isPelvis ? pose.pelvis[0]! + po[0]! : T[i * 3]!, ty = isPelvis ? pose.pelvis[1]! + po[1]! : T[i * 3 + 1]!, tz = isPelvis ? pose.pelvis[2]! + po[2]! : T[i * 3 + 2]!;
      rotate(px, py, pz, pw, tx, ty, tz, P, i * 3);
      P[i * 3]! += P[p * 3]!;
      P[i * 3 + 1]! += P[p * 3 + 1]!;
      P[i * 3 + 2]! += P[p * 3 + 2]!;
    }
    const d = pre?.[i];
    if (d) {
      const x = Q[j]!, y = Q[j + 1]!, z = Q[j + 2]!, w = Q[j + 3]!;
      mulQ(d[0]!, d[1]!, d[2]!, d[3]!, x, y, z, w, Q, j);
    }
  }
}
/**
 * Write skin matrices (3 rows of a 3×4 affine matrix per bone = 12 floats) for a character placed
 * at (x,y,z) with heading `yaw` and uniform `scale`: S = World × Model × Bind⁻¹.
 */
export function writeSkin(body: RigBody, model: ModelPose, x: number, y: number, z: number, yaw: number, scale: number, out: Float32Array, offset: number): void {
  const nb = model.nb;
  const hy = Math.sin(yaw / 2), hw = Math.cos(yaw / 2);
  const Q = model.q, P = model.p, iQ = body.invQ, iP = body.invP;
  for (let i = 0; i < nb; i++) {
    const j = i * 4;
    // world rotation of the bone: R_yaw ⊗ Qm
    const mx = Q[j]!, my = Q[j + 1]!, mz = Q[j + 2]!, mw = Q[j + 3]!;
    const wx = hw * mx + hy * mz, wy = hw * my + hy * mw, wz = hw * mz - hy * mx, ww = hw * mw - hy * my;
    // combined rotation C = W ⊗ Inv
    const ix = iQ[j]!, iy = iQ[j + 1]!, iz = iQ[j + 2]!, iw = iQ[j + 3]!;
    const cx = ww * ix + wx * iw + wy * iz - wz * iy;
    const cy = ww * iy - wx * iz + wy * iw + wz * ix;
    const cz = ww * iz + wx * iy - wy * ix + wz * iw;
    const cw = ww * iw - wx * ix - wy * iy - wz * iz;
    // translation: world(yaw)·(Pm + Qm·invP) * scale + pos
    const ipx = iP[i * 3]!, ipy = iP[i * 3 + 1]!, ipz = iP[i * 3 + 2]!;
    // Qm·invP
    let tx = 2 * (my * ipz - mz * ipy), ty = 2 * (mz * ipx - mx * ipz), tz = 2 * (mx * ipy - my * ipx);
    const vx = ipx + mw * tx + (my * tz - mz * ty) + P[i * 3]!;
    const vy = ipy + mw * ty + (mz * tx - mx * tz) + P[i * 3 + 1]!;
    const vz = ipz + mw * tz + (mx * ty - my * tx) + P[i * 3 + 2]!;
    // yaw rotate (about Y): x' = x cos + z sin, z' = -x sin + z cos
    const cs = hw * hw - hy * hy, sn = 2 * hw * hy;
    tx = (vx * cs + vz * sn) * scale + x;
    ty = vy * scale + y;
    tz = (-vx * sn + vz * cs) * scale + z;
    // rotation matrix rows of C, scaled
    const x2 = cx + cx, y2 = cy + cy, z2 = cz + cz;
    const xx = cx * x2, xy = cx * y2, xz = cx * z2, yy = cy * y2, yz = cy * z2, zz = cz * z2;
    const wx2 = cw * x2, wy2 = cw * y2, wz2 = cw * z2;
    const o = offset + i * 12;
    out[o] = (1 - (yy + zz)) * scale; out[o + 1] = (xy - wz2) * scale; out[o + 2] = (xz + wy2) * scale; out[o + 3] = tx;
    out[o + 4] = (xy + wz2) * scale; out[o + 5] = (1 - (xx + zz)) * scale; out[o + 6] = (yz - wx2) * scale; out[o + 7] = ty;
    out[o + 8] = (xz - wy2) * scale; out[o + 9] = (yz + wx2) * scale; out[o + 10] = (1 - (xx + yy)) * scale; out[o + 11] = tz;
  }
}

/** World position of `bone` (+ optional offset in the bone's frame) for a placed character. */
export function boneWorld(model: ModelPose, bone: number, x: number, y: number, z: number, yaw: number, scale: number, out: { x: number; y: number; z: number }, ox = 0, oy = 0, oz = 0): void {
  const j = bone * 4;
  const Q = model.q;
  const qx = Q[j]!, qy = Q[j + 1]!, qz = Q[j + 2]!, qw = Q[j + 3]!;
  _t3[0] = 0; _t3[1] = 0; _t3[2] = 0;
  if (ox || oy || oz) rotate(qx, qy, qz, qw, ox, oy, oz, _t3, 0);
  const vx = _t3[0]! + model.p[bone * 3]!, vy = _t3[1]! + model.p[bone * 3 + 1]!, vz = _t3[2]! + model.p[bone * 3 + 2]!;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  out.x = (vx * c + vz * s) * scale + x;
  out.y = vy * scale + y;
  out.z = (-vx * s + vz * c) * scale + z;
}
const _t3 = new Float32Array(3);

/** Rest (bind) local pose of a body (pelvis in clip space: FK adds the body's pelvis offset). */
export function restPose(body: RigBody, out: LocalPose, pelvis: number): void {
  out.q.set(body.restQ);
  out.pelvis[0] = body.restT[pelvis * 3]! - body.pelvisOffset[0]!;
  out.pelvis[1] = body.restT[pelvis * 3 + 1]! - body.pelvisOffset[1]!;
  out.pelvis[2] = body.restT[pelvis * 3 + 2]! - body.pelvisOffset[2]!;
}
