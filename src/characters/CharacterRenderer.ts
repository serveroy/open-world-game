import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Pose } from './Pose';
import type { Appearance, BeardStyle, HairStyle, HatStyle } from './Appearance';
import { litMaterial } from '../render/materials';

/** Items a character can hold in the right hand. */
export type HeldItem = 'none' | 'pistol' | 'smg' | 'shotgun' | 'rifle' | 'sniper' | 'bat' | 'knife' | 'grenade' | 'molotov' | 'phone' | 'lockpick' | 'baton';

/** Skeleton dimensions (scale 1 → ~1.80 m tall). */
export const SK = {
  hipH: 0.97,
  spineUp: 0.06,
  torsoH: 0.5,
  shoulderX: 0.2,
  shoulderY: 0.44,
  upperArm: 0.28,
  lowerArm: 0.25,
  hipX: 0.095,
  hipY: -0.06,
  upperLeg: 0.42,
  lowerLeg: 0.43,
  headY: 0.16,
};

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

type PartName =
  | 'pelvis' | 'torso' | 'head' | 'upperArm' | 'lowerArm' | 'hand' | 'upperLeg' | 'lowerLeg' | 'foot' | 'jacket' | 'tatArm' | 'tatNeck'
  | `hair_${Exclude<HairStyle, 'none'>}` | `beard_${Exclude<BeardStyle, 'none'>}` | `hat_${Exclude<HatStyle, 'none'>}` | `item_${Exclude<HeldItem, 'none'>}`;

interface Part {
  mesh: THREE.InstancedMesh;
  perChar: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

const mRoot = new THREE.Matrix4();
const mPelvis = new THREE.Matrix4();
const mSpine = new THREE.Matrix4();
const mHead = new THREE.Matrix4();
const mLSh = new THREE.Matrix4();
const mLEl = new THREE.Matrix4();
const mRSh = new THREE.Matrix4();
const mREl = new THREE.Matrix4();
const mLHip = new THREE.Matrix4();
const mLKnee = new THREE.Matrix4();
const mRHip = new THREE.Matrix4();
const mRKnee = new THREE.Matrix4();
const mLHand = new THREE.Matrix4();
const mRHand = new THREE.Matrix4();
const mItem = new THREE.Matrix4();

function rotM(out: THREE.Matrix4, x: number, y: number, z: number, order: THREE.EulerOrder): THREE.Matrix4 {
  _e.set(x, y, z, order);
  return out.makeRotationFromEuler(_e);
}
/** out = parent * T(tx,ty,tz) * R */
function joint(out: THREE.Matrix4, parent: THREE.Matrix4, tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, order: THREE.EulerOrder): void {
  rotM(_m, rx, ry, rz, order);
  _m.setPosition(tx, ty, tz);
  out.multiplyMatrices(parent, _m);
}

/** Vertex-colour helper: sets colour on all verts (multiplied with instance colour). */
function vc(geo: THREE.BufferGeometry, r: number, g = r, b = r): THREE.BufferGeometry {
  const n = geo.attributes.position!.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = r;
    a[i * 3 + 1] = g;
    a[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  if (geo.index) return geo.toNonIndexed();
  return geo;
}
function merged(...g: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = g.map((x) => (x.index ? x.toNonIndexed() : x));
  for (const p of parts) p.deleteAttribute('uv');
  const m = mergeGeometries(parts, false);
  if (!m) throw new Error('merge failed');
  m.computeVertexNormals();
  return m;
}
function limb(radius: number, length: number, r2 = radius): THREE.BufferGeometry {
  // tapered capsule hanging from origin down -Y
  const g = new THREE.CapsuleGeometry(1, 1, 3, 8);
  g.scale(radius, length / 3 + 0.0001, radius);
  const pos = g.attributes.position!;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = (y + length / 2) / length; // 0 bottom → 1 top (approx)
    const s = r2 / radius + (1 - r2 / radius) * Math.min(1, Math.max(0, t));
    pos.setX(i, pos.getX(i) * s);
    pos.setZ(i, pos.getZ(i) * s);
  }
  g.translate(0, -length / 2, 0);
  return vc(g, 1);
}

function buildGeometries(): Record<PartName, THREE.BufferGeometry> {
  const torso = new THREE.BoxGeometry(0.36, SK.torsoH, 0.22, 2, 3, 2);
  {
    const p = torso.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / SK.torsoH + 0.5; // 0..1
      const w = 0.84 + 0.26 * Math.min(1, y * 1.3);
      p.setX(i, p.getX(i) * w * (y > 0.9 ? 0.85 : 1));
      const d = y > 0.45 && y < 0.85 ? 1.08 : 1;
      p.setZ(i, p.getZ(i) * d + (y > 0.45 && y < 0.85 && p.getZ(i) > 0 ? 0.01 : 0));
    }
    torso.translate(0, SK.torsoH / 2, 0);
  }
  const pelvis = new THREE.BoxGeometry(0.33, 0.2, 0.21);
  pelvis.translate(0, -0.04, 0);
  const headSphere = new THREE.SphereGeometry(0.112, 12, 9);
  headSphere.scale(0.92, 1.08, 1);
  headSphere.translate(0, SK.headY, 0.0);
  const neck = new THREE.CylinderGeometry(0.048, 0.055, 0.1, 8);
  neck.translate(0, 0.04, 0);
  const nose = new THREE.BoxGeometry(0.03, 0.045, 0.04);
  nose.translate(0, SK.headY - 0.01, 0.105);
  const eyes = new THREE.BoxGeometry(0.11, 0.022, 0.02);
  eyes.translate(0, SK.headY + 0.02, 0.098);
  const brows = new THREE.BoxGeometry(0.12, 0.012, 0.02);
  brows.translate(0, SK.headY + 0.048, 0.1);
  const mouth = new THREE.BoxGeometry(0.05, 0.012, 0.02);
  mouth.translate(0, SK.headY - 0.055, 0.094);
  const earL = new THREE.BoxGeometry(0.02, 0.05, 0.03);
  earL.translate(0.105, SK.headY, 0);
  const earR = earL.clone();
  earR.translate(-0.21, 0, 0);
  const head = merged(vc(headSphere, 1), vc(neck, 0.95), vc(nose, 0.97), vc(eyes, 0.08), vc(brows, 0.25), vc(mouth, 0.55, 0.3, 0.3), vc(earL, 0.95), vc(earR, 0.95));

