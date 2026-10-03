// Offline character asset build: Quaternius "Universal Animation Library" 1 + 2 (Standard, CC0)
// → src/assets/chars.bin (skeleton, two simplified body meshes, quantized animation clips).
//
// Usage: node scripts/build-characters.mjs <UAL1_Standard.glb> <UAL2_Standard.glb> <Mannequin_F.glb> [out.bin]
// (the Unreal-Godot GLB variants from the itch.io Standard zips). Only geometry, skin weights,
// bind poses and bone rotations are read; materials, textures and extras are dropped.
//
// File layout: "CCR1" | u32 jsonBytes | JSON (padded to 4) | binary blob. JSON holds offsets into the blob.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { readFile, writeFile } from 'node:fs/promises';

const [ual1Path, ual2Path, femalePath, outPath = 'src/assets/chars.bin'] = process.argv.slice(2);
if (!femalePath) {
  console.error('usage: node scripts/build-characters.mjs UAL1_Standard.glb UAL2_Standard.glb Mannequin_F.glb [out.bin]');
  process.exit(1);
}

const FPS = 30;
/** Triangle budget per body (the source meshes are ~14k / ~25k triangles). */
const BODY_TRIS = 6500;

/** Clips shipped with the game (source name → loop?). Everything else in the libraries is skipped. */
const CLIPS = [
  'Idle_Loop', 'Idle_Talking_Loop', 'Idle_TalkingPhone_Loop', 'Idle_FoldArms_Loop', 'Idle_No_Loop', 'Yes',
  'Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop',
  'Crouch_Idle_Loop', 'Crouch_Fwd_Loop', 'Swim_Idle_Loop', 'Swim_Fwd_Loop',
  'Jump_Start', 'Jump_Loop', 'Jump_Land', 'Roll', 'ClimbUp_1m',
  'Pistol_Idle_Loop', 'Pistol_Aim_Down', 'Pistol_Aim_Neutral', 'Pistol_Aim_Up', 'Pistol_Shoot', 'Pistol_Reload',
  'Punch_Jab', 'Punch_Cross', 'Melee_Hook', 'Sword_Regular_A', 'Sword_Attack', 'OverhandThrow',
  'Hit_Chest', 'Hit_Head', 'Hit_Knockback', 'Death01', 'LayToIdle',
  'Driving_Loop', 'Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Sitting_Enter', 'Sitting_Exit',
  'Dance_Loop', 'Interact', 'PickUp_Table', 'Push_Loop', 'Fixing_Kneeling', 'Consume', 'Idle_Rail_Call',
  'Zombie_Walk_Fwd_Loop', 'Zombie_Idle_Loop',
];
/** Loops whose natural ground speed is measured from the feet (m/s). */
const LOCOMOTION = ['Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop', 'Crouch_Fwd_Loop', 'Zombie_Walk_Fwd_Loop'];

/** Body regions (painted by the clothing shader). Keep in sync with src/characters/rig/regions.ts. */
const REGION = { head: 0, neck: 1, chest: 2, belly: 3, hips: 4, upperArm: 5, lowerArm: 6, hand: 7, thigh: 8, calf: 9, foot: 10 };
function regionOf(bone) {
  if (bone === 'Head') return REGION.head;
  if (bone === 'neck_01') return REGION.neck;
  if (bone === 'spine_03' || bone.startsWith('clavicle')) return REGION.chest;
  if (bone === 'spine_02' || bone === 'spine_01') return REGION.belly;
  if (bone === 'pelvis' || bone === 'root') return REGION.hips;
  if (bone.startsWith('upperarm')) return REGION.upperArm;
  if (bone.startsWith('lowerarm')) return REGION.lowerArm;
  if (bone.startsWith('thigh')) return REGION.thigh;
  if (bone.startsWith('calf')) return REGION.calf;
  if (bone.startsWith('foot') || bone.startsWith('ball')) return REGION.foot;
  return REGION.hand; // hand + fingers
}

async function load(path) {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const g = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  g.scene.updateMatrixWorld(true);
  return g;
}

