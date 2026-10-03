/**
 * Decoder for `src/assets/chars.bin` (built by scripts/build-characters.mjs from the CC0 Quaternius
 * Universal Animation Library). Pure data — no three.js — so the animation code is unit-testable.
 */

/** Skeleton rest pose for one body type (gender): UAL rotations with the dressed model's joint positions. */
export interface RigBody {
  name: string;
  /** Rest local translation / rotation per bone (bind pose). */
  restT: Float32Array;
  restQ: Float32Array;
  /** Bind-pose (model space) rotation / position per bone, and their inverse. */
  bindQ: Float32Array;
  bindP: Float32Array;
  invQ: Float32Array;
  invP: Float32Array;
  /** Added to clip pelvis translations (clips were authored on a different skeleton). */
  pelvisOffset: Float32Array;
  /** Leg length relative to the animation skeleton (scales gait ground speed). */
  legScale: number;
}

/** One dressed part (head / body / legs / feet) skinned to a body type's skeleton. */
export interface RigPart {
  name: string;
  aliases: string[];
  /** Body (skeleton) index: 0 male, 1 female. */
  body: number;
  kind: PartKind;
  vertexCount: number;
  /** int16 xyz_ ; metres = value / quant. */
  position: Int16Array;
  quant: number;
  normal: Int8Array; // xyz_ snorm
  skinIndex: Uint8Array;
  skinWeight: Uint8Array; // sums to 255
  /** sRGB colour + paint slot per vertex. */
  color: Uint8Array;
  index: Uint16Array;
}

export const enum PartKind {
  Head = 0,
  Body = 1,
  Legs = 2,
  Feet = 3,
}

export interface RigClip {
  name: string;
  loop: boolean;
  frames: number;
  duration: number;
  /** Natural ground speed (m/s) for locomotion loops, else 0. */
  speed: number;
  /** Normalized time where the left foot is furthest forward (gait alignment). */
  phase0: number;
  /** Frame-major local rotations: [frame][bone][xyzw]. */
  rot: Float32Array;
  /** Pelvis local translation per frame. */
  pelvis: Float32Array;
}

export interface RigData {
  fps: number;
  boneNames: string[];
  parents: Int16Array;
  bodies: RigBody[];
  parts: RigPart[];
  /** Part index by name (including aliases of identical parts), per body. */
  part(body: number, name: string): number;
  clips: RigClip[];
  clipIndex: Map<string, number>;
  /** Index of the pelvis bone (the only bone with animated translation). */
  pelvis: number;
  bone(name: string): number;
}

interface Ref {
  0: number;
  1: number;
}
interface JsonSkeleton {
  gender: string; restT: Ref; restQ: Ref; pelvisOffset: number[]; legScale: number;
}
interface JsonPart {
  name: string; aliases: string[]; gender: string; kind: number; vertexCount: number; quant: number;
  position: Ref; normal: Ref; skinIndex: Ref; skinWeight: Ref; color: Ref; index: Ref;
}
interface JsonClip {
  name: string; loop: boolean; frames: number; duration: number; speed: number; phase0?: number; constMask: Ref; rot: Ref; pelvis: Ref;
}
interface JsonRig {
  version: number;
  fps: number;
  bones: { name: string; parent: number }[];
  skeletons: JsonSkeleton[];
  parts: JsonPart[];
  clips: JsonClip[];
}

