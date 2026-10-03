// Offline character asset build → src/assets/chars.bin
//  - skeleton + 51 motion clips: Quaternius "Universal Animation Library" 1 + 2 (Standard, CC0)
//  - dressed bodies: Quaternius "Ultimate Modular Men" / "Ultimate Modular Women" (CC0), whose
//    head / body / legs / feet parts are rebound onto the animation skeleton (per gender)
//
// Usage: node scripts/build-characters.mjs <UAL1_Standard.glb> <UAL2_Standard.glb> <modularDir> [out.bin]
//   <modularDir> holds men/*.fbx and women/*.fbx (the "Individual Characters/FBX" files of each pack).
// Only geometry, skin weights, bind poses, material colours and bone rotations are read.
//
// File layout: "CCR2" | u32 jsonBytes | JSON (padded to 4) | binary blob. JSON holds offsets into the blob.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [ual1Path, ual2Path, modularDir, outPath = 'src/assets/chars.bin'] = process.argv.slice(2);
if (!modularDir) {
  console.error('usage: node scripts/build-characters.mjs UAL1_Standard.glb UAL2_Standard.glb <modularDir> [out.bin]');
  process.exit(1);
}

const FPS = 30;

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


async function loadGlb(path) {
  const buf = await readFile(path);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const g = await new Promise((res, rej) => new GLTFLoader().parse(ab, '', res, rej));
  g.scene.updateMatrixWorld(true);
  return g;
}
async function loadFbx(path) {
  const buf = await readFile(path);
  const warn = console.warn;
  console.warn = () => {}; // "more than 4 skinning weights" notices
  const o = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  console.warn = warn;
  o.updateMatrixWorld(true);
  return o;
}

const [g1, g2] = await Promise.all([loadGlb(ual1Path), loadGlb(ual2Path)]);

// ---------- skeleton (UAL), leaf bones dropped ----------
let ualMesh = null;
g1.scene.traverse((o) => {
  if (o.isSkinnedMesh && !ualMesh) ualMesh = o;
});
const bones = ualMesh.skeleton.bones.filter((b) => !b.name.includes('leaf'));
const boneIndex = new Map(bones.map((b, i) => [b.name, i]));
const parents = bones.map((b) => (b.parent?.isBone ? boneIndex.get(b.parent.name) : -1));
for (let i = 0; i < bones.length; i++) if (parents[i] >= i) throw new Error('bones not in parent-first order');
console.log(`bones: ${bones.length}`);

/** UAL rest pose: local T/Q (root folds in the Armature node) and model-space rotations / positions. */
const ual = (() => {
  const T = new Float32Array(bones.length * 3), Q = new Float32Array(bones.length * 4);
  const MQ = [], MP = [];
  const m = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  bones.forEach((b, i) => {
    if (parents[i] < 0) m.copy(b.parent.matrixWorld).multiply(b.matrix);
    else m.copy(b.matrix);
    m.decompose(p, q, s);
    T.set([p.x, p.y, p.z], i * 3);
    Q.set([q.x, q.y, q.z, q.w], i * 4);
    b.matrixWorld.decompose(p, q, s);
    MQ.push(q.clone());
    MP.push(p.clone());
  });
  return { T, Q, MQ, MP };
})();