const [g1, g2, gf] = await Promise.all([load(ual1Path), load(ual2Path), load(femalePath)]);
await MeshoptSimplifier.ready;

function skinnedMeshes(g) {
  const out = [];
  g.scene.traverse((o) => {
    if (o.isSkinnedMesh) out.push(o);
  });
  if (!out.length) throw new Error('no skinned mesh');
  return out;
}

// ---------- skeleton (from the male rig) ----------
const maleMeshes = skinnedMeshes(g1);
const femaleMeshes = skinnedMeshes(gf);
const srcBones = maleMeshes[0].skeleton.bones;
// prune weightless leaf bones (finger tips, ball_leaf): they only exist for IK in DCC tools
const weighted = new Set();
for (const m of [...maleMeshes, ...femaleMeshes]) {
  const si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
  for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0) weighted.add(m.skeleton.bones[si.getComponent(i, k)].name);
}
const keep = (b) => weighted.has(b.name) || b.children.some((c) => c.isBone && keep(c)) || !b.name.includes('leaf');
const bones = srcBones.filter(keep);
const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
const parents = bones.map((b) => (b.parent?.isBone ? boneIndex.get(b.parent.name) : -1));
for (let i = 0; i < bones.length; i++) if (parents[i] >= i) throw new Error('bones not in parent-first order');
console.log(`bones: ${bones.length} (of ${srcBones.length})`);

/** Rest locals for a rig (by bone name); the root folds in its non-bone ancestors (Armature node). */
function restOf(meshes) {
  const byName = new Map();
  meshes[0].skeleton.bones.forEach((b) => byName.set(b.name, b));
  const T = new Float32Array(bones.length * 3), Q = new Float32Array(bones.length * 4), inv = new Float32Array(bones.length * 16);
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  bones.forEach((ref, i) => {
    const b = byName.get(ref.name);
    if (!b) throw new Error('missing bone ' + ref.name);
    if (parents[i] < 0) m.copy(b.parent.matrixWorld).multiply(b.matrix);
    else m.copy(b.matrix);
    m.decompose(p, q, s);
    if (Math.abs(s.x - 1) > 1e-3 || Math.abs(s.y - 1) > 1e-3 || Math.abs(s.z - 1) > 1e-3) throw new Error('scaled bone ' + b.name);
    T.set([p.x, p.y, p.z], i * 3);
    Q.set([q.x, q.y, q.z, q.w], i * 4);
    // inverse bind = inverse of the bone's rest model matrix (rest pose == bind pose, checked below)
    inv.set(m.copy(b.matrixWorld).invert().elements, i * 16);
  });
  // check: rest pose == bind pose (bone.matrixWorld × boneInverse × bindMatrix ≈ bindMatrix)
  const sk = meshes[0].skeleton, bm = meshes[0].bindMatrix;
  let err2 = 0;
  sk.bones.forEach((b, i) => {
    m.multiplyMatrices(b.matrixWorld, sk.boneInverses[i]).multiply(bm);
    for (let k = 0; k < 16; k++) err2 = Math.max(err2, Math.abs(m.elements[k] - bm.elements[k]));
  });
  if (err2 > 1e-3) throw new Error('rest pose differs from bind pose: ' + err2);
  return { T, Q, inv, byName };
}