  const upperArm = limb(0.058, SK.upperArm, 0.05);
  const lowerArm = limb(0.05, SK.lowerArm, 0.04);
  const handG = new THREE.BoxGeometry(0.07, 0.09, 0.035);
  handG.translate(0, -0.045, 0.005);
  const thumb = new THREE.BoxGeometry(0.02, 0.05, 0.025);
  thumb.translate(0.035, -0.03, 0.02);
  const hand = merged(vc(handG, 1), vc(thumb, 1));
  const upperLeg = limb(0.082, SK.upperLeg, 0.062);
  const lowerLeg = limb(0.062, SK.lowerLeg, 0.045);
  const footG = new THREE.BoxGeometry(0.1, 0.075, 0.25);
  footG.translate(0, -0.035, 0.05);
  const sole = new THREE.BoxGeometry(0.105, 0.02, 0.255);
  sole.translate(0, -0.07, 0.05);
  const foot = merged(vc(footG, 1), vc(sole, 0.4));

  const jacketG = new THREE.BoxGeometry(0.4, SK.torsoH * 0.98, 0.25, 1, 2, 1);
  {
    const p = jacketG.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) / SK.torsoH + 0.5;
      p.setX(i, p.getX(i) * (0.9 + 0.22 * Math.min(1, y * 1.3)));
    }
    jacketG.translate(0, SK.torsoH * 0.5, 0);
  }
  const collar = new THREE.BoxGeometry(0.2, 0.06, 0.2);
  collar.translate(0, SK.torsoH, -0.02);
  const jacket = merged(vc(jacketG, 1), vc(collar, 0.85));
  const tatArm = limb(0.06, 0.12, 0.055);
  tatArm.translate(0, -0.08, 0);
  const tatNeckG = new THREE.CylinderGeometry(0.058, 0.06, 0.05, 10, 1, true);
  tatNeckG.translate(0, 0.03, 0);
  const tatNeck = vc(tatNeckG, 1);

  // hair
  const hShort = new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  hShort.scale(0.96, 1.05, 1.06);
  hShort.translate(0, SK.headY + 0.012, -0.008);
  const hLongBack = new THREE.BoxGeometry(0.21, 0.26, 0.08);
  hLongBack.translate(0, SK.headY - 0.07, -0.085);
  const hMohawk = new THREE.BoxGeometry(0.04, 0.08, 0.22);
  hMohawk.translate(0, SK.headY + 0.12, -0.01);
  const hBun = new THREE.SphereGeometry(0.055, 8, 6);
  hBun.translate(0, SK.headY + 0.09, -0.1);
  const hAfro = new THREE.SphereGeometry(0.17, 10, 8);
  hAfro.scale(1, 0.85, 1);
  hAfro.translate(0, SK.headY + 0.06, -0.02);
  const hSlick = new THREE.SphereGeometry(0.122, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.42);
  hSlick.scale(0.97, 1.0, 1.1);
  hSlick.translate(0, SK.headY + 0.02, -0.015);

  const bStubble = new THREE.SphereGeometry(0.114, 10, 6, 0, Math.PI, Math.PI * 0.55, Math.PI * 0.4);
  bStubble.rotateY(-Math.PI / 2);
  bStubble.scale(0.94, 1.08, 1.02);
  bStubble.translate(0, SK.headY, 0.002);
  const bFull = new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI, Math.PI * 0.5, Math.PI * 0.5);
  bFull.rotateY(-Math.PI / 2);
  bFull.scale(0.95, 1.15, 1.08);
  bFull.translate(0, SK.headY - 0.01, 0.01);
  const bGoatee = new THREE.BoxGeometry(0.045, 0.05, 0.03);
  bGoatee.translate(0, SK.headY - 0.085, 0.09);

  const capDome = new THREE.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
  capDome.translate(0, SK.headY + 0.02, 0);
  const capBill = new THREE.BoxGeometry(0.17, 0.015, 0.11);
  capBill.translate(0, SK.headY + 0.03, 0.13);
  const polTop = new THREE.CylinderGeometry(0.135, 0.12, 0.07, 12);
  polTop.translate(0, SK.headY + 0.1, 0);
  const helm = new THREE.SphereGeometry(0.14, 10, 7, 0, Math.PI * 2, 0, Math.PI * 0.6);
  helm.translate(0, SK.headY + 0.005, -0.005);
  const visor = new THREE.BoxGeometry(0.2, 0.05, 0.03);
  visor.translate(0, SK.headY + 0.03, 0.125);
  const beanie = new THREE.SphereGeometry(0.128, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  beanie.scale(1, 1.15, 1);
  beanie.translate(0, SK.headY + 0.015, -0.005);

  // held items (barrel along +Z; grip at origin)
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, c = 1): THREE.BufferGeometry => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, z);
    return vc(b, c);
  };
  const pistol = merged(box(0.035, 0.05, 0.19, 0, 0.04, 0.06, 0.35), box(0.03, 0.11, 0.045, 0, -0.01, 0, 0.25));
  const smg = merged(box(0.045, 0.07, 0.34, 0, 0.04, 0.1, 0.3), box(0.03, 0.12, 0.04, 0, -0.03, 0, 0.2), box(0.03, 0.15, 0.04, 0, -0.04, 0.12, 0.15), box(0.02, 0.02, 0.1, 0, 0.05, 0.31, 0.25));
  const shotgun = merged(box(0.05, 0.07, 0.7, 0, 0.04, 0.22, 0.35), box(0.04, 0.12, 0.18, 0, -0.02, -0.12, 0.45), box(0.05, 0.05, 0.22, 0, 0.0, 0.3, 0.5));
  const rifle = merged(box(0.045, 0.08, 0.72, 0, 0.04, 0.2, 0.28), box(0.04, 0.12, 0.2, 0, 0.0, -0.13, 0.22), box(0.035, 0.16, 0.05, 0, -0.06, 0.12, 0.18), box(0.03, 0.04, 0.12, 0, 0.1, 0.14, 0.2));
  const sniper = merged(box(0.04, 0.07, 1.0, 0, 0.04, 0.32, 0.3), box(0.04, 0.12, 0.24, 0, 0.0, -0.15, 0.4), box(0.04, 0.05, 0.24, 0, 0.11, 0.12, 0.15));
  const bat = merged(box(0.04, 0.04, 0.3, 0, 0, 0.1, 0.55), box(0.065, 0.065, 0.55, 0, 0, 0.5, 0.8));
  const knife = merged(box(0.025, 0.03, 0.1, 0, 0, 0.02, 0.2), box(0.008, 0.035, 0.16, 0, 0.005, 0.15, 1.3));
  const grenade = vc(new THREE.SphereGeometry(0.045, 8, 6), 0.4, 0.5, 0.3);
  const molotov = merged(box(0.07, 0.07, 0.16, 0, 0, 0.05, 0.6), box(0.03, 0.03, 0.08, 0, 0, 0.16, 1.1));
  const phone = box(0.06, 0.12, 0.012, 0, -0.02, 0.03, 0.15);
  const lockpick = box(0.008, 0.008, 0.12, 0, 0, 0.05, 1.1);
  const baton = box(0.035, 0.035, 0.5, 0, 0, 0.18, 0.15);

  return {
    pelvis: vc(pelvis, 1), torso: vc(torso, 1), head, upperArm, lowerArm, hand, upperLeg, lowerLeg, foot, jacket, tatArm, tatNeck,
    hair_short: vc(hShort, 1), hair_long: merged(vc(hShort.clone(), 1), vc(hLongBack, 1)), hair_mohawk: vc(hMohawk, 1),
    hair_bun: merged(vc(hShort.clone(), 1), vc(hBun, 1)), hair_afro: vc(hAfro, 1), hair_slick: vc(hSlick, 1),
    beard_stubble: vc(bStubble, 1), beard_full: vc(bFull, 1), beard_goatee: vc(bGoatee, 1),
    hat_cap: merged(vc(capDome, 1), vc(capBill, 1)), hat_police: merged(vc(capDome.clone(), 1), vc(polTop, 1), vc(capBill.clone(), 0.3)),
    hat_helmet: merged(vc(helm, 1), vc(visor, 0.3)), hat_beanie: vc(beanie, 1),
    item_pistol: pistol, item_smg: smg, item_shotgun: shotgun, item_rifle: rifle, item_sniper: sniper, item_bat: bat, item_knife: knife,
    item_grenade: grenade, item_molotov: molotov, item_phone: phone, item_lockpick: lockpick, item_baton: baton,
  };
}

