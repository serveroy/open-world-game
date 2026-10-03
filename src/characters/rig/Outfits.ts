import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RigBody, RigData } from './RigData';
import { Cat, HAIR_IDS, HAT_IDS, ITEM_IDS, OUTER_IDS, BEARD_IDS, Region, variant } from './regions';

/**
 * Builds the renderable geometry for one body: the scanned body mesh plus every accessory variant
 * (hairstyles, beards, hats, jackets/vests, held items) skinned to the same skeleton. Instances pick
 * variants in the vertex shader, so all characters of a body type draw in one call.
 *
 * Hair/hats/beards are generated on a "head shell" fitted to the body's own head vertices, so they sit
 * snugly on the scalp with clean, smooth hairlines. Jackets are offset shells of the torso/arms.
 */

export interface BodyGeometry {
  geometry: THREE.BufferGeometry;
  /** Bind-space landmarks used by the paint shader. */
  head: THREE.Vector4; // center xyz, radius-ish
  face: THREE.Vector4; // eyeY, browY, mouthY, eyeX
  eye: THREE.Vector4; // eyeball centre (|x|, y, z) + radius
  limbs: THREE.Vector4; // shoulderX, wristX, hipY, ankleY
  torso: THREE.Vector4; // waistY, chestFrontZ, neckBaseY, beltY
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  si: number[] = [];
  sw: number[] = [];
  reg: number[] = [];
  vari: number[] = [];
  shade: number[] = [];
  idx: number[] = [];
  get count(): number {
    return this.pos.length / 3;
  }
  /** Append a (non-indexed or indexed) three geometry, rigidly bound to `bone`. */
  addRigid(g: THREE.BufferGeometry, bone: number, region: Region, vari: number, shade: (i: number) => number = () => 1): void {
    if (!g.attributes.normal) g.computeVertexNormals();
    const base = this.count;
    const P = g.attributes.position!, N = g.attributes.normal!;
    for (let i = 0; i < P.count; i++) {
      this.pos.push(P.getX(i), P.getY(i), P.getZ(i));
      this.nrm.push(N.getX(i), N.getY(i), N.getZ(i));
      this.si.push(bone, 0, 0, 0);
      this.sw.push(255, 0, 0, 0);
      this.reg.push(region);
      this.vari.push(vari);
      this.shade.push(Math.round(Math.max(0, Math.min(1, shade(i))) * 255));
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

export function buildBodyGeometry(rig: RigData, body: RigBody): BodyGeometry {
  const B = new Builder();
  const nb = rig.boneNames.length;
  void nb;
  // ---- body ----
  const P = body.position;
  for (let i = 0; i < body.vertexCount; i++) {
    B.pos.push(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!);
    B.nrm.push(body.normal[i * 4]! / 127, body.normal[i * 4 + 1]! / 127, body.normal[i * 4 + 2]! / 127);
    for (let k = 0; k < 4; k++) {
      B.si.push(body.skinIndex[i * 4 + k]!);
      B.sw.push(body.skinWeight[i * 4 + k]!);
    }
    B.reg.push(body.region[i]!);
    B.vari.push(0);
    B.shade.push(255);
  }
  for (const i of body.index) B.idx.push(i);

  const bone = (n: string): number => rig.bone(n);
  const bp = (n: string): THREE.Vector3 => {
    const i = bone(n);
    return new THREE.Vector3(body.bindP[i * 3]!, body.bindP[i * 3 + 1]!, body.bindP[i * 3 + 2]!);
  };
  const HEAD = bone('Head');

  // ---- head: the scanned mannequin head is a featureless egg, so it is replaced by a sculpted head
  // (jaw, cheekbones, brow, nose, lips, ears, real eyeballs) sized to the original ----
  const box = new THREE.Box3();
  for (let i = 0; i < body.vertexCount; i++) if (body.region[i] === Region.Head) box.expandByPoint(new THREE.Vector3(P[i * 3]!, P[i * 3 + 1]!, P[i * 3 + 2]!));
  const female = body.name === 'female';
  const c = box.getCenter(new THREE.Vector3());
  c.y -= 0.004;
  c.z -= 0.006;
  // drop the original head triangles
  B.idx = B.idx.filter((_, k, arr) => {
    const t = k - (k % 3);
    return !(B.reg[arr[t]!] === Region.Head || B.reg[arr[t + 1]!] === Region.Head || B.reg[arr[t + 2]!] === Region.Head);
  });
  const head = sculptHead(female);
  head.geo.translate(c.x, c.y, c.z);
  B.addRigid(head.geo, HEAD, Region.Head, 0);
  for (const ear of head.ears) {
    ear.translate(c.x, c.y, c.z);
    B.addRigid(ear, HEAD, Region.Head, 0, () => 0.96);
  }
  for (const eye of head.eyes) {
    eye.translate(c.x, c.y, c.z);
    B.addRigid(eye, HEAD, Region.Eye, 0);
  }
  // neck bridge into the skull (neck bone at the bottom → head bone at the top)
  {
    const NK = bone('neck_01');
    const top = c.y - 0.02, bot = bp('neck_01').y - 0.02;
    const cyl = new THREE.CylinderGeometry(female ? 0.042 : 0.05, female ? 0.047 : 0.056, top - bot, 16, 4, true);
    cyl.translate(c.x, (top + bot) / 2, c.z - 0.018);
    const base = B.count;
    B.addRigid(cyl, HEAD, Region.Neck, 0);
    const n = cyl.attributes.position!.count;
    for (let i = 0; i < n; i++) {
      const y = B.pos[(base + i) * 3 + 1]!;
      const wHead = smooth(bot + 0.02, top, y);
      const a = Math.round(wHead * 255);
      const o = (base + i) * 4;
      B.si[o] = HEAD; B.si[o + 1] = NK;
      B.sw[o] = a; B.sw[o + 1] = 255 - a;
    }
  }
  const headPts: THREE.Vector3[] = [];
  const hp = head.points;
  for (let i = 0; i < hp.length; i += 3) headPts.push(new THREE.Vector3(hp[i]! + c.x, hp[i + 1]! + c.y, hp[i + 2]! + c.z));
  const half = new THREE.Vector3(head.rx, head.ry, head.rz);
  const shell = new HeadShell(c, headPts, half);
  const R = Math.max(half.x, half.z);
  const eyeAt = head.eyeCenter.clone().add(c);

  // ---- hair ----
  const hairline = line(0.98, 1.55, 2.1);
  // close crop: thin on the sides and back, a little volume on top and at the front
  const shortThick = (u: number, phi: number): number => 0.0025 + 0.003 * (1 - smooth(0.55, 1, u)) + (0.007 + 0.003 * Math.max(0, Math.cos(phi))) * (1 - smooth(0.0, 0.6, u));
  B.addRigid(shell.cap(hairline, shortThick), HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.short));
  B.addRigid(shell.cap(line(1.02, 1.45, 2.05), (u) => 0.003 + 0.006 * (1 - smooth(0.8, 1, u))), HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.slick), () => 0.9);
  // long: fuller cap covering the ears + a curtain down the back to the shoulder blades
  {
    const cap = shell.cap(line(0.95, 1.75, 2.3), (u) => 0.006 + 0.016 * (1 - smooth(0.8, 1, u)));
    const curtain = buildCurtain(shell, c, bp('neck_01').y - 0.16);
    B.addRigid(cap, HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.long));
    const base = B.count;
    B.addRigid(curtain.g, HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.long), (i) => 0.92 + 0.08 * curtain.u[i]!);
    // lower curtain follows the upper back so head turns bend the hair
    const S3 = bone('spine_03'), NK = bone('neck_01');
    for (let i = 0; i < curtain.u.length; i++) {
      const u = curtain.u[i]!; // 0 top → 1 bottom
      const wHead = 1 - smooth(0.25, 0.75, u), wNeck = (1 - wHead) * (1 - smooth(0.6, 1, u)), wSpine = 1 - wHead - wNeck;
      const q = [wHead, wNeck, wSpine].map((w) => Math.round(w * 255));
      q[0]! += 255 - q[0]! - q[1]! - q[2]!;
      const o = (base + i) * 4;
      B.si[o] = HEAD; B.si[o + 1] = NK; B.si[o + 2] = S3; B.si[o + 3] = 0;
      B.sw[o] = q[0]!; B.sw[o + 1] = q[1]!; B.sw[o + 2] = q[2]!; B.sw[o + 3] = 0;
    }
  }
  // bun: neat cap + knot at the back of the crown
  {
    B.addRigid(shell.cap(line(1.0, 1.55, 2.15), (u) => 0.003 + 0.007 * (1 - smooth(0.8, 1, u))), HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.bun));
    const knot = new THREE.SphereGeometry(R * 0.5, 14, 10);
    const at = shell.point(0.95, Math.PI, R * 0.32, new THREE.Vector3());
    knot.scale(1, 0.9, 0.85).translate(at.x, at.y, at.z);
    B.addRigid(knot, HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.bun), () => 0.9);
  }
  // afro: big rounded volume
  B.addRigid(shell.cap(line(1.0, 1.62, 2.1), (u, phi) => (0.045 + 0.01 * Math.cos(phi)) * (1 - smooth(0.7, 1, u)) + 0.008, 16), HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.afro));
  // mohawk: shaved sides (painted) + a tall ridge along the midline
  B.addRigid(buildRidge(shell), HEAD, Region.Hair, variant(Cat.Hair, HAIR_IDS.mohawk));

  // ---- beards (front lower face; θ measured from the crown, π/2 ≈ eye level) ----
  {
    const bulge = (u: number): number => 0.003 + 0.011 * Math.sin(Math.PI * u);
    const full = variant(Cat.Beard, BEARD_IDS.full), goatee = variant(Cat.Beard, BEARD_IDS.goatee);
    // cheeks + jaw + chin
    B.addRigid(shell.band((phi) => 1.62 + 0.36 * Math.cos(phi) ** 2, (phi) => 2.42 + 0.38 * Math.cos(phi), (u) => bulge(u) + 0.004 * u, 10, -1.45, 1.45, 28), HEAD, Region.Beard, full);
    // moustache
    B.addRigid(shell.band(() => 1.9, () => 2.0, (u) => 0.0015 + 0.0035 * Math.sin(Math.PI * u), 4, -0.5, 0.5, 10), HEAD, Region.Beard, full);
    B.addRigid(shell.band(() => 1.9, () => 2.0, (u) => 0.0015 + 0.0035 * Math.sin(Math.PI * u), 4, -0.45, 0.45, 10), HEAD, Region.Beard, goatee);
    B.addRigid(shell.band(() => 2.14, () => 2.78, (u) => 0.003 + 0.012 * Math.sin(Math.PI * u), 8, -0.42, 0.42, 10), HEAD, Region.Beard, goatee);
  }

  // ---- hats ----
  {
    // baseball cap: dome + bill
    const domeLine = line(1.12, 1.45, 1.75);
    B.addRigid(shell.cap(domeLine, () => 0.02, 12), HEAD, Region.Hat, variant(Cat.Hat, HAT_IDS.cap));
    B.addRigid(buildBill(shell, 1.12, R * 0.95, 0.012), HEAD, Region.HatTrim, variant(Cat.Hat, HAT_IDS.cap), () => 0.85);
    // police cap: taller flat-topped crown + black visor + band
    B.addRigid(shell.cap(line(1.15, 1.42, 1.62), (u) => 0.022 + 0.03 * smooth(0.0, 0.55, 1 - u), 12), HEAD, Region.Hat, variant(Cat.Hat, HAT_IDS.police));
    B.addRigid(buildBill(shell, 1.15, R * 0.75, 0.01), HEAD, Region.HatTrim, variant(Cat.Hat, HAT_IDS.police), () => 0.18);
    // helmet: thick shell down over the ears, dark visor strip
    B.addRigid(shell.cap(line(1.12, 1.78, 1.95), () => 0.035, 14), HEAD, Region.Hat, variant(Cat.Hat, HAT_IDS.helmet));
    B.addRigid(shell.cap(() => 1.32, () => 0.045, 3, -0.9, 0.9, 12), HEAD, Region.HatTrim, variant(Cat.Hat, HAT_IDS.helmet), () => 0.25);
    // beanie: soft dome with a folded band
    B.addRigid(shell.cap(line(1.12, 1.55, 1.85), (u) => 0.02 + 0.03 * (1 - u) ** 2, 14), HEAD, Region.Hat, variant(Cat.Hat, HAT_IDS.beanie), () => 1);
    const bl = line(1.12, 1.55, 1.85);
    B.addRigid(shell.band((phi) => bl(phi) - 0.24, bl, () => 0.03, 3), HEAD, Region.HatTrim, variant(Cat.Hat, HAT_IDS.beanie), () => 0.82);
  }

  // ---- held items (right hand) ----
  addItems(B, rig, body);

  // ---- outerwear shells ----
  addOuter(B, body);

  // ---- geometry ----
  const n = B.count;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
  g.setAttribute('aBones', new THREE.Uint8BufferAttribute(B.si, 4));
  g.setAttribute('aWeights', new THREE.Uint8BufferAttribute(B.sw, 4, true));
  g.setAttribute('aRegion', new THREE.Uint8BufferAttribute(B.reg, 1));
  g.setAttribute('aVar', new THREE.Uint8BufferAttribute(B.vari, 1));
  g.setAttribute('aShade', new THREE.Uint8BufferAttribute(B.shade, 1, true));
  g.setIndex(n > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));

  const sh = bp('upperarm_l'), wr = bp('hand_l'), hip = bp('thigh_l'), ank = bp('foot_l');
  const chestFront = maxZ(body, Region.Chest);
  return {
    geometry: g,
    head: new THREE.Vector4(c.x, c.y, c.z, R),
    face: new THREE.Vector4(eyeAt.y, c.y + head.browY, c.y + head.mouthY, eyeAt.x),
    eye: new THREE.Vector4(eyeAt.x, eyeAt.y, eyeAt.z, head.eyeR),
    limbs: new THREE.Vector4(sh.x, wr.x, hip.y + 0.03, ank.y + 0.035),
    torso: new THREE.Vector4(bp('pelvis').y + 0.1, chestFront, bp('neck_01').y - 0.02, bp('pelvis').y + 0.085),
  };
}