// ---------- modular characters ----------
/** Curated outfits (fantasy / sci-fi ones are left out of a modern city). */
const OUTFITS = {
  male: ['Casual', 'Casual2', 'Beach', 'Punk', 'Suit', 'Worker', 'Farmer', 'Adventurer', 'Swat'],
  female: ['Casual', 'Formal', 'Punk', 'Suit', 'Worker', 'Adventurer', 'Soldier'],
};
/** Paint slots (keep in sync with src/characters/rig/regions.ts `Paint`). */
const P = { skin: 0, hair: 1, brow: 2, eye: 3, top1: 4, top2: 5, bottom: 6, shoes: 7, hat: 8, fixed: 9, face: 10 };
/** Material → paint slot per part ("Outfit_Kind/Material"); unlisted: Skin*→skin, Eye→eye, Eyebrows→brow, Hair*→hair, else fixed. */
const PAINT = {
  male: {
    'Casual_Body/Purple': 'top1', 'Casual_Legs/LightBlue': 'bottom', 'Casual_Feet/Purple': 'shoes',
    'Casual2_Body/LightBrown': 'top1', 'Casual2_Legs/LightBlue': 'bottom', 'Casual2_Feet/Red_Dark': 'shoes',
    'Beach_Body/LightBrown': 'top1', 'Beach_Legs/Red_Dark': 'bottom', 'Beach_Feet/Red_Dark': 'shoes',
    'Punk_Head/Red': 'hair', 'Punk_Head/Red_Dark': 'hair', 'Punk_Body/White': 'top1', 'Punk_Body/Black': 'top2', 'Punk_Legs/LightBlue': 'bottom', 'Punk_Feet/Black': 'shoes',
    'Suit_Body/White': 'top1', 'Suit_Body/Suit': 'top2', 'Suit_Legs/Suit': 'bottom', 'Suit_Feet/Black': 'shoes',
    'Worker_Head/Moustache': 'brow', 'Worker_Body/LightBrown': 'top1', 'Worker_Legs/Brown': 'bottom', 'Worker_Feet/Grey': 'shoes',
    'Farmer_Head/Beige': 'hat', 'Farmer_Body/LightBlue': 'top1', 'Farmer_Body/Brown': 'top2', 'Farmer_Pants/LightBlue': 'bottom', 'Farmer_Feet/Brown': 'shoes',
    'Adventurer_Body/LightGreen': 'top1', 'Adventurer_Body/Green': 'top2', 'Adventurer_Legs/Brown': 'bottom', 'Adventurer_Feet/Grey': 'shoes',
  },
  female: {
    'Casual_Head/Hair_Brown': 'brow', 'Casual_Head/Brown': 'eye', 'Casual_Body/White': 'top1', 'Casual_Legs/Orange': 'bottom', 'Casual_Feet/Grey': 'shoes',
    'Formal_Head/Red': 'hair', 'Formal_Head/Brown': 'eye', 'Formal_Body/LimeGreen': 'top1', 'Formal_Legs/LimeGreen': 'top1', 'Formal_Feet/Red': 'shoes',
    'Punk_Head/Pink': 'hair', 'Punk_Head/Hair_Brown': 'brow', 'Punk_Head/Brown': 'eye', 'Punk_Body/Pink': 'top1', 'Punk_Body/Black': 'top2', 'Punk_Legs/Black': 'bottom', 'Punk_Feet/Black': 'shoes',
    'Suit_Head/Hair_Brown': 'brow', 'Suit_Head/Brown': 'eye', 'Suit_Body/White': 'top1', 'Suit_Body/Black': 'top2', 'Suit_Legs/Black': 'bottom', 'Suit_Feet/Black': 'shoes',
    'Worker_Head/DarkBrown': 'hair', 'Worker_Head/Brown': 'eye', 'Worker_Body/White': 'top1', 'Worker_Legs/Brown_02': 'bottom', 'Worker_Feet/Black': 'shoes',
    'Adventurer_Head/Hair_Brown': 'hair', 'Adventurer_Head/Brown': 'eye', 'Adventurer_Body/LightGreen': 'top1', 'Adventurer_Body/Green': 'top2', 'Adventurer_Legs/LightGreen': 'bottom', 'Adventurer_Feet/Brown_02': 'shoes',
    'Soldier_Head/Hair_Brown': 'hair', 'Soldier_Head/Brown': 'eye', 'Soldier_Body/Swat': 'top1', 'Soldier_Body/Black': 'top2', 'Soldier_Legs/Swat': 'bottom', 'Soldier_Feet/Grey': 'shoes',
  },
};
function paintOf(gender, part, mat) {
  const key = `${part}/${mat}`;
  const t = PAINT[gender][key];
  if (t) return P[t];
  if (/^Skin/.test(mat)) return P.skin;
  if (mat === 'Eye') return P.eye;
  if (mat === 'Eyebrows') return P.brow;
  if (/^Hair/.test(mat)) return P.hair;
  return P.fixed;
}
const KIND = { Head: 0, Body: 1, Legs: 2, Pants: 2, Feet: 3 };