interface Slot {
  used: boolean;
  app: Appearance;
  visible: boolean;
  /** Joint world positions (filled on update). */
  joints: THREE.Vector3[];
  ragdoll: THREE.Matrix4[] | null;
  /** Last FK frames (unscaled pivots): pelvis, spine, head, lShoulder, rShoulder, lHip, rHip. */
  frames: THREE.Matrix4[];
}

/**
 * Renders all humanoids via one InstancedMesh per body part.
 * Each character occupies a slot; per-frame call `update(slot, …)` then `commit()`.
 */
export class CharacterRenderer {
  readonly group = new THREE.Group();
  private parts = new Map<PartName, Part>();
  private slots: Slot[] = [];
  private dirty = new Set<THREE.InstancedMesh>();

  constructor(scene: THREE.Scene, readonly capacity: number, castShadow: boolean) {
    const geos = buildGeometries();
    const mat = litMaterial('character', { vertexColors: true, roughness: 0.85 });
    const itemMat = litMaterial('items', { vertexColors: true, roughness: 0.4, metalness: 0.5 });
    for (const [name, geo] of Object.entries(geos) as [PartName, THREE.BufferGeometry][]) {
      const perChar = ['upperArm', 'lowerArm', 'hand', 'upperLeg', 'lowerLeg', 'foot', 'tatArm'].includes(name) ? 2 : 1;
      const mesh = new THREE.InstancedMesh(geo, name.startsWith('item_') ? itemMat : mat, capacity * perChar);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.castShadow = castShadow;
      mesh.receiveShadow = false;
      mesh.name = `char_${name}`;
      for (let i = 0; i < capacity * perChar; i++) {
        mesh.setMatrixAt(i, ZERO);
        mesh.setColorAt(i, _c.set(0xffffff));
      }
      mesh.count = capacity * perChar;
      this.group.add(mesh);
      this.parts.set(name, { mesh, perChar });
    }
    scene.add(this.group);
  }

