import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PartKind, type RigBody, type RigData, type RigPart } from './RigData';
import { Cat, HAT_IDS, ITEM_IDS, Paint, variant } from './regions';

/**
 * Renderable geometry for one dressed part (Quaternius Ultimate Modular Men / Women, rebound to the
 * animation skeleton by scripts/build-characters.mjs), plus the procedural extras that belong to it:
 * hats fitted to each head (on a "head shell" wrapped around that head's own vertices) and the held
 * items in each body's right hand. Instances pick extras in the vertex shader.
 */

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  col: number[] = [];
  vari: number[] = [];
  idx: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
  /** Append a three geometry rigidly bound to `bone`; `shade` (0..1) goes in the colour channel. */
  addRigid(g: THREE.BufferGeometry, bone: number, paint: Paint, vari: number, shade: (i: number) => number = () => 1): void {
    if (!g.attributes.normal) g.computeVertexNormals();
    const base = this.count;
    const P = g.attributes.position!, N = g.attributes.normal!;
    for (let i = 0; i < P.count; i++) {
      this.pos.push(P.getX(i), P.getY(i), P.getZ(i));
      this.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      this.si.push(bone, 0, 0, 0);
      this.sw.push(255, 0, 0, 0);
      const v = Math.round(Math.max(0, Math.min(1, shade(i))) * 255);
      this.col.push(v, v, v, paint);
      this.vari.push(vari);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
  }
}