/** Modular joint name for a UAL bone, per gender (finger chains are matched by order). */
function jointMap(names) {
  const map = new Map([
    ['pelvis', 'Hips'], ['spine_01', 'Abdomen'], ['spine_02', 'Torso'], ['spine_03', 'Chest'], ['neck_01', 'Neck'], ['Head', 'Head'],
  ]);
  for (const [s, S] of [['l', 'L'], ['r', 'R']]) {
    map.set(`clavicle_${s}`, `Shoulder${S}`);
    map.set(`upperarm_${s}`, `UpperArm${S}`);
    map.set(`lowerarm_${s}`, `LowerArm${S}`);
    map.set(`hand_${s}`, `Hand${S}`);
    map.set(`thigh_${s}`, `UpperLeg${S}`);
    map.set(`calf_${s}`, `LowerLeg${S}`);
    for (const f of ['index', 'middle', 'ring', 'pinky', 'thumb']) {
      const F = f[0].toUpperCase() + f.slice(1);
      const chain = names.filter((n) => new RegExp(`^${F}\\d${S}$`).test(n)).sort();
      // UAL chains have 3 joints; a 2-joint modular chain fills the outer two
      const off = 3 - chain.length;
      chain.forEach((n, k) => map.set(`${f}_0${k + 1 + off}_${s}`, n));
    }
  }
  return map;
}