  setShadows(on: boolean): void {
    for (const p of this.parts.values()) p.mesh.castShadow = on;
  }

  alloc(app: Appearance): number {
    let i = this.slots.findIndex((s) => !s.used);
    if (i < 0) {
      if (this.slots.length >= this.capacity) return -1;
      i = this.slots.length;
      this.slots.push({ used: false, app, visible: false, joints: Array.from({ length: 8 }, () => new THREE.Vector3()), ragdoll: null, frames: Array.from({ length: 7 }, () => new THREE.Matrix4()) });
    }
    const s = this.slots[i]!;
    s.used = true;
    s.ragdoll = null;
    this.setAppearance(i, app);
    return i;
  }

  free(slot: number): void {
    const s = this.slots[slot];
    if (!s) return;
    s.used = false;
    s.ragdoll = null;
    this.hide(slot);
  }

  get used(): number {
    let n = 0;
    for (const s of this.slots) if (s.used) n++;
    return n;
  }

  setAppearance(slot: number, app: Appearance): void {
    const s = this.slots[slot]!;
    s.app = app;
    const shirtArm = app.top === 'tank' ? app.skin : app.top === 'vest' ? app.shirt : app.shirt;
    const sleeve = app.top === 'long' || app.top === 'jacket' || app.top === 'suit' ? (app.top === 'long' ? app.shirt : app.jacket) : app.skin;
    const upper = app.top === 'jacket' || app.top === 'suit' ? app.jacket : app.top === 'vest' ? app.skin : shirtArm;
    const legLower = app.bottom === 'shorts' ? app.skin : app.pants;
    this.color('pelvis', slot, 0, app.pants);
    this.color('torso', slot, 0, app.shirt);
    this.color('head', slot, 0, app.skin);
    this.color('upperArm', slot, 0, upper);
    this.color('upperArm', slot, 1, upper);
    this.color('lowerArm', slot, 0, sleeve);
    this.color('lowerArm', slot, 1, sleeve);
    this.color('hand', slot, 0, app.skin);
    this.color('hand', slot, 1, app.skin);
    this.color('upperLeg', slot, 0, app.pants);
    this.color('upperLeg', slot, 1, app.pants);
    this.color('lowerLeg', slot, 0, legLower);
    this.color('lowerLeg', slot, 1, legLower);
    this.color('foot', slot, 0, app.shoes);
    this.color('foot', slot, 1, app.shoes);
    this.color('jacket', slot, 0, app.top === 'vest' ? 0x2a2e34 : app.jacket);
    this.color('tatArm', slot, 0, app.tattooColor);
    this.color('tatArm', slot, 1, app.tattooColor);
    this.color('tatNeck', slot, 0, app.tattooColor);
    for (const hs of ['short', 'long', 'mohawk', 'bun', 'afro', 'slick'] as const) this.color(`hair_${hs}`, slot, 0, app.hair);
    for (const b of ['stubble', 'full', 'goatee'] as const) this.color(`beard_${b}`, slot, 0, b === 'stubble' ? lighten(app.hair, app.skin) : app.hair);
    for (const h of ['cap', 'police', 'helmet', 'beanie'] as const) this.color(`hat_${h}`, slot, 0, app.hatColor);
  }