/** Radial shell fitted around the head: r(θ, φ) from the head centre. θ from +Y, φ from +Z toward +X. */
class HeadShell {
  readonly nT = 36;
  readonly nP = 48;
  readonly r: Float32Array;
  constructor(readonly c: THREE.Vector3, pts: THREE.Vector3[], fallback: THREE.Vector3) {
    const { nT, nP } = this;
    this.r = new Float32Array((nT + 1) * nP);
    const d = new THREE.Vector3(), v = new THREE.Vector3();
    const cosCone = Math.cos(0.2);
    for (let i = 0; i <= nT; i++) {
      for (let j = 0; j < nP; j++) {
        this.dir((i / nT) * Math.PI, (j / nP) * Math.PI * 2, d);
        let best = 0;
        for (const p of pts) {
          v.subVectors(p, c);
          const l = v.length();
          if (l < 1e-4) continue;
          const cs = v.dot(d) / l;
          if (cs > cosCone) best = Math.max(best, l * Math.min(1, cs + 0.02));
        }
        if (best === 0) {
          // ellipsoid fallback (below the jaw)
          best = 1 / Math.sqrt((d.x / fallback.x) ** 2 + (d.y / fallback.y) ** 2 + (d.z / fallback.z) ** 2);
        }
        this.r[i * nP + j] = best + 0.003;
      }
    }
    // smooth (keeps the max-envelope roughly, removes vertex-density noise)
    for (let pass = 0; pass < 2; pass++) {
      const r2 = new Float32Array(this.r);
      for (let i = 1; i < nT; i++) {
        for (let j = 0; j < nP; j++) {
          const a = this.r[i * nP + j]!;
          const n = (this.r[(i - 1) * nP + j]! + this.r[(i + 1) * nP + j]! + this.r[i * nP + ((j + 1) % nP)]! + this.r[i * nP + ((j + nP - 1) % nP)]!) / 4;
          r2[i * nP + j] = Math.max(a, a * 0.5 + n * 0.5);
        }
      }
      this.r.set(r2);
    }
  }
  dir(theta: number, phi: number, out: THREE.Vector3): THREE.Vector3 {
    const s = Math.sin(theta);
    return out.set(s * Math.sin(phi), Math.cos(theta), s * Math.cos(phi));
  }
  radius(theta: number, phi: number): number {
    const { nT, nP } = this;
    const ti = Math.max(0, Math.min(nT - 1e-4, (theta / Math.PI) * nT));
    let pj = (phi / (Math.PI * 2)) * nP;
    pj = ((pj % nP) + nP) % nP;
    const i0 = Math.floor(ti), j0 = Math.floor(pj), a = ti - i0, b = pj - j0;
    const j1 = (j0 + 1) % nP;
    const r = this.r;
    return (r[i0 * nP + j0]! * (1 - b) + r[i0 * nP + j1]! * b) * (1 - a) + (r[(i0 + 1) * nP + j0]! * (1 - b) + r[(i0 + 1) * nP + j1]! * b) * a;
  }
  point(theta: number, phi: number, off: number, out: THREE.Vector3): THREE.Vector3 {
    this.dir(theta, phi, out);
    return out.multiplyScalar(this.radius(theta, phi) + off).add(this.c);
  }
  /**
   * Cap from the crown down to a per-meridian cut θmax(φ), offset `thick(u, φ)` (u = 0 crown → 1 edge).
   * Meridians are parametrized to their own cut so edges are exactly smooth.
   */
  cap(thetaMax: (phi: number) => number, thick: (u: number, phi: number) => number, rows = 14, phiFrom = 0, phiTo = Math.PI * 2, cols = 40): THREE.BufferGeometry {
    return this.band(() => 0, thetaMax, thick, rows, phiFrom, phiTo, cols);
  }
  /** Band between θmin(φ) and θmax(φ) (u = 0 at θmin → 1 at θmax). */
  band(thetaMin: (phi: number) => number, thetaMax: (phi: number) => number, thick: (u: number, phi: number) => number, rows = 14, phiFrom = 0, phiTo = Math.PI * 2, cols = 40): THREE.BufferGeometry {
    const pos: number[] = [];
    const idx: number[] = [];
    const full = Math.abs(phiTo - phiFrom - Math.PI * 2) < 1e-6;
    const nc = full ? cols : cols + 1;
    const v = new THREE.Vector3();
    for (let i = 0; i <= rows; i++) {
      for (let j = 0; j < nc; j++) {
        const phi = phiFrom + ((phiTo - phiFrom) * j) / cols;
        const u = i / rows;
        const t0 = thetaMin(phi);
        const th = t0 + (thetaMax(phi) - t0) * u;
        this.point(th, phi, thick(u, phi), v);
        pos.push(v.x, v.y, v.z);
      }
    }
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const a = i * nc + j, b = i * nc + ((j + 1) % nc), c = (i + 1) * nc + j, d = (i + 1) * nc + ((j + 1) % nc);
        if (!full && j + 1 >= nc) continue;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Hairline helper: θmax from front (φ=0), side (φ=±π/2) and back (φ=π) values. */
const line = (front: number, side: number, back: number) => (phi: number): number => {
  const c = Math.cos(phi); // 1 front, 0 side, −1 back
  return c >= 0 ? side + (front - side) * c * c * (3 - 2 * c) : side + (back - side) * -c * -c * (3 + 2 * c);
};

export interface PartGeometry {
  part: RigPart;
  geometry: THREE.BufferGeometry;
}

/** Built-in headwear (the procedural hats are skipped on these heads). */
const HAS_HAT = /^(Swat|Worker|Farmer)_Head$/;

export function buildPartGeometry(rig: RigData, part: RigPart): PartGeometry {
  const B = new Builder();
  const body = rig.bodies[part.body]!;
  const q = 1 / part.quant;
  for (let i = 0; i < part.vertexCount; i++) {
    B.pos.push(part.position[i * 4]! * q, part.position[i * 4 + 1]! * q, part.position[i * 4 + 2]! * q);
    B.nrm.push(part.normal[i * 4]! / 127, part.normal[i * 4 + 1]! / 127, part.normal[i * 4 + 2]! / 127);
    for (let k = 0; k < 4; k++) {
      B.si.push(part.skinIndex[i * 4 + k]!);
      B.sw.push(part.skinWeight[i * 4 + k]!);
      B.col.push(part.color[i * 4 + k]!);
    }
    B.vari.push(0);
  }
  for (const i of part.index) B.idx.push(i);
  if (part.kind === PartKind.Head && !HAS_HAT.test(part.name)) addHats(B, rig, body, part);
  if (part.kind === PartKind.Body) addItems(B, rig, body);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
  g.setAttribute('aBones', new THREE.Uint8BufferAttribute(B.si, 4));
  g.setAttribute('aWeights', new THREE.Uint8BufferAttribute(B.sw, 4, true));
  g.setAttribute('aColor', new THREE.Uint8BufferAttribute(B.col, 4));
  g.setAttribute('aVar', new THREE.Uint8BufferAttribute(B.vari, 1));
  g.setIndex(B.count > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
  return { part, geometry: g };
}

/** Bind-space head bone position of a body (beard painting). */
export function headOf(rig: RigData, body: RigBody): THREE.Vector4 {
  const i = rig.bone('Head') * 3;
  return new THREE.Vector4(body.bindP[i]!, body.bindP[i + 1]!, body.bindP[i + 2]!, 0);
}

/** Bind-space landmarks of a body (tattoo placement): shoulder x, wrist x, top of the neck y. */
export function limbsOf(rig: RigData, body: RigBody): THREE.Vector4 {
  const x = (n: string): number => body.bindP[rig.bone(n) * 3]!;
  return new THREE.Vector4(x('upperarm_l'), x('hand_l'), body.bindP[rig.bone('neck_01') * 3 + 1]! + 0.06, 0);
}

function addHats(B: Builder, rig: RigData, body: RigBody, part: RigPart): void {
  const HEAD = rig.bone('Head');
  const neckY = body.bindP[rig.bone('neck_01') * 3 + 1]!;
  const pts: THREE.Vector3[] = [];
  const box = new THREE.Box3();
  const q = 1 / part.quant;
  for (let i = 0; i < part.vertexCount; i++) {
    const v = new THREE.Vector3(part.position[i * 4]! * q, part.position[i * 4 + 1]! * q, part.position[i * 4 + 2]! * q);
    if (v.y < neckY + 0.06) continue;
    pts.push(v);
    box.expandByPoint(v);
  }
  if (!pts.length) return;
  const c = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const shell = new HeadShell(c, pts, half);
  const R = Math.max(half.x, half.z);
  // baseball cap: dome + bill
  const domeLine = line(1.12, 1.45, 1.75);
  B.addRigid(shell.cap(domeLine, () => 0.012, 12), HEAD, Paint.ProcHat, variant(Cat.Hat, HAT_IDS.cap));
  B.addRigid(buildBill(shell, 1.12, R * 0.95, 0.012), HEAD, Paint.ProcHatTrim, variant(Cat.Hat, HAT_IDS.cap), () => 0.85);
  // police cap: flat-topped crown + black visor
  B.addRigid(shell.cap(line(1.15, 1.42, 1.62), (u) => 0.014 + 0.028 * smooth(0.0, 0.55, 1 - u), 12), HEAD, Paint.ProcHat, variant(Cat.Hat, HAT_IDS.police));
  B.addRigid(buildBill(shell, 1.15, R * 0.75, 0.01), HEAD, Paint.ProcHatTrim, variant(Cat.Hat, HAT_IDS.police), () => 0.18);
  // helmet: thick shell down over the ears, dark visor strip
  B.addRigid(shell.cap(line(1.12, 1.78, 1.95), () => 0.028, 14), HEAD, Paint.ProcHat, variant(Cat.Hat, HAT_IDS.helmet));
  B.addRigid(shell.cap(() => 1.32, () => 0.038, 3, -0.9, 0.9, 12), HEAD, Paint.ProcHatTrim, variant(Cat.Hat, HAT_IDS.helmet), () => 0.25);
  // beanie: soft dome with a folded band
  B.addRigid(shell.cap(line(1.12, 1.55, 1.85), (u) => 0.014 + 0.025 * (1 - u) ** 2, 14), HEAD, Paint.ProcHat, variant(Cat.Hat, HAT_IDS.beanie));
  const bl = line(1.12, 1.55, 1.85);
  B.addRigid(shell.band((phi) => bl(phi) - 0.24, bl, () => 0.022, 3), HEAD, Paint.ProcHatTrim, variant(Cat.Hat, HAT_IDS.beanie), () => 0.82);
}

/** Cap visor / bill: a flat, slightly drooping half-disc at the front hairline. */
function buildBill(shell: HeadShell, theta: number, length: number, thick: number): THREE.BufferGeometry {
  const v = new THREE.Vector3();
  const pos: number[] = [];
  const idx: number[] = [];
  const cols = 14;
  for (let j = 0; j <= cols; j++) {
    const phi = -1.15 + (2.3 * j) / cols;
    shell.point(theta, phi, 0.018, v);
    const out = Math.cos(phi * 1.1) * length;
    pos.push(v.x, v.y, v.z, v.x + Math.sin(phi) * out * 0.6, v.y - out * 0.18, v.z + out);
  }
  for (let j = 0; j < cols; j++) {
    const a = j * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  top.setIndex(idx);
  top.computeVertexNormals();
  const bottom = top.clone();
  bottom.translate(0, -thick, 0);
  const bi = bottom.index!;
  for (let t = 0; t < bi.count; t += 3) {
    const a = bi.getX(t + 1);
    bi.setX(t + 1, bi.getX(t + 2));
    bi.setX(t + 2, a);
  }
  bottom.computeVertexNormals();
  return mergeGeometries([top, bottom], false)!;
}

/** Items modelled with barrel along +Z, grip at the origin (same shapes as the old box renderer). */
function addItems(B: Builder, rig: RigData, body: RigBody): void {
  const HR = rig.bone('hand_r');
  // hand_r bind frame (model space)
  const q = new THREE.Quaternion(body.bindQ[HR * 4]!, body.bindQ[HR * 4 + 1]!, body.bindQ[HR * 4 + 2]!, body.bindQ[HR * 4 + 3]!);
  const p = new THREE.Vector3(body.bindP[HR * 3]!, body.bindP[HR * 3 + 1]!, body.bindP[HR * 3 + 2]!);
  const handM = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
  // grip in hand-bone space: barrel (item +Z) along the fingers (+Y), item up (+Y) toward the thumb (+Z)
  const grip = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  grip.setPosition(-0.028, 0.075, 0.0);
  const M = new THREE.Matrix4().multiplyMatrices(handM, grip);
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, shade = 1): [THREE.BufferGeometry, number] => {
    const b = new THREE.BoxGeometry(w, h, d);
    b.translate(x, y, z);
    return [b.toNonIndexed(), shade];
  };
  const items: Record<Exclude<keyof typeof ITEM_IDS, 'none'>, [THREE.BufferGeometry, number][]> = {
    pistol: [box(0.035, 0.05, 0.19, 0, 0.04, 0.06, 0.35), box(0.03, 0.11, 0.045, 0, -0.01, 0, 0.25)],
    smg: [box(0.045, 0.07, 0.34, 0, 0.04, 0.1, 0.3), box(0.03, 0.12, 0.04, 0, -0.03, 0, 0.2), box(0.03, 0.15, 0.04, 0, -0.04, 0.12, 0.15), box(0.02, 0.02, 0.1, 0, 0.05, 0.31, 0.25)],
    shotgun: [box(0.05, 0.07, 0.7, 0, 0.04, 0.22, 0.35), box(0.04, 0.12, 0.18, 0, -0.02, -0.12, 0.45), box(0.05, 0.05, 0.22, 0, 0.0, 0.3, 0.5)],
    rifle: [box(0.045, 0.08, 0.72, 0, 0.04, 0.2, 0.28), box(0.04, 0.12, 0.2, 0, 0.0, -0.13, 0.22), box(0.035, 0.16, 0.05, 0, -0.06, 0.12, 0.18), box(0.03, 0.04, 0.12, 0, 0.1, 0.14, 0.2)],
    sniper: [box(0.04, 0.07, 1.0, 0, 0.04, 0.32, 0.3), box(0.04, 0.12, 0.24, 0, 0.0, -0.15, 0.4), box(0.04, 0.05, 0.24, 0, 0.11, 0.12, 0.15)],
    bat: [box(0.04, 0.04, 0.3, 0, 0, 0.1, 0.55), box(0.065, 0.065, 0.55, 0, 0, 0.5, 0.8)],
    knife: [box(0.025, 0.03, 0.1, 0, 0, 0.02, 0.2), box(0.008, 0.035, 0.16, 0, 0.005, 0.15, 1.0)],
    grenade: [[new THREE.SphereGeometry(0.045, 8, 6).toNonIndexed(), 0.45]],
    molotov: [box(0.07, 0.07, 0.16, 0, 0, 0.05, 0.6), box(0.03, 0.03, 0.08, 0, 0, 0.16, 0.95)],
    phone: [box(0.06, 0.12, 0.012, 0, -0.02, 0.03, 0.15)],
    lockpick: [box(0.008, 0.008, 0.12, 0, 0, 0.05, 0.95)],
    baton: [box(0.035, 0.035, 0.5, 0, 0, 0.18, 0.15)],
  };
  for (const [name, parts] of Object.entries(items) as [keyof typeof items, [THREE.BufferGeometry, number][]][]) {
    for (const [g, shade] of parts) {
      g.applyMatrix4(M);
      g.computeVertexNormals();
      B.addRigid(g, HR, Paint.Item, variant(Cat.Item, ITEM_IDS[name]), () => shade);
    }
  }
}