// ---------- bodies ----------
function buildBody(name, meshes) {
  const rest = restOf(meshes);
  const pos = [], nrm = [], si = [], sw = [], reg = [], idx = [];
  const nm = new THREE.Matrix3(), v = new THREE.Vector3();
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const base = pos.length / 3;
    nm.getNormalMatrix(mesh.bindMatrix);
    const P = g.attributes.position, N = g.attributes.normal, I = g.attributes.skinIndex, W = g.attributes.skinWeight;
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i).applyMatrix4(mesh.bindMatrix);
      pos.push(v.x, v.y, v.z);
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nrm.push(v.x, v.y, v.z);
      let best = 0, bw = -1;
      const ids = [], ws = [];
      for (let k = 0; k < 4; k++) {
        const bn = mesh.skeleton.bones[I.getComponent(i, k)].name;
        const w = W.getComponent(i, k);
        let j = boneIndex.get(bn);
        if (j === undefined) j = boneIndex.get(mesh.skeleton.bones[I.getComponent(i, k)].parent.name);
        ids.push(j);
        ws.push(w);
        if (w > bw) {
          bw = w;
          best = j;
        }
      }
      si.push(...ids);
      sw.push(...ws);
      reg.push(regionOf(bones[best].name));
    }
    const index = g.index;
    for (let i = 0; i < index.count; i++) idx.push(base + index.getX(i));
  }
  let positions = new Float32Array(pos);
  const vcount0 = positions.length / 3;
  // weld exact duplicates (UV seams) by position + normal
  const key = new Map();
  const remap = new Uint32Array(vcount0);
  let uniq = 0;
  const firstOf = [];
  for (let i = 0; i < vcount0; i++) {
    const k = [0, 1, 2].map((a) => Math.round(pos[i * 3 + a] * 1e4)).join(',') + '|' + [0, 1, 2].map((a) => Math.round(nrm[i * 3 + a] * 50)).join(',');
    let j = key.get(k);
    if (j === undefined) {
      j = uniq++;
      key.set(k, j);
      firstOf.push(i);
    }
    remap[i] = j;
  }
  const pick = (arr, n) => {
    const out = [];
    for (const i of firstOf) for (let k = 0; k < n; k++) out.push(arr[i * n + k]);
    return out;
  };
  positions = new Float32Array(pick(pos, 3));
  let normals = new Float32Array(pick(nrm, 3));
  let skinI = pick(si, 4), skinW = pick(sw, 4), region = pick(reg, 1);
  let indices = new Uint32Array(idx.map((i) => remap[i]));
  const tris0 = indices.length / 3;
  // simplify (normals as attributes so silhouettes and shading survive; borders locked to avoid cracks)
  const [simp, error] = MeshoptSimplifier.simplifyWithAttributes(indices, positions, 3, normals, 3, [0.4, 0.4, 0.4], null, BODY_TRIS * 3, 0.02, ['LockBorder']);
  indices = simp;
  const [cremap, n] = MeshoptSimplifier.compactMesh(indices);
  void cremap;
  // compactMesh rewrites `indices` in place and returns the old→new remap
  const P2 = new Float32Array(n * 3), N2 = new Float32Array(n * 3), I2 = new Uint8Array(n * 4), W2 = new Uint8Array(n * 4), R2 = new Uint8Array(n);
  for (let old = 0; old < cremap.length; old++) {
    const j = cremap[old];
    if (j === 0xffffffff) continue;
    P2.set(positions.subarray(old * 3, old * 3 + 3), j * 3);
    N2.set(normals.subarray(old * 3, old * 3 + 3), j * 3);
    // quantize weights to bytes summing to 255
    const w = skinW.slice(old * 4, old * 4 + 4);
    const sum = w.reduce((a, b) => a + b, 0) || 1;
    const q = w.map((x) => Math.round((x / sum) * 255));
    const d = 255 - q.reduce((a, b) => a + b, 0);
    q[q.indexOf(Math.max(...q))] += d;
    for (let k = 0; k < 4; k++) {
      I2[j * 4 + k] = skinI[old * 4 + k];
      W2[j * 4 + k] = q[k];
    }
    R2[j] = region[old];
  }
  normals = N2;
  const nrm8 = new Int8Array(n * 4);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) nrm8[i * 4 + k] = Math.round(Math.max(-1, Math.min(1, N2[i * 3 + k])) * 127);
  const index16 = new Uint16Array(indices);
  if (n > 65535) throw new Error('too many vertices');
  const box = new THREE.Box3().setFromArray(P2);
  console.log(`${name}: ${vcount0} → ${n} verts, ${tris0} → ${indices.length / 3} tris (err ${error.toFixed(4)}), bbox ${box.min.toArray().map((x) => x.toFixed(2))} … ${box.max.toArray().map((x) => x.toFixed(2))}`);
  return { name, rest, vertexCount: n, positions: P2, normals: nrm8, skinIndex: I2, skinWeight: W2, region: R2, index: index16 };
}