  private color(name: PartName, slot: number, sub: number, hex: number): void {
    const p = this.parts.get(name)!;
    p.mesh.setColorAt(slot * p.perChar + sub, _c.setHex(hex));
    if (p.mesh.instanceColor) p.mesh.instanceColor.needsUpdate = true;
  }

  private set(name: PartName, slot: number, sub: number, m: THREE.Matrix4): void {
    const p = this.parts.get(name)!;
    p.mesh.setMatrixAt(slot * p.perChar + sub, m);
    this.dirty.add(p.mesh);
  }

  hide(slot: number): void {
    const s = this.slots[slot];
    if (s) s.visible = false;
    for (const p of this.parts.values()) {
      for (let k = 0; k < p.perChar; k++) p.mesh.setMatrixAt(slot * p.perChar + k, ZERO);
      this.dirty.add(p.mesh);
    }
  }

  jointWorld(slot: number, j: Joint): THREE.Vector3 {
    return this.slots[slot]!.joints[j]!;
  }

  /**
   * Pose a character. `yaw` 0 faces +Z. `ragdoll` overrides part matrices with
   * 7 world matrices [pelvis, torso, head, lUpperArm, rUpperArm, lUpperLeg, rUpperLeg].
   */
  update(slot: number, x: number, y: number, z: number, yaw: number, pose: Pose, held: HeldItem, ragdoll?: THREE.Matrix4[] | null): void {
    const s = this.slots[slot];
    if (!s || !s.used) return;
    s.visible = true;
    const app = s.app;
    const sc = app.height;
    if (ragdoll) {
      this.updateRagdoll(slot, s, ragdoll, held);
      return;
    }
    mRoot.compose(_v.set(x, y, z), _q.setFromAxisAngle(_s.set(0, 1, 0), yaw), _s.set(sc, sc, sc));
    joint(mPelvis, mRoot, 0, SK.hipH + pose.rootY, 0, pose.rootPitch, pose.pelvisYaw, pose.rootRoll, 'YXZ');
    joint(mSpine, mPelvis, 0, SK.spineUp, 0, pose.spinePitch, pose.spineYaw - pose.pelvisYaw, pose.spineRoll, 'YXZ');
    joint(mHead, mSpine, 0, SK.torsoH, 0, pose.headPitch, pose.headYaw, 0, 'YXZ');
    const bw = app.build;
    joint(mLSh, mSpine, SK.shoulderX * bw, SK.shoulderY, 0, -pose.lShoulderPitch, pose.lShoulderYaw, pose.lShoulderRoll, 'ZYX');
    joint(mRSh, mSpine, -SK.shoulderX * bw, SK.shoulderY, 0, -pose.rShoulderPitch, -pose.rShoulderYaw, -pose.rShoulderRoll, 'ZYX');
    joint(mLEl, mLSh, 0, -SK.upperArm, 0, -pose.lElbow, 0, 0, 'XYZ');
    joint(mREl, mRSh, 0, -SK.upperArm, 0, -pose.rElbow, 0, 0, 'XYZ');
    joint(mLHand, mLEl, 0, -SK.lowerArm, 0, 0, 0, 0, 'XYZ');
    joint(mRHand, mREl, 0, -SK.lowerArm, 0, 0, 0, 0, 'XYZ');
    joint(mLHip, mPelvis, SK.hipX, SK.hipY, 0, -pose.lHip, 0, pose.lHipRoll * 0.5, 'ZYX');
    joint(mRHip, mPelvis, -SK.hipX, SK.hipY, 0, -pose.rHip, 0, -pose.rHipRoll * 0.5, 'ZYX');
    joint(mLKnee, mLHip, 0, -SK.upperLeg, 0, pose.lKnee, 0, 0, 'XYZ');
    joint(mRKnee, mRHip, 0, -SK.upperLeg, 0, pose.rKnee, 0, 0, 'XYZ');

    this.set('pelvis', slot, 0, mPelvis);
    _m2.makeScale(bw, 1, 0.9 + (bw - 1) * 0.6 + (app.female ? 0.04 : 0));
    this.set('torso', slot, 0, _m.multiplyMatrices(mSpine, _m2));
    this.set('head', slot, 0, mHead);
    this.set('upperArm', slot, 0, mLSh);
    this.set('upperArm', slot, 1, mRSh);
    this.set('lowerArm', slot, 0, mLEl);
    this.set('lowerArm', slot, 1, mREl);
    this.set('hand', slot, 0, mLHand);
    this.set('hand', slot, 1, mRHand);
    this.set('upperLeg', slot, 0, mLHip);
    this.set('upperLeg', slot, 1, mRHip);
    _m.copy(mLKnee);
    this.set('lowerLeg', slot, 0, mLKnee);
    this.set('lowerLeg', slot, 1, mRKnee);
    joint(_m2, mLKnee, 0, -SK.lowerLeg, 0, -pose.lKnee * 0.3 + 0.0, 0, 0, 'XYZ');
    this.set('foot', slot, 0, _m2);
    joint(_m2, mRKnee, 0, -SK.lowerLeg, 0, -pose.rKnee * 0.3, 0, 0, 'XYZ');
    this.set('foot', slot, 1, _m2);
    this.applyOverlays(slot, s, mSpine, mHead, mLSh, mRSh, mLEl, mREl);
    this.applyItem(slot, s, held, mRHand);
    this.fillJoints(s);
    // store frames with the character scale removed so ragdoll bodies get rigid transforms
    const inv = 1 / sc;
    const fr = s.frames;
    const src = [mPelvis, mSpine, mHead, mLSh, mRSh, mLHip, mRHip];
    for (let i = 0; i < 7; i++) fr[i]!.copy(src[i]!).multiply(_m2.makeScale(inv, inv, inv));
  }