/** Stylised sculpted head in head-local space (+Z front, origin at the skull centre). */
function sculptHead(female: boolean): { geo: THREE.BufferGeometry; ears: THREE.BufferGeometry[]; eyes: THREE.BufferGeometry[]; points: Float32Array; rx: number; ry: number; rz: number; eyeCenter: THREE.Vector3; eyeR: number; browY: number; mouthY: number } {
  const rx = female ? 0.08 : 0.086, ry = female ? 0.112 : 0.12, rz = female ? 0.099 : 0.105;
  const g = new THREE.SphereGeometry(1, 44, 34);
  const P = g.attributes.position!;
  const gauss = (x: number, y: number, x0: number, y0: number, sx: number, sy: number): number => Math.exp(-(((x - x0) / sx) ** 2) - ((y - y0) / sy) ** 2);
  const eyeX = female ? 0.032 : 0.034, eyeY = 0.01;
  for (let i = 0; i < P.count; i++) {
    const dx = P.getX(i), dy = P.getY(i), dz = P.getZ(i);
    let x = dx * rx, y = dy * ry, z = dz * (dz < 0 ? rz * 1.07 : rz);
    // jaw narrows toward the chin, more at the front; flat underside
    const low = smooth(0.05, -0.9, dy);
    const front = Math.max(0, dz);
    x *= 1 - (female ? 0.4 : 0.32) * low * (0.55 + 0.45 * front);
    if (dy < -0.55) y += (-ry * 0.84 - y) * smooth(-0.55, -1, dy) * 0.55 * (0.4 + 0.6 * front);
    // back of the jaw tucks in under the skull
    if (dz < 0 && dy < -0.2) z *= 1 - 0.3 * smooth(-0.2, -0.9, dy);
    const f2 = front * front, f4 = f2 * f2;
    // facial relief
    z += (female ? 0.012 : 0.015) * gauss(x, y, 0, -0.02, 0.0105, 0.021) * f4; // nose bridge + body
    z += 0.005 * gauss(x, y, 0, -0.036, 0.013, 0.009) * f4; // nose tip / nostrils
    z += 0.0065 * (gauss(x, y, eyeX, 0.034, 0.024, 0.009) + gauss(x, y, -eyeX, 0.034, 0.024, 0.009)) * f2; // brow ridge
    z -= 0.0085 * (gauss(x, y, eyeX, eyeY, 0.015, 0.011) + gauss(x, y, -eyeX, eyeY, 0.015, 0.011)) * f2; // eye sockets
    x += Math.sign(x) * 0.0045 * gauss(Math.abs(x), y, 0.052, -0.012, 0.02, 0.02) * front; // cheekbones
    z += (female ? 0.004 : 0.007) * gauss(x, y, 0, -0.104, 0.022, 0.016) * f2; // chin
    z += (female ? 0.0042 : 0.0032) * (gauss(x, y, 0, -0.058, 0.017, 0.0045) + gauss(x, y, 0, -0.07, 0.015, 0.005)) * f4; // lips
    z -= 0.002 * gauss(x, y, 0, -0.064, 0.02, 0.002) * f4; // mouth line
    P.setXYZ(i, x, y, z);
  }
  g.computeVertexNormals();
  // eyeballs: find the socket surface depth
  let zs = 0;
  for (let i = 0; i < P.count; i++) if (Math.abs(P.getX(i) - eyeX) < 0.006 && Math.abs(P.getY(i) - eyeY) < 0.006 && P.getZ(i) > zs) zs = P.getZ(i);
  const eyeR = female ? 0.0112 : 0.0115;
  const eyeCenter = new THREE.Vector3(eyeX, eyeY, zs - eyeR * 0.62);
  const eyes = [1, -1].map((sx) => {
    const e = new THREE.SphereGeometry(eyeR, 14, 10);
    e.translate(sx * eyeX, eyeY, eyeCenter.z);
    return e;
  });
  const ears = [1, -1].map((sx) => {
    const e = new THREE.SphereGeometry(1, 12, 9);
    e.scale(0.012, female ? 0.026 : 0.029, 0.019);
    e.rotateY(sx * 0.35);
    e.translate(sx * rx * 0.93, -0.008, -0.01);
    e.computeVertexNormals();
    return e;
  });
  return { geo: g, ears, eyes, points: new Float32Array(P.array as Float32Array), rx, ry, rz, eyeCenter, eyeR, browY: 0.034, mouthY: -0.064 };
}