const male = buildBody('male', maleMeshes);
const female = buildBody('female', femaleMeshes);

// ---------- clips ----------
const allClips = new Map();
for (const c of [...g1.animations, ...g2.animations]) if (!allClips.has(c.name)) allClips.set(c.name, c);
const pelvisIdx = boneIndex.get('pelvis');
const clips = [];
const _q = new THREE.Quaternion(), _qp = new THREE.Quaternion();
for (const name of CLIPS) {
  const clip = allClips.get(name);
  if (!clip) throw new Error('missing clip ' + name);
  const loop = name.endsWith('_Loop');
  const frames = loop ? Math.max(1, Math.round(clip.duration * FPS)) : Math.round(clip.duration * FPS) + 1;
  const rot = new Float32Array(frames * bones.length * 4);
  const pel = new Float32Array(frames * 3);
  const tracks = new Map();
  for (const t of clip.tracks) tracks.set(t.name, t);
  bones.forEach((b, bi) => {
    const tr = tracks.get(`${b.name}.quaternion`);
    const it = tr && bi !== 0 ? tr.createInterpolant() : null; // root keeps its rest rotation (no root motion)
    for (let f = 0; f < frames; f++) {
      const t = Math.min(clip.duration, f / FPS);
      if (it) _q.fromArray(it.evaluate(t)).normalize();
      else _q.fromArray(male.rest.Q, bi * 4);
      if (bi === 0 && it === null) _q.fromArray(male.rest.Q, 0);
      // keep consecutive frames in the same hemisphere so runtime lerps take the short path
      if (f > 0) {
        _qp.fromArray(rot, ((f - 1) * bones.length + bi) * 4);
        if (_qp.dot(_q) < 0) _q.set(-_q.x, -_q.y, -_q.z, -_q.w);
      }
      _q.toArray(rot, (f * bones.length + bi) * 4);
    }
  });
  const ptr = tracks.get('pelvis.position');
  const pit = ptr?.createInterpolant();
  for (let f = 0; f < frames; f++) {
    if (pit) pel.set(pit.evaluate(Math.min(clip.duration, f / FPS)), f * 3);
    else pel.set(male.rest.T.subarray(pelvisIdx * 3, pelvisIdx * 3 + 3), f * 3);
  }
  clips.push({ name, loop, frames, duration: clip.duration, rot, pel, speed: 0, phase0: 0 });
}

// natural ground speed of locomotion loops (stance-foot backward velocity), via FK on the male rig
const _m = Array.from({ length: bones.length }, () => new THREE.Matrix4());
const _t = new THREE.Vector3(), _one = new THREE.Vector3(1, 1, 1);
function fkFoot(clip, f, footName) {
  for (let i = 0; i < bones.length; i++) {
    _q.fromArray(clip.rot, (f * bones.length + i) * 4);
    if (i === pelvisIdx) _t.fromArray(clip.pel, f * 3);
    else _t.fromArray(male.rest.T, i * 3);
    _m[i].compose(_t, _q, _one);
    if (parents[i] >= 0) _m[i].premultiply(_m[parents[i]]);
  }
  return new THREE.Vector3().setFromMatrixPosition(_m[boneIndex.get(footName)]);
}
for (const c of clips) {
  if (!LOCOMOTION.includes(c.name)) continue;
  // median backward velocity of a foot while it is planted (within 1.2 cm of its lowest point)
  const v = [];
  for (const foot of ['ball_l', 'ball_r']) {
    const p = Array.from({ length: c.frames }, (_, f) => fkFoot(c, f, foot));
    const minY = Math.min(...p.map((q) => q.y));
    for (let f = 0; f < c.frames; f++) {
      const a = p[(f + c.frames - 1) % c.frames], b = p[(f + 1) % c.frames];
      if (p[f].y < minY + 0.012 && a.y < minY + 0.02 && b.y < minY + 0.02) v.push((-(b.z - a.z) * FPS) / 2);
    }
    if (process.env.DEBUG_SPEED === c.name) console.log(foot, p.map((q) => `${q.y.toFixed(3)}/${q.z.toFixed(2)}`).join(' '));
  }
  v.sort((x, y) => x - y);
  c.speed = v.length ? v[v.length >> 1] : 0;
  // gait phase alignment: phase 0 = left foot furthest forward (so blended gaits never cross legs)
  const zl = Array.from({ length: c.frames }, (_, f) => fkFoot(c, f, 'ball_l').z);
  c.phase0 = zl.indexOf(Math.max(...zl)) / c.frames;
  console.log(`speed ${c.name}: ${c.speed.toFixed(2)} m/s (${v.length} planted samples), phase0 ${c.phase0.toFixed(2)}`);
}