  /** World frames of the 7 ragdoll bodies from the last animated update. */
  framesOf(slot: number): THREE.Matrix4[] {
    return this.slots[slot]!.frames;
  }

  private applyOverlays(slot: number, s: Slot, spine: THREE.Matrix4, head: THREE.Matrix4, lsh: THREE.Matrix4, rsh: THREE.Matrix4, lel: THREE.Matrix4, rel: THREE.Matrix4): void {
    const app = s.app;
    const bw = app.build;
    if (app.top === 'jacket' || app.top === 'suit' || app.top === 'vest') {
      _m2.makeScale(bw * (app.top === 'vest' ? 1.06 : 1), 1, 0.92 + (bw - 1) * 0.6 + (app.top === 'vest' ? 0.12 : 0));
      this.set('jacket', slot, 0, _m.multiplyMatrices(spine, _m2));
    } else this.set('jacket', slot, 0, ZERO);
    const tat = app.tattoo;
    const sleeveCovers = app.top === 'long' || app.top === 'jacket' || app.top === 'suit';
    if (!sleeveCovers && (tat === 'sleeve' || tat === 'full')) {
      this.set('tatArm', slot, 0, lel);
      this.set('tatArm', slot, 1, rel);
    } else if (tat === 'tribal' && app.top === 'tank') {
      this.set('tatArm', slot, 0, lsh);
      this.set('tatArm', slot, 1, rsh);
    } else if (tat === 'tribal' && !sleeveCovers) {
      this.set('tatArm', slot, 0, ZERO);
      this.set('tatArm', slot, 1, rel);
    } else {
      this.set('tatArm', slot, 0, ZERO);
      this.set('tatArm', slot, 1, ZERO);
    }
    this.set('tatNeck', slot, 0, tat === 'neck' || tat === 'full' ? head : ZERO);
    const hatHidesHair = app.hat === 'helmet';
    for (const hs of ['short', 'long', 'mohawk', 'bun', 'afro', 'slick'] as const) {
      const show = app.hairStyle === hs && !hatHidesHair && !(app.hat !== 'none' && (hs === 'afro' || hs === 'mohawk' || hs === 'bun'));
      this.set(`hair_${hs}`, slot, 0, show ? head : ZERO);
    }
    for (const b of ['stubble', 'full', 'goatee'] as const) this.set(`beard_${b}`, slot, 0, app.beard === b ? head : ZERO);
    for (const h of ['cap', 'police', 'helmet', 'beanie'] as const) this.set(`hat_${h}`, slot, 0, app.hat === h ? head : ZERO);
  }