const QS = 16384; // position quantization (int16 / QS metres)
const skeletons = [];
const parts = [];
const partHashes = new Map();
for (const gender of ['male', 'female']) {
  const dir = join(modularDir, gender === 'male' ? 'men' : 'women');
  const objs = [];
  for (const name of OUTFITS[gender]) objs.push([name, await loadFbx(join(dir, name + '.fbx'))]);
  // modular bind-pose joints (metres) from the first character (all share one skeleton per gender)
  const ref = objs[0][1];
  const J = new Map();
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  ref.traverse((o) => {
    if (o.isBone && !J.has(o.name)) {
      o.matrixWorld.decompose(p, q, s);
      J.set(o.name, p.clone().multiplyScalar(0.01));
    }
  });
  const jm = jointMap([...J.keys()]);
  // target positions for every UAL bone
  const pos = bones.map((b, i) => {
    const n = jm.get(b.name);
    if (n && J.has(n)) return J.get(n).clone();
    return null;
  });
  // feet: the modular foot joint sits at the sole; pivot at the ankle instead (weights are unchanged)
  for (const sd of ['l', 'r']) {
    const fi = boneIndex.get(`foot_${sd}`), ci = boneIndex.get(`calf_${sd}`);
    const sole = J.get(`Foot${sd.toUpperCase()}`);
    pos[fi] = new THREE.Vector3(sole.x, 0.085, sole.z - 0.015);
    const end = J.get(`Foot${sd.toUpperCase()}_end`) ?? sole.clone().add(new THREE.Vector3(0, 0, 0.15));
    pos[boneIndex.get(`ball_${sd}`)] = new THREE.Vector3(sole.x, 0.03, sole.z + (end.z - sole.z) * 0.6 + 0.06);
    void ci;
  }
  pos[0] = new THREE.Vector3(0, 0, 0); // root
  // anything still unmapped (e.g. a missing thumb base): halfway between parent and first mapped child
  for (let i = 0; i < bones.length; i++) {
    if (pos[i]) continue;
    const kid = bones.findIndex((_, k) => parents[k] === i && pos[k]);
    pos[i] = kid >= 0 ? pos[parents[i]].clone().lerp(pos[kid], 0.45) : pos[parents[i]].clone().add(ual.MP[i].clone().sub(ual.MP[parents[i]]));
  }
  // rest locals: UAL rest rotations (same T-pose conventions), modular joint positions
  const T = new Float32Array(bones.length * 3), Q = new Float32Array(ual.Q);
  const v = new THREE.Vector3();
  for (let i = 0; i < bones.length; i++) {
    const pa = parents[i];
    if (pa < 0) v.copy(pos[i]);
    else v.subVectors(pos[i], pos[pa]).applyQuaternion(ual.MQ[pa].clone().invert());
    T.set([v.x, v.y, v.z], i * 3);
  }
  const pel = boneIndex.get('pelvis');
  const pelvisOffset = [0, 1, 2].map((a) => T[pel * 3 + a] - ual.T[pel * 3 + a]);
  const legU = ual.MP[boneIndex.get('thigh_l')].y - ual.MP[boneIndex.get('foot_l')].y;
  const legM = pos[boneIndex.get('thigh_l')].y - pos[boneIndex.get('foot_l')].y;
  skeletons.push({ gender, T, Q, pelvisOffset, legScale: legM / legU });
  console.log(`${gender}: pelvis ${pos[pel].toArray().map((x) => x.toFixed(3))}, leg scale ${(legM / legU).toFixed(3)}`);

  // name → UAL index for skinning (end joints fall back to their parent)
  const toUal = new Map();
  for (const [u, n] of jm) toUal.set(n, boneIndex.get(u));
  toUal.set('Root', 0);
  toUal.set(`FootL`, boneIndex.get('foot_l'));
  toUal.set(`FootR`, boneIndex.get('foot_r'));

  for (const [outfit, obj] of objs) {
    obj.traverse((mesh) => {
      if (!mesh.isSkinnedMesh) return;
      const kindName = mesh.name.split('_').pop();
      if (!(kindName in KIND)) return; // e.g. the adventurer's backpack
      const partName = `${outfit}_${kindName}`;
      const g = mesh.geometry;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const groups = g.groups.length ? g.groups : [{ start: 0, count: g.attributes.position.count, materialIndex: 0 }];
      const sk = mesh.skeleton;
      const boneMapIdx = sk.bones.map((b) => {
        let n = b;
        while (n && n.isBone && !toUal.has(n.name)) n = n.parent;
        return n && toUal.has(n.name) ? toUal.get(n.name) : 0;
      });
      const nm = new THREE.Matrix3().getNormalMatrix(mesh.bindMatrix);
      const Pa = g.attributes.position, Na = g.attributes.normal, Ia = g.attributes.skinIndex, Wa = g.attributes.skinWeight;
      // weld by quantized position + paint + colour (flat shading comes from screen-space derivatives)
      const key = new Map();
      const vp = [], vn = [], vi = [], vw = [], vc = [];
      const idx = [];
      const w = new THREE.Vector3(), n3 = new THREE.Vector3();
      for (const gr of groups) {
        const mat = mats[gr.materialIndex];
        let paint = paintOf(gender, `${outfit}_${kindName}`, mat.name);
        if (paint === P.skin && KIND[kindName] === 0) paint = P.face; // face skin (beards are painted on it)
        const col = mat.color.getHex();
        for (let k = gr.start; k < gr.start + gr.count; k++) {
          w.fromBufferAttribute(Pa, k).applyMatrix4(mesh.bindMatrix).multiplyScalar(0.01);
          const qx = Math.round(w.x * QS), qy = Math.round(w.y * QS), qz = Math.round(w.z * QS);
          const kk = `${qx},${qy},${qz},${paint},${col}`;
          let id = key.get(kk);
          n3.fromBufferAttribute(Na, k).applyMatrix3(nm).normalize();
          if (id === undefined) {
            id = vp.length / 3;
            key.set(kk, id);
            vp.push(qx, qy, qz);
            vn.push(0, 0, 0);
            // remap + renormalize weights onto UAL bones (merge duplicates)
            const acc = new Map();
            for (let c = 0; c < 4; c++) {
              const wt = Wa.getComponent(k, c);
              if (wt <= 0) continue;
              const b = boneMapIdx[Ia.getComponent(k, c)];
              acc.set(b, (acc.get(b) ?? 0) + wt);
            }
            const top = [...acc].sort((a, b) => b[1] - a[1]).slice(0, 4);
            const sum = top.reduce((a, b) => a + b[1], 0) || 1;
            const qw = top.map(([, x]) => Math.round((x / sum) * 255));
            if (qw.length) qw[0] += 255 - qw.reduce((a, b) => a + b, 0);
            for (let c = 0; c < 4; c++) {
              vi.push(top[c]?.[0] ?? 0);
              vw.push(qw[c] ?? 0);
            }
            vc.push((col >> 16) & 255, (col >> 8) & 255, col & 255, paint);
          }
          vn[id * 3] += n3.x;
          vn[id * 3 + 1] += n3.y;
          vn[id * 3 + 2] += n3.z;
          idx.push(id);
        }
      }
      const nv = vp.length / 3;
      if (nv > 65535) throw new Error('part too big ' + partName);
      const nrm = new Int8Array(nv * 4);
      for (let i = 0; i < nv; i++) {
        const l = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2]) || 1;
        for (let a = 0; a < 3; a++) nrm[i * 4 + a] = Math.round((vn[i * 3 + a] / l) * 127);
      }
      const position = new Int16Array(nv * 4);
      for (let i = 0; i < nv; i++) position.set([vp[i * 3], vp[i * 3 + 1], vp[i * 3 + 2], 0], i * 4);
      // identical parts (e.g. women's Casual and Suit heads) are stored once
      let h = 0;
      for (const x of vp) h = (Math.imul(h, 31) + x) | 0;
      for (const x of vc) h = (Math.imul(h, 31) + x) | 0;
      const hk = `${gender}:${KIND[kindName]}:${nv}:${h}`;
      if (partHashes.has(hk)) {
        partHashes.get(hk).aliases.push(partName);
        return;
      }
      const part = {
        name: partName, gender, kind: KIND[kindName], vertexCount: nv, aliases: [],
        position, normal: nrm, skinIndex: new Uint8Array(vi), skinWeight: new Uint8Array(vw), color: new Uint8Array(vc), index: new Uint16Array(idx),
      };
      partHashes.set(hk, part);
      parts.push(part);
    });
  }
}
const totalV = parts.reduce((a, p) => a + p.vertexCount, 0), totalT = parts.reduce((a, p) => a + p.index.length / 3, 0);
console.log(`parts: ${parts.length}, ${totalV} vertices, ${totalT} triangles`);
for (const pt of parts) console.log(`  ${pt.gender} ${pt.name}${pt.aliases.length ? ' (=' + pt.aliases.join(',') + ')' : ''}: ${pt.vertexCount} v, ${pt.index.length / 3} t`);

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
      else _q.fromArray(ual.Q, bi * 4);
      if (bi === 0 && it === null) _q.fromArray(ual.Q, 0);
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
    else pel.set(ual.T.subarray(pelvisIdx * 3, pelvisIdx * 3 + 3), f * 3);
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
    else _t.fromArray(ual.T, i * 3);
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
function encodeSkeleton(sk) {
  return { gender: sk.gender, restT: put(sk.T), restQ: put(sk.Q), pelvisOffset: sk.pelvisOffset.map((x) => +x.toFixed(5)), legScale: +sk.legScale.toFixed(4) };
}
function encodePart(pt) {
  return {
    name: pt.name, aliases: pt.aliases, gender: pt.gender, kind: pt.kind, vertexCount: pt.vertexCount, quant: QS,
    position: put(pt.position), normal: put(pt.normal), skinIndex: put(pt.skinIndex), skinWeight: put(pt.skinWeight), color: put(pt.color), index: put(pt.index),
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
  version: 2, fps: FPS,
  source: 'Quaternius Universal Animation Library 1+2 (Standard) and Ultimate Modular Men / Women, CC0 1.0',
  bones: bones.map((b, i) => ({ name: b.name, parent: parents[i] })),
  skeletons: skeletons.map(encodeSkeleton),
  parts: parts.map(encodePart),
  clips: clips.map(encodeClip),
};
console.log(`clips: ${clips.length}, rotation data ${(storedShorts * 2 / 1024).toFixed(0)} KB (raw ${(rawFloats * 4 / 1024).toFixed(0)} KB float)`);
const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jpad = (4 - (jsonBytes.length % 4)) % 4;
const head = new Uint8Array(8);
head.set([0x43, 0x43, 0x52, 0x32]); // "CCR2"
new DataView(head.buffer).setUint32(4, jsonBytes.length + jpad, true);
const out = [head, jsonBytes, new Uint8Array(jpad).fill(0x20), ...chunks];
const total = out.reduce((a, p) => a + p.byteLength, 0);
const outBuf = new Uint8Array(total);
let o = 0;
for (const p of out) {
  outBuf.set(p, o);
  o += p.byteLength;
}
await writeFile(outPath, outBuf);
console.log(`wrote ${outPath}: ${(total / 1024).toFixed(0)} KB`);