export function decodeRig(buf: ArrayBuffer): RigData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'CCR2') throw new Error('chars.bin: bad magic');
  const jlen = dv.getUint32(4, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, jlen))) as JsonRig;
  const blob = 8 + jlen;
  const f32 = (r: Ref): Float32Array => new Float32Array(buf, blob + r[0], r[1]);
  const u8 = (r: Ref): Uint8Array => new Uint8Array(buf, blob + r[0], r[1]);
  const i8 = (r: Ref): Int8Array => new Int8Array(buf, blob + r[0], r[1]);
  const i16 = (r: Ref): Int16Array => new Int16Array(buf, blob + r[0], r[1]);
  const u16 = (r: Ref): Uint16Array => new Uint16Array(buf, blob + r[0], r[1]);
  const nb = json.bones.length;
  const parents = new Int16Array(json.bones.map((b) => b.parent));
  const boneNames = json.bones.map((b) => b.name);

  const bodies = json.skeletons.map((b): RigBody => {
    const restT = f32(b.restT), restQ = f32(b.restQ);
    const bindQ = new Float32Array(nb * 4), bindP = new Float32Array(nb * 3);
    fkRest(parents, restT, restQ, bindQ, bindP);
    const invQ = new Float32Array(nb * 4), invP = new Float32Array(nb * 3);
    for (let i = 0; i < nb; i++) {
      // inverse of (R, p) is (R⁻¹, −R⁻¹p)
      const qx = -bindQ[i * 4]!, qy = -bindQ[i * 4 + 1]!, qz = -bindQ[i * 4 + 2]!, qw = bindQ[i * 4 + 3]!;
      invQ[i * 4] = qx; invQ[i * 4 + 1] = qy; invQ[i * 4 + 2] = qz; invQ[i * 4 + 3] = qw;
      rotate(qx, qy, qz, qw, -bindP[i * 3]!, -bindP[i * 3 + 1]!, -bindP[i * 3 + 2]!, invP, i * 3);
    }
    return { name: b.gender, restT, restQ, bindQ, bindP, invQ, invP, pelvisOffset: new Float32Array(b.pelvisOffset), legScale: b.legScale };
  });
  const bodyOf = (g: string): number => Math.max(0, json.skeletons.findIndex((k) => k.gender === g));
  const parts = json.parts.map((p): RigPart => ({
    name: p.name, aliases: p.aliases, body: bodyOf(p.gender), kind: p.kind as PartKind, vertexCount: p.vertexCount, quant: p.quant,
    position: i16(p.position), normal: i8(p.normal), skinIndex: u8(p.skinIndex), skinWeight: u8(p.skinWeight), color: u8(p.color), index: u16(p.index),
  }));
  const partMap = new Map<string, number>();
  parts.forEach((p, i) => {
    for (const n of [p.name, ...p.aliases]) partMap.set(`${p.body}:${n}`, i);
  });

  const clips = json.clips.map((c): RigClip => {
    const mask = u8(c.constMask);
    const data = i16(c.rot);
    const rot = new Float32Array(c.frames * nb * 4);
    let o = 0;
    for (let b = 0; b < nb; b++) {
      if (mask[b]) {
        for (let f = 0; f < c.frames; f++) for (let k = 0; k < 4; k++) rot[(f * nb + b) * 4 + k] = data[o + k]! / 32767;
        o += 4;
      } else {
        for (let f = 0; f < c.frames; f++) {
          for (let k = 0; k < 4; k++) rot[(f * nb + b) * 4 + k] = data[o + k]! / 32767;
          o += 4;
        }
      }
    }
    // renormalize after quantization
    for (let i = 0; i < rot.length; i += 4) {
      const l = Math.hypot(rot[i]!, rot[i + 1]!, rot[i + 2]!, rot[i + 3]!) || 1;
      rot[i]! /= l; rot[i + 1]! /= l; rot[i + 2]! /= l; rot[i + 3]! /= l;
    }
    return { name: c.name, loop: c.loop, frames: c.frames, duration: c.duration, speed: c.speed, phase0: c.phase0 ?? 0, rot, pelvis: new Float32Array(f32(c.pelvis)) };
  });
  const clipIndex = new Map(clips.map((c, i) => [c.name, i]));
  const boneMap = new Map(boneNames.map((n, i) => [n, i]));
  return {
    fps: json.fps, boneNames, parents, bodies, parts, clips, clipIndex, pelvis: boneMap.get('pelvis') ?? 1,
    part(body: number, name: string): number {
      const i = partMap.get(`${body}:${name}`);
      if (i === undefined) throw new Error(`no part ${name} for body ${body}`);
      return i;
    },
    bone(name: string): number {
      const i = boneMap.get(name);
      if (i === undefined) throw new Error('no bone ' + name);
      return i;
    },
  };
}

/** Rotate vector (vx,vy,vz) by quaternion (x,y,z,w) into out[o..o+2]. */
export function rotate(x: number, y: number, z: number, w: number, vx: number, vy: number, vz: number, out: Float32Array, o: number): void {
  // t = 2 * cross(q.xyz, v); v' = v + w*t + cross(q.xyz, t)
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  out[o] = vx + w * tx + (y * tz - z * ty);
  out[o + 1] = vy + w * ty + (z * tx - x * tz);
  out[o + 2] = vz + w * tz + (x * ty - y * tx);
}

/** Forward kinematics of the rest pose → model-space rotations / positions. */
function fkRest(parents: Int16Array, T: Float32Array, Q: Float32Array, outQ: Float32Array, outP: Float32Array): void {
  for (let i = 0; i < parents.length; i++) {
    const p = parents[i]!;
    if (p < 0) {
      outQ.set(Q.subarray(i * 4, i * 4 + 4), i * 4);
      outP.set(T.subarray(i * 3, i * 3 + 3), i * 3);
      continue;
    }
    const px = outQ[p * 4]!, py = outQ[p * 4 + 1]!, pz = outQ[p * 4 + 2]!, pw = outQ[p * 4 + 3]!;
    mulQ(px, py, pz, pw, Q[i * 4]!, Q[i * 4 + 1]!, Q[i * 4 + 2]!, Q[i * 4 + 3]!, outQ, i * 4);
    rotate(px, py, pz, pw, T[i * 3]!, T[i * 3 + 1]!, T[i * 3 + 2]!, outP, i * 3);
    outP[i * 3]! += outP[p * 3]!;
    outP[i * 3 + 1]! += outP[p * 3 + 1]!;
    outP[i * 3 + 2]! += outP[p * 3 + 2]!;
  }
}

/** out[o..o+3] = a ⊗ b */
export function mulQ(ax: number, ay: number, az: number, aw: number, bx: number, by: number, bz: number, bw: number, out: Float32Array, o: number): void {
  out[o] = aw * bx + ax * bw + ay * bz - az * by;
  out[o + 1] = aw * by - ax * bz + ay * bw + az * bx;
  out[o + 2] = aw * bz + ax * by - ay * bx + az * bw;
  out[o + 3] = aw * bw - ax * bx - ay * by - az * bz;
}