  private applyItem(slot: number, s: Slot, held: HeldItem, hand: THREE.Matrix4): void {
    const items = ['pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'bat', 'knife', 'grenade', 'molotov', 'phone', 'lockpick', 'baton'] as const;
    // grip: hand frame → item frame with barrel pointing along the hand's -Y (arm direction)
    joint(mItem, hand, 0, -0.06, 0.01, Math.PI / 2, 0, 0, 'XYZ');
    for (const it of items) this.set(`item_${it}`, slot, 0, held === it ? mItem : ZERO);
    // muzzle
    const len = held === 'sniper' ? 0.82 : held === 'rifle' || held === 'shotgun' ? 0.56 : held === 'smg' ? 0.36 : 0.16;
    s.joints[Joint.Muzzle]!.set(0, 0.04, len).applyMatrix4(mItem);
  }

  private fillJoints(s: Slot): void {
    s.joints[Joint.Pelvis]!.setFromMatrixPosition(mPelvis);
    s.joints[Joint.Chest]!.set(0, SK.torsoH * 0.7, 0).applyMatrix4(mSpine);
    s.joints[Joint.Head]!.set(0, SK.headY, 0).applyMatrix4(mHead);
    s.joints[Joint.RHand]!.setFromMatrixPosition(mRHand);
    s.joints[Joint.LHand]!.setFromMatrixPosition(mLHand);
    s.joints[Joint.RFoot]!.set(0, -SK.lowerLeg, 0).applyMatrix4(mRKnee);
    s.joints[Joint.LFoot]!.set(0, -SK.lowerLeg, 0).applyMatrix4(mLKnee);
  }

  /**
   * Ragdoll: 7 body matrices. Lower limbs follow their upper limb with a fixed bend
   * (cheap — ragdoll bodies only simulate pelvis/torso/head/upper limbs).
   */
  private updateRagdoll(slot: number, s: Slot, rd: THREE.Matrix4[], held: HeldItem): void {
    const [pel, tor, hd, lua, rua, lul, rul] = rd as [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4];
    const sc = s.app.height;
    const scl = (m: THREE.Matrix4): THREE.Matrix4 => _m.copy(m).multiply(_m2.makeScale(sc, sc, sc));
    this.set('pelvis', slot, 0, scl(pel));
    mSpine.copy(tor).multiply(_m2.makeScale(sc, sc, sc));
    _m2.makeScale(s.app.build, 1, 0.9 + (s.app.build - 1) * 0.6);
    this.set('torso', slot, 0, _m.multiplyMatrices(mSpine, _m2));
    mHead.copy(hd).multiply(_m2.makeScale(sc, sc, sc));
    this.set('head', slot, 0, mHead);
    mLSh.copy(lua).multiply(_m2.makeScale(sc, sc, sc));
    mRSh.copy(rua).multiply(_m2.makeScale(sc, sc, sc));
    this.set('upperArm', slot, 0, mLSh);
    this.set('upperArm', slot, 1, mRSh);
    joint(mLEl, mLSh, 0, -SK.upperArm, 0, -0.5, 0, 0, 'XYZ');
    joint(mREl, mRSh, 0, -SK.upperArm, 0, -0.5, 0, 0, 'XYZ');
    this.set('lowerArm', slot, 0, mLEl);
    this.set('lowerArm', slot, 1, mREl);
    joint(mLHand, mLEl, 0, -SK.lowerArm, 0, 0, 0, 0, 'XYZ');
    joint(mRHand, mREl, 0, -SK.lowerArm, 0, 0, 0, 0, 'XYZ');
    this.set('hand', slot, 0, mLHand);
    this.set('hand', slot, 1, mRHand);
    mLHip.copy(lul).multiply(_m2.makeScale(sc, sc, sc));
    mRHip.copy(rul).multiply(_m2.makeScale(sc, sc, sc));
    this.set('upperLeg', slot, 0, mLHip);
    this.set('upperLeg', slot, 1, mRHip);
    joint(mLKnee, mLHip, 0, -SK.upperLeg, 0, 0.3, 0, 0, 'XYZ');
    joint(mRKnee, mRHip, 0, -SK.upperLeg, 0, 0.4, 0, 0, 'XYZ');
    this.set('lowerLeg', slot, 0, mLKnee);
    this.set('lowerLeg', slot, 1, mRKnee);
    joint(_m2, mLKnee, 0, -SK.lowerLeg, 0, 0, 0, 0, 'XYZ');
    this.set('foot', slot, 0, _m2);
    joint(_m2, mRKnee, 0, -SK.lowerLeg, 0, 0, 0, 0, 'XYZ');
    this.set('foot', slot, 1, _m2);
    this.applyOverlays(slot, s, mSpine, mHead, mLSh, mRSh, mLEl, mREl);
    void held;
    this.applyItem(slot, s, 'none', mRHand);
    mPelvis.copy(pel);
    this.fillJoints(s);
  }

  commit(): void {
    // only draw up to the highest used slot (zero-scale instances still cost vertex work)
    let high = 0;
    for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i]!.used) {
      high = i + 1;
      break;
    }
    if (high !== this.highWater) {
      this.highWater = high;
      for (const p of this.parts.values()) p.mesh.count = high * p.perChar;
    }
    for (const m of this.dirty) m.instanceMatrix.needsUpdate = true;
    this.dirty.clear();
  }
  private highWater = -1;
}

function lighten(hair: number, skin: number): number {
  const a = new THREE.Color(hair), b = new THREE.Color(skin);
  return a.lerp(b, 0.45).getHex();
}