function maxZ(body: RigBody, region: Region): number {
  let z = -1;
  for (let i = 0; i < body.vertexCount; i++) if (body.region[i] === region) z = Math.max(z, body.position[i * 3 + 2]!);
  return z;
}

/** Long-hair curtain: back half-tube from the nape region to below the neck. */
function buildCurtain(shell: HeadShell, c: THREE.Vector3, bottomY: number): { g: THREE.BufferGeometry; u: number[] } {
  const rows = 10, cols = 22;
  const pos: number[] = [];
  const us: number[] = [];
  const idx: number[] = [];
  const v = new THREE.Vector3();
  const phi0 = Math.PI * 0.42, phi1 = Math.PI * 1.58;
  for (let i = 0; i <= rows; i++) {
    const u = i / rows;
    for (let j = 0; j <= cols; j++) {
      const phi = phi0 + ((phi1 - phi0) * j) / cols;
      // start on the shell around ear level, then fall straight down and flare slightly
      shell.point(1.55, phi, 0.016, v);
      const y = c.y + (v.y - c.y) * (1 - u) + (bottomY - c.y) * u;
      const flare = 1 + 0.18 * u;
      const sx = c.x + (v.x - c.x) * flare, sz = c.z + (v.z - c.z) * flare - 0.02 * u;
      pos.push(sx, y, sz);
      us.push(u);
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j, b = a + 1, cc = a + cols + 1, d = cc + 1;
      idx.push(a, b, cc, b, d, cc);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  // double-sided by duplicating with flipped winding (inside visible when the head turns)
  const back = g.clone();
  const bi = back.index!;
  for (let t = 0; t < bi.count; t += 3) {
    const a = bi.getX(t + 1);
    bi.setX(t + 1, bi.getX(t + 2));
    bi.setX(t + 2, a);
  }
  const bn = back.attributes.normal!;
  for (let i = 0; i < bn.count; i++) bn.setXYZ(i, -bn.getX(i), -bn.getY(i), -bn.getZ(i));
  const m = mergeGeometries([g, back], false)!;
  return { g: m, u: [...us, ...us] };
}

/** Mohawk ridge along the sagittal midline. */
function buildRidge(shell: HeadShell): THREE.BufferGeometry {
  const pos: number[] = [];
  const idx: number[] = [];
  const steps = 18;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    // from forehead (front, θ≈1.0) over the crown to the nape (back, θ≈2.0)
    const t = i / steps;
    const ang = -1.0 + t * 3.0; // signed polar angle: <0 front, >0 back
    const theta = Math.abs(ang), phi = ang < 0 ? 0 : Math.PI;
    shell.point(theta, phi, 0.004, v);
    shell.dir(theta, phi, n);
    const h = 0.065 * Math.sin(Math.PI * Math.min(1, t * 1.15)) + 0.01;
    const w = 0.016;
    pos.push(v.x - w, v.y, v.z, v.x + n.x * h, v.y + n.y * h, v.z + n.z * h, v.x + w, v.y, v.z);
  }
  for (let i = 0; i < steps; i++) {
    const a = i * 3, b = (i + 1) * 3;
    idx.push(a, b, a + 1, a + 1, b, b + 1, a + 1, b + 1, a + 2, a + 2, b + 1, b + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  const ng = g.toNonIndexed();
  ng.computeVertexNormals();
  return ng;
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
      B.addRigid(g, HR, Region.Item, variant(Cat.Item, ITEM_IDS[name]), () => shade);
    }
  }
}

/** Jacket / suit / vest: offset shells of the torso + arm triangles, weights copied from the body. */
function addOuter(B: Builder, body: RigBody): void {
  const P = body.position, N = body.normal;
  const waist = (() => {
    let y = 0;
    let n = 0;
    for (let i = 0; i < body.vertexCount; i++) if (body.region[i] === Region.Hips) {
      y += P[i * 3 + 1]!;
      n++;
    }
    return n ? y / n : 1;
  })();
  const kinds: [number, boolean, number][] = [
    [OUTER_IDS.jacket, true, 0.014],
    [OUTER_IDS.vest, false, 0.03],
  ];
  for (const [id, sleeves, thick] of kinds) {
    const vari = variant(Cat.Outer, id);
    const map = new Map<number, number>();
    const use = (i: number): boolean => {
      const r = body.region[i]!;
      const y = P[i * 3 + 1]!;
      if (r === Region.Chest || r === Region.Belly) return true; // the open front is painted (no jagged cut)
      if (r === Region.Hips) return id !== OUTER_IDS.vest ? y > waist - 0.04 : y > waist + 0.02;
      if (!sleeves) return false;
      return r === Region.UpperArm || r === Region.LowerArm;
    };
    // vertices on the shell's border (shared with uncovered triangles) stay on the skin: no spiky hems
    const inside = new Uint8Array(body.vertexCount);
    for (let i = 0; i < body.vertexCount; i++) inside[i] = use(i) ? 1 : 0;
    const border = new Uint8Array(body.vertexCount);
    for (let t = 0; t < body.index.length; t += 3) {
      const a = body.index[t]!, b = body.index[t + 1]!, c = body.index[t + 2]!;
      if (inside[a]! && inside[b]! && inside[c]!) continue;
      border[a] = border[b] = border[c] = 1;
    }
    for (let t = 0; t < body.index.length; t += 3) {
      const a = body.index[t]!, b = body.index[t + 1]!, c = body.index[t + 2]!;
      if (!inside[a] || !inside[b] || !inside[c]) continue;
      for (const i of [a, b, c]) {
        let j = map.get(i);
        if (j === undefined) {
          j = B.count;
          map.set(i, j);
          const nx = N[i * 4]! / 127, ny = N[i * 4 + 1]! / 127, nz = N[i * 4 + 2]! / 127;
          const r = body.region[i]!;
          const k = (r === Region.LowerArm ? thick * 0.75 : thick) * (border[i] ? 0.35 : 1);
          B.pos.push(P[i * 3]! + nx * k, P[i * 3 + 1]! + ny * k, P[i * 3 + 2]! + nz * k);
          B.nrm.push(nx, ny, nz);
          for (let q = 0; q < 4; q++) {
            B.si.push(body.skinIndex[i * 4 + q]!);
            B.sw.push(body.skinWeight[i * 4 + q]!);
          }
          B.reg.push(id === OUTER_IDS.vest ? Region.Vest : Region.Outer);
          B.vari.push(vari);
          B.shade.push(255);
        }
        B.idx.push(j);
      }
    }
  }
}