// ---------- encode ----------
const chunks = [];
let off = 0;
function put(typed) {
  const pad = (4 - (off % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    off += pad;
  }
  const at = off;
  const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  chunks.push(bytes);
  off += bytes.byteLength;
  return [at, typed.length];
}
function encodeBody(b) {
  return {
    name: b.name, vertexCount: b.vertexCount,
    restT: put(b.rest.T), restQ: put(b.rest.Q), invBind: put(b.rest.inv),
    position: put(b.positions), normal: put(b.normals), skinIndex: put(b.skinIndex), skinWeight: put(b.skinWeight),
    region: put(b.region), index: put(b.index),
  };
}
let rawFloats = 0, storedShorts = 0;
function encodeClip(c) {
  // per bone: constant (1 quaternion) or animated (one per frame); int16 snorm, bone-major
  const nb = bones.length;
  const constMask = new Uint8Array(nb);
  const data = [];
  for (let b = 0; b < nb; b++) {
    let isConst = true;
    for (let f = 1; f < c.frames && isConst; f++) for (let k = 0; k < 4; k++) if (Math.abs(c.rot[(f * nb + b) * 4 + k] - c.rot[b * 4 + k]) > 3e-4) isConst = false;
    constMask[b] = isConst ? 1 : 0;
    const nf = isConst ? 1 : c.frames;
    for (let f = 0; f < nf; f++) for (let k = 0; k < 4; k++) data.push(Math.round(c.rot[(f * nb + b) * 4 + k] * 32767));
  }
  rawFloats += c.frames * nb * 4;
  storedShorts += data.length;
  return { name: c.name, loop: c.loop, frames: c.frames, duration: +c.duration.toFixed(4), speed: +c.speed.toFixed(3), phase0: +c.phase0.toFixed(3), constMask: put(constMask), rot: put(new Int16Array(data)), pelvis: put(c.pel) };
}
const json = {
  version: 1, fps: FPS,
  source: 'Quaternius Universal Animation Library 1+2 (Standard), CC0 1.0',
  bones: bones.map((b, i) => ({ name: b.name, parent: parents[i] })),
  bodies: [encodeBody(male), encodeBody(female)],
  clips: clips.map(encodeClip),
};
console.log(`clips: ${clips.length}, rotation data ${(storedShorts * 2 / 1024).toFixed(0)} KB (raw ${(rawFloats * 4 / 1024).toFixed(0)} KB float)`);
const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jpad = (4 - (jsonBytes.length % 4)) % 4;
const head = new Uint8Array(8);
head.set([0x43, 0x43, 0x52, 0x31]); // "CCR1"
new DataView(head.buffer).setUint32(4, jsonBytes.length + jpad, true);
const parts = [head, jsonBytes, new Uint8Array(jpad).fill(0x20), ...chunks];
const total = parts.reduce((a, p) => a + p.byteLength, 0);
const outBuf = new Uint8Array(total);
let o = 0;
for (const p of parts) {
  outBuf.set(p, o);
  o += p.byteLength;
}
await writeFile(outPath, outBuf);
console.log(`wrote ${outPath}: ${(total / 1024).toFixed(0)} KB`);
