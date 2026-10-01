import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { VehicleDef } from './VehicleData';

/** Light ids stored in the `vlight` attribute (see VehicleMaterial). */
export const enum LightId {
  None = 0,
  Head = 1,
  Tail = 2,
  IndL = 3,
  IndR = 4,
  Reverse = 5,
  SirenR = 6,
  SirenB = 7,
  Sign = 8,
  Glow = 9,
}

export interface VehicleMeshInfo {
  body: THREE.BufferGeometry;
  /** Wheel local positions (centre) for visuals; for bikes only 2. */
  wheels: [number, number, number][];
  /** Physics wheel positions (bikes get 4 close together for stability). */
  physWheels: [number, number, number][];
  headlights: [number, number, number][];
  taillights: [number, number, number][];
  /** Driver door (outside, left side) local position. */
  door: [number, number, number];
  /** Passenger door. */
  door2: [number, number, number];
  /** Exhaust position */
  exhaust: [number, number, number];
  /** Engine (smoke/fire) position */
  engine: [number, number, number];
  /** Rotor (heli) */
  rotor?: THREE.BufferGeometry;
  tailRotor?: THREE.BufferGeometry;
  rotorPos?: [number, number, number];
  tailRotorPos?: [number, number, number];
  /** Collision box half extents & centre (local). */
  half: [number, number, number];
  center: [number, number, number];
}

interface Part {
  geo: THREE.BufferGeometry;
}

/** Attach vehicle attributes to a geometry. */
function tag(geo: THREE.BufferGeometry, hex: number, paint: number, light: LightId = LightId.None, glass = 0): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g === geo) g = geo.clone();
  g.deleteAttribute('uv');
  const n = g.attributes.position!.count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('vpaint', new THREE.BufferAttribute(new Float32Array(n).fill(paint), 1));
  g.setAttribute('vlight', new THREE.BufferAttribute(new Float32Array(n).fill(light), 1));
  g.setAttribute('vglass', new THREE.BufferAttribute(new Float32Array(n).fill(glass), 1));
  return g;
}

const parts: Part[] = [];
const add = (g: THREE.BufferGeometry): void => void parts.push({ geo: g });
function box(w: number, h: number, d: number, x: number, y: number, z: number, hex: number, paint = 0, light: LightId = LightId.None, glass = 0): void {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  add(tag(g, hex, paint, light, glass));
}
function cyl(r: number, len: number, x: number, y: number, z: number, axis: 'x' | 'y' | 'z', hex: number, paint = 0, seg = 10, light: LightId = LightId.None): void {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === 'x') g.rotateZ(Math.PI / 2);
  if (axis === 'z') g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  add(tag(g, hex, paint, light));
}
function flush(): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => p.geo), false);
  parts.length = 0;
  if (!g) throw new Error('vehicle merge failed');
  g.computeBoundingSphere();
  return g;
}

/** Extrude a side profile (points in (z, y)) across the car width. */
function extrudeProfile(pts: [number, number][], width: number, bevel: number, hex: number, paint: number, glass = 0, taperTop = 1, topY = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0]![0], pts[0]![1]);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i]![0], pts[i]![1]);
  shape.closePath();
  const depth = Math.max(0.01, width - bevel * 2);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2, curveSegments: 6 });
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  if (taperTop !== 1) {
    const p = g.attributes.position!;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      if (y > topY) {
        const t = Math.min(1, (y - topY) / 0.5);
        p.setX(i, p.getX(i) * (1 - (1 - taperTop) * t));
      }
    }
  }
  return tag(g, hex, paint, LightId.None, glass);
}

/** Side profile with wheel-arch cutouts. */
function lowerProfile(L: number, yb: number, wheels: number[], r: number, hoodH: number, deckH: number, beltF: number, beltR: number, wsBase: number, rwBase: number, noseDrop = 0.12, tailDrop = 0.1): [number, number][] {
  const zr = -L / 2, zf = L / 2;
  const pts: [number, number][] = [];
  pts.push([zr + 0.12, yb]);
  const arcs = [...wheels].sort((a, b) => a - b);
  const ar = r + 0.07;
  for (const wz of arcs) {
    pts.push([wz - ar, yb]);
    for (let k = 1; k < 8; k++) {
      const a = Math.PI - (k / 8) * Math.PI;
      pts.push([wz + Math.cos(a) * ar, Math.max(yb, r + Math.sin(a) * ar)]);
    }
    pts.push([wz + ar, yb]);
  }
  pts.push([zf - 0.12, yb]);
  pts.push([zf, yb + 0.16]);
  pts.push([zf, hoodH - noseDrop]);
  pts.push([zf - 0.18, hoodH]);
  pts.push([wsBase, beltF]);
  pts.push([rwBase, beltR]);
  pts.push([zr + 0.2, deckH]);
  pts.push([zr, deckH - tailDrop]);
  pts.push([zr, yb + 0.14]);
  return pts;
}

const TRIM = 0x1a1a1c;
const CHROME = 0xb8bcc4;
const GLASS = 0x1a2430;
const HEAD = 0xfff4dc;
const TAIL = 0xc81818;
const AMBER = 0xff9a10;

function lights(L: number, W: number, hy: number, ty: number, frontZ = L / 2, rearZ = -L / 2, round = false): { h: [number, number, number][]; t: [number, number, number][] } {
  const hx = W / 2 - 0.28, tx = W / 2 - 0.24;
  for (const s of [1, -1]) {
    if (round) cyl(0.11, 0.06, s * hx, hy, frontZ + 0.01, 'z', HEAD, 0, 10, LightId.Head);
    else box(0.36, 0.13, 0.06, s * hx, hy, frontZ, HEAD, 0, LightId.Head);
    box(0.32, 0.12, 0.06, s * tx, ty, rearZ, TAIL, 0, LightId.Tail);
    box(0.1, 0.07, 0.06, s * (W / 2 - 0.06), hy - 0.02, frontZ - 0.02, AMBER, 0, s > 0 ? LightId.IndL : LightId.IndR);
    box(0.1, 0.07, 0.06, s * (tx - 0.25), ty, rearZ - 0.005, AMBER, 0, s > 0 ? LightId.IndL : LightId.IndR);
    box(0.12, 0.08, 0.06, s * (tx - 0.42), ty, rearZ - 0.005, 0xf0f0f0, 0, LightId.Reverse);
  }
  return { h: [[hx, hy, frontZ + 0.05], [-hx, hy, frontZ + 0.05]], t: [[tx, ty, rearZ - 0.05], [-tx, ty, rearZ - 0.05]] };
}

function mirrors(W: number, y: number, z: number): void {
  for (const s of [1, -1]) {
    box(0.14, 0.1, 0.18, s * (W / 2 + 0.06), y, z, TRIM, 1);
    box(0.02, 0.08, 0.14, s * (W / 2 + 0.13), y, z, CHROME);
  }
}

function plates(W: number, yf: number, yr: number, zf: number, zr: number): void {
  void W;
  box(0.42, 0.12, 0.02, 0, yf, zf + 0.01, 0xf0f0e0);
  box(0.42, 0.12, 0.02, 0, yr, zr - 0.01, 0xf0f0e0);
}

/** Build a car-like vehicle. */
function buildCar(d: VehicleDef): VehicleMeshInfo {
  const L = d.length, W = d.width, H = d.height, r = d.wheelRadius;
  const yb = d.clearance + 0.08;
  const wf = d.wheelBase / 2, wr = -d.wheelBase / 2;
  const s = d.style;
  // style parameters
  let hoodH = 0.95, deckH = 1.0, belt = 1.0, wsBase = 0.65, rwBase = -1.0, roofF = 0.0, roofR = -0.9, roofH = H, cabinW = 0.9, taper = 0.86;
  let noseDrop = 0.12;
  switch (s) {
    case 'hatch': hoodH = 0.82; deckH = 0.95; belt = 0.92; wsBase = L * 0.2; rwBase = -L / 2 + 0.25; roofF = L * 0.02; roofR = -L / 2 + 0.35; break;
    case 'sedan': hoodH = 0.82; deckH = 0.88; belt = 0.9; wsBase = L * 0.17; rwBase = -L * 0.27; roofF = -0.05; roofR = -L * 0.2 - 0.3; break;
    case 'muscle': hoodH = 0.86; deckH = 0.86; belt = 0.86; wsBase = L * 0.08; rwBase = -L * 0.26; roofF = -0.35; roofR = -L * 0.2 - 0.25; taper = 0.84; break;
    case 'coupe': hoodH = 0.7; deckH = 0.82; belt = 0.8; wsBase = L * 0.12; rwBase = -L * 0.32; roofF = -0.25; roofR = -L * 0.2 - 0.1; taper = 0.8; noseDrop = 0.18; break;
    case 'wedge': hoodH = 0.6; deckH = 0.86; belt = 0.74; wsBase = L * 0.16; rwBase = -L * 0.36; roofF = -0.15; roofR = -0.75; taper = 0.76; noseDrop = 0.25; break;
    case 'suv': hoodH = 1.2; deckH = 1.25; belt = 1.25; wsBase = L * 0.2; rwBase = -L / 2 + 0.15; roofF = L * 0.08; roofR = -L / 2 + 0.2; taper = 0.92; cabinW = 0.94; break;
    case 'pickup': hoodH = 1.15; deckH = 1.12; belt = 1.18; wsBase = L * 0.2; rwBase = -0.25; roofF = L * 0.12; roofR = -0.15; taper = 0.92; cabinW = 0.94; break;
    case 'van': hoodH = 1.2; deckH = 1.3; belt = 1.3; wsBase = L * 0.32; rwBase = -L / 2 + 0.05; roofF = L * 0.26; roofR = -L / 2 + 0.05; taper = 0.97; cabinW = 0.97; break;
    case 'box': hoodH = 1.25; deckH = H; belt = 1.3; wsBase = L * 0.33; rwBase = L * 0.18; roofF = L * 0.27; roofR = L * 0.18; taper = 0.95; cabinW = 0.95; break;
    case 'bus': hoodH = H - 0.1; deckH = H - 0.1; belt = 1.25; wsBase = L / 2 - 0.15; rwBase = -L / 2 + 0.05; roofF = L / 2 - 0.25; roofR = -L / 2 + 0.05; taper = 0.98; cabinW = 0.98; break;
  }
  const paintHex = 0xffffff;
  // lower body
  const lp = lowerProfile(L, yb, [wf, wr], r, hoodH, deckH, belt, belt, wsBase, rwBase, noseDrop);
  add(extrudeProfile(lp, W, 0.06, paintHex, 1));
  // undertray / wheel wells (dark)
  box(W - 0.2, 0.12, L - 0.5, 0, yb + 0.02, 0, TRIM);
  for (const z of [wf, wr]) for (const sx of [1, -1]) box(0.3, r * 1.1, r * 2.1, sx * (W / 2 - 0.2), r + 0.05, z, 0x0c0c0c);
  // cabin (glass greenhouse) + roof
  if (s === 'box') {
    // cab front part + tall box rear
    const cabPts: [number, number][] = [[wsBase, belt], [roofF, H * 0.78], [rwBase, H * 0.78], [rwBase, belt]];
    add(extrudeProfile(cabPts, W * cabinW, 0.04, GLASS, 0, 1, taper, belt));
    box(W * cabinW, 0.08, roofF - rwBase, 0, H * 0.78, (roofF + rwBase) / 2, paintHex, 1);
    // rear box
    box(W, H - yb - 0.1, rwBase + L / 2 - 0.05, 0, (H + yb) / 2 + 0.05, (rwBase - L / 2) / 2 + 0.02, paintHex, 1);
  } else {
    const cabPts: [number, number][] = [[wsBase, belt - 0.02], [roofF, roofH], [roofR, roofH], [rwBase, belt - 0.02]];
    add(extrudeProfile(cabPts, W * cabinW, 0.05, GLASS, 0, 1, taper, belt + 0.02));
    // roof skin (painted) slightly above glass
    const rw = W * cabinW * taper - 0.04;
    box(rw, 0.06, Math.max(0.3, roofF - roofR - 0.05), 0, roofH + 0.0, (roofF + roofR) / 2, paintHex, 1);
    // pillars (A, B, C)
    const pz = [(wsBase + roofF) / 2, (roofF + roofR) / 2 + (s === 'bus' || s === 'van' ? 0 : 0.0), (roofR + rwBase) / 2];
    for (const sx of [1, -1]) {
      const px = sx * (W * cabinW * (1 + taper) / 4 + 0.005);
      box(0.06, roofH - belt, 0.09, px, (roofH + belt) / 2, pz[1]!, paintHex, 1);
      if (s === 'bus') for (let z = roofR + 1.2; z < roofF - 0.5; z += 1.3) box(0.06, roofH - belt, 0.08, px, (roofH + belt) / 2, z, paintHex, 1);
    }
  }
  if (s === 'pickup') {
    // bed walls
    const bedL = -0.3 - (-L / 2 + 0.05);
    const bz = (-0.3 + -L / 2 + 0.05) / 2;
    for (const sx of [1, -1]) box(0.08, 0.45, bedL, sx * (W / 2 - 0.08), belt + 0.18, bz, paintHex, 1);
    box(W - 0.1, 0.45, 0.08, 0, belt + 0.18, -L / 2 + 0.09, paintHex, 1);
    box(W - 0.2, 0.04, bedL, 0, belt - 0.02, bz, 0x2a2a2a);
  }
  // bumpers, grille, plates, mirrors, handles
  box(W + 0.02, 0.2, 0.14, 0, yb + 0.16, L / 2 - 0.02, s === 'muscle' ? CHROME : TRIM, s === 'wedge' || s === 'coupe' ? 1 : 0);
  box(W + 0.02, 0.2, 0.14, 0, yb + 0.16, -L / 2 + 0.02, s === 'muscle' ? CHROME : TRIM, s === 'wedge' || s === 'coupe' ? 1 : 0);
  box(W * 0.45, Math.max(0.08, hoodH - yb - 0.45), 0.04, 0, (hoodH + yb) / 2, L / 2 + 0.005, 0x0e0e10);
  plates(W, yb + 0.2, yb + 0.32, L / 2 + 0.06, -L / 2 - 0.06);
  mirrors(W, belt + 0.12, wsBase - 0.1);
  for (const sx of [1, -1]) box(0.03, 0.04, 0.16, sx * (W / 2 + 0.01), belt - 0.12, wsBase - 0.9, CHROME);
  const lt = lights(L, W, hoodH - 0.14, deckH - 0.14, L / 2, -L / 2, s === 'muscle' || s === 'van');
  // exhaust
  cyl(0.045, 0.18, W / 2 - 0.4, yb + 0.05, -L / 2 - 0.05, 'z', 0x6a6a6a);
  if (s === 'muscle' || s === 'wedge' || s === 'coupe') cyl(0.045, 0.18, -(W / 2 - 0.4), yb + 0.05, -L / 2 - 0.05, 'z', 0x6a6a6a);
  // class extras
  if (s === 'wedge' || d.cls === 'sports') {
    box(W * 0.8, 0.05, 0.3, 0, deckH + 0.25, -L / 2 + 0.25, paintHex, 1);
    for (const sx of [1, -1]) box(0.05, 0.22, 0.1, sx * W * 0.32, deckH + 0.12, -L / 2 + 0.28, TRIM);
  }
  if (s === 'muscle') {
    box(0.6, 0.1, 1.0, 0, hoodH + 0.05, L / 2 - 0.9, TRIM); // hood scoop
    box(0.25, 0.02, L * 0.98, 0.25, hoodH + 0.002, 0, 0xffffff, 0); // racing stripes (white)
    box(0.25, 0.02, L * 0.98, -0.25, hoodH + 0.002, 0, 0xffffff, 0);
  }
  if (d.cls === 'police') {
    box(1.1, 0.12, 0.3, 0, roofH + 0.09, (roofF + roofR) / 2, 0x111111);
    box(0.45, 0.1, 0.26, 0.28, roofH + 0.16, (roofF + roofR) / 2, 0xff2020, 0, LightId.SirenR);
    box(0.45, 0.1, 0.26, -0.28, roofH + 0.16, (roofF + roofR) / 2, 0x2040ff, 0, LightId.SirenB);
    // white doors livery
    for (const sx of [1, -1]) box(0.02, belt - yb - 0.2, 1.7, sx * (W / 2 + 0.02), (belt + yb) / 2 + 0.05, 0, 0xf0f0f0);
    box(W * 0.98, 0.02, 0.9, 0, roofH + 0.035, roofR + 0.6, 0xf0f0f0);
    // push bar
    box(W * 0.7, 0.35, 0.08, 0, yb + 0.35, L / 2 + 0.12, 0x111111);
  }
  if (d.cls === 'taxi') {
    box(0.7, 0.18, 0.28, 0, roofH + 0.12, (roofF + roofR) / 2, 0xffe060, 0, LightId.Sign);
    for (const sx of [1, -1]) for (let z = -1.6; z < 1.7; z += 0.4) box(0.02, 0.1, 0.2, sx * (W / 2 + 0.02), belt - 0.18, z, (Math.round(z * 2.5) % 2 === 0) ? 0x111111 : 0xf0f0f0);
  }
  if (d.cls === 'ambulance') {
    for (const sx of [1, -1]) {
      box(0.02, 0.35, L * 0.62, sx * (W / 2 + 0.01), 1.45, -L * 0.15, 0xd02020);
      box(0.02, 0.6, 0.15, sx * (W / 2 + 0.015), 1.9, -L * 0.2, 0xd02020);
      box(0.02, 0.15, 0.6, sx * (W / 2 + 0.015), 1.9, -L * 0.2, 0xd02020);
    }
    box(0.3, 0.12, 0.2, W / 2 - 0.3, H + 0.04, L * 0.18, 0xff2020, 0, LightId.SirenR);
    box(0.3, 0.12, 0.2, -(W / 2 - 0.3), H + 0.04, L * 0.18, 0x2040ff, 0, LightId.SirenB);
    box(0.3, 0.12, 0.2, W / 2 - 0.3, H + 0.04, -L / 2 + 0.2, 0xff2020, 0, LightId.SirenB);
    box(0.3, 0.12, 0.2, -(W / 2 - 0.3), H + 0.04, -L / 2 + 0.2, 0x2040ff, 0, LightId.SirenR);
  }
  if (d.cls === 'swat') {
    for (const sx of [1, -1]) box(0.03, 0.5, L * 0.55, sx * (W / 2 + 0.01), 1.4, -L * 0.15, 0x2a2e34);
    box(0.9, 0.12, 0.25, 0, H + 0.05, L * 0.15, 0x111111);
    box(0.35, 0.1, 0.22, 0.24, H + 0.12, L * 0.15, 0xff2020, 0, LightId.SirenR);
    box(0.35, 0.1, 0.22, -0.24, H + 0.12, L * 0.15, 0x2040ff, 0, LightId.SirenB);
    box(W * 0.8, 0.5, 0.12, 0, yb + 0.45, L / 2 + 0.14, 0x111111);
  }
  if (d.cls === 'bus') {
    for (const sx of [1, -1]) box(0.02, 0.3, L * 0.95, sx * (W / 2 + 0.01), 0.9, 0, 0xf0f0f0);
    box(W * 0.7, 0.25, 0.04, 0, H - 0.35, L / 2 + 0.01, 0xffa020, 0, LightId.Sign);
  }
  if (d.cls === 'van') for (const sx of [1, -1]) box(0.02, 0.5, 2.2, sx * (W / 2 + 0.01), 1.4, -0.8, 0x2a2a2a, 0);

  const wheels: [number, number, number][] = [
    [d.track / 2, r, wf], [-d.track / 2, r, wf], [d.track / 2, r, wr], [-d.track / 2, r, wr],
  ];
  const body = flush();
  const top = s === 'box' || s === 'bus' ? H : roofH;
  return {
    body,
    wheels,
    physWheels: wheels,
    headlights: lt.h,
    taillights: lt.t,
    door: [W / 2 + 0.55, 0, 0.1 + (d.seats[0]?.[2] ?? 0)],
    door2: [-(W / 2 + 0.55), 0, 0.1 + (d.seats[1]?.[2] ?? 0)],
    exhaust: [W / 2 - 0.4, yb + 0.05, -L / 2 - 0.15],
    engine: [0, hoodH, L / 2 - 0.7],
    half: [W / 2, (top - yb) / 2, L / 2],
    center: [0, (top + yb) / 2, 0],
  };
}

function buildBike(d: VehicleDef): VehicleMeshInfo {
  const r = d.wheelRadius, wb = d.wheelBase;
  const cruiser = d.style === 'cruiser';
  const P = 0xffffff;
  // frame
  box(0.12, 0.12, wb * 0.75, 0, r + 0.25, 0, 0x2a2a2a);
  box(0.32, 0.26, 0.55, 0, r + 0.45, wb * 0.15, P, 1); // tank
  box(0.3, 0.1, 0.65, 0, r + (cruiser ? 0.28 : 0.42), -wb * 0.15, 0x141414); // seat
  box(0.36, 0.28, 0.4, 0, r + 0.12, 0.05, 0x3a3a3a); // engine
  cyl(0.06, 0.5, 0.12, r + 0.05, -wb * 0.35, 'z', CHROME); // exhaust
  if (cruiser) cyl(0.06, 0.5, -0.12, r + 0.05, -wb * 0.35, 'z', CHROME);
  // forks
  for (const sx of [1, -1]) {
    const g = new THREE.CylinderGeometry(0.03, 0.03, 0.75, 6);
    g.rotateX(cruiser ? -0.55 : -0.35);
    g.translate(sx * 0.09, r + 0.35, wb / 2 - 0.12);
    add(tag(g, CHROME, 0));
  }
  box(0.7, 0.04, 0.04, 0, r + 0.72, wb / 2 - (cruiser ? 0.35 : 0.25), 0x1a1a1a); // bars
  cyl(0.09, 0.08, 0, r + 0.55, wb / 2 - 0.08, 'z', HEAD, 0, 10, LightId.Head);
  box(0.16, 0.07, 0.04, 0, r + 0.42, -wb / 2 - 0.12, TAIL, 0, LightId.Tail);
  if (!cruiser) {
    // fairing
    box(0.4, 0.3, 0.35, 0, r + 0.55, wb / 2 - 0.2, P, 1);
    box(0.32, 0.22, 0.04, 0, r + 0.78, wb / 2 - 0.3, GLASS, 0, LightId.None, 1);
    box(0.25, 0.18, 0.5, 0, r + 0.45, -wb / 2 + 0.05, P, 1); // tail
  } else {
    box(0.3, 0.06, 0.5, 0, r + 0.25, -wb / 2 + 0.05, P, 1); // rear fender
    box(0.24, 0.05, 0.45, 0, r + 0.3, wb / 2 - 0.05, P, 1);
  }
  const body = flush();
  const wheels: [number, number, number][] = [[0, r, wb / 2], [0, r, -wb / 2]];
  const phys: [number, number, number][] = [[0.11, r, wb / 2], [-0.11, r, wb / 2], [0.11, r, -wb / 2], [-0.11, r, -wb / 2]];
  return {
    body, wheels, physWheels: phys,
    headlights: [[0, r + 0.55, wb / 2]], taillights: [[0, r + 0.42, -wb / 2 - 0.12]],
    door: [0.7, 0, 0], door2: [-0.7, 0, 0], exhaust: [0.12, r + 0.05, -wb * 0.55], engine: [0, r + 0.2, 0],
    half: [0.3, 0.45, d.length / 2 - 0.1], center: [0, r + 0.4, 0],
  };
}

function hullGeometry(L: number, W: number, H: number, hex: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  const hw = W / 2;
  s.moveTo(-hw, -L / 2);
  s.lineTo(hw, -L / 2);
  s.lineTo(hw, L * 0.15);
  s.quadraticCurveTo(hw * 0.95, L * 0.42, 0, L / 2);
  s.quadraticCurveTo(-hw * 0.95, L * 0.42, -hw, L * 0.15);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: H, bevelEnabled: true, bevelSize: 0.06, bevelThickness: 0.06, bevelSegments: 2, curveSegments: 8 });
  // shape in XY, extruded along +Z → rotate so extrusion goes down (−Y) and shape Y → +Z
  g.rotateX(Math.PI / 2);
  // now y ∈ [0, H] downward? after rotateX(π/2): (x, y, z) → (x, -z, y): extrude z → -y
  const p = g.attributes.position!;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i); // 0 top … -H bottom
    const t = Math.min(1, Math.max(0, -y / H));
    // V-hull: narrow the bottom, lift bow
    p.setX(i, p.getX(i) * (1 - t * 0.75));
    const z = p.getZ(i);
    if (z > L * 0.1) p.setY(i, y + t * ((z - L * 0.1) / (L * 0.4)) * H * 0.55);
  }
  g.translate(0, H * 0.6, 0);
  g.computeVertexNormals();
  return tag(g, hex, 1);
}

function buildBoat(d: VehicleDef): VehicleMeshInfo {
  const L = d.length, W = d.width, H = d.height;
  add(hullGeometry(L, W, H * 0.75, 0xffffff));
  // deck
  box(W * 0.9, 0.06, L * 0.62, 0, H * 0.62, -L * 0.12, 0xb89a6a);
  // gunwale stripe
  for (const sx of [1, -1]) box(0.03, 0.08, L * 0.55, sx * (W / 2 - 0.02), H * 0.45, -0.1, 0x1a3a8a);
  if (d.style === 'speedboat') {
    box(W * 0.8, 0.5, 1.2, 0, H * 0.62 + 0.25, L * 0.12, 0xffffff, 1);
    const ws = new THREE.BoxGeometry(W * 0.78, 0.45, 0.05);
    ws.rotateX(-0.6);
    ws.translate(0, H * 0.62 + 0.62, L * 0.12 + 0.35);
    add(tag(ws, GLASS, 0, LightId.None, 1));
    box(0.5, 0.5, 0.5, 0.5, H * 0.62 + 0.25, -0.4, 0xd8d0c0);
    box(0.5, 0.5, 0.5, -0.5, H * 0.62 + 0.25, -0.4, 0xd8d0c0);
    box(0.5, 0.7, 0.6, 0, H * 0.4, -L / 2 - 0.15, 0x2a2a2a); // outboard
    box(0.5, 0.7, 0.6, 0.6, H * 0.4, -L / 2 - 0.15, 0x2a2a2a);
  } else {
    box(0.6, 0.35, 0.45, 0, H * 0.62 + 0.18, -L * 0.25, 0xd8d0c0);
    box(0.4, 0.6, 0.4, 0, H * 0.5, -L / 2 - 0.1, 0x2a2a2a);
    box(0.08, 0.08, 0.6, 0, H * 0.62 + 0.5, -L / 2 + 0.1, 0x3a3a3a); // tiller
  }
  cyl(0.08, 0.04, W * 0.38, H * 0.65, L / 2 - 0.5, 'y', 0x30ff40, 0, 8, LightId.Glow);
  cyl(0.08, 0.04, -W * 0.38, H * 0.65, L / 2 - 0.5, 'y', 0xff3030, 0, 8, LightId.Glow);
  const body = flush();
  return {
    body, wheels: [], physWheels: [], headlights: [[0, H * 0.9, L / 2 - 0.3]], taillights: [],
    door: [W / 2 + 0.6, 0, 0], door2: [-(W / 2 + 0.6), 0, 0], exhaust: [0, H * 0.3, -L / 2 - 0.3], engine: [0, H * 0.5, -L / 2 + 0.2],
    half: [W / 2, H * 0.4, L / 2], center: [0, H * 0.35, 0],
  };
}

function buildHeli(d: VehicleDef): VehicleMeshInfo {
  void d;
  const P = 0xffffff;
  const cab = new THREE.SphereGeometry(1, 14, 10);
  cab.scale(1.15, 1.05, 2.0);
  cab.translate(0, 1.55, 0.7);
  add(tag(cab, P, 1));
  const glass = new THREE.SphereGeometry(1.01, 14, 10, 0, Math.PI * 2, 0.15 * Math.PI, 0.45 * Math.PI);
  glass.rotateX(-Math.PI / 2 + 0.2);
  glass.scale(1.1, 0.9, 1.7);
  glass.translate(0, 1.75, 1.35);
  add(tag(glass, GLASS, 0, LightId.None, 1));
  const boom = new THREE.CylinderGeometry(0.18, 0.38, 4.6, 8);
  boom.rotateX(Math.PI / 2);
  boom.translate(0, 1.85, -3.0);
  add(tag(boom, P, 1));
  box(0.08, 1.1, 0.7, 0, 2.3, -5.0, P, 1);
  box(1.4, 0.06, 0.45, 0, 1.9, -4.6, P, 1);
  for (const sx of [1, -1]) {
    box(0.08, 0.08, 3.2, sx * 1.0, 0.1, 0.5, 0x2a2a2a);
    box(0.06, 0.6, 0.06, sx * 0.85, 0.4, 1.3, 0x2a2a2a);
    box(0.06, 0.6, 0.06, sx * 0.85, 0.4, -0.3, 0x2a2a2a);
  }
  cyl(0.18, 0.4, 0, 2.7, 0.4, 'y', 0x3a3a3a);
  box(0.12, 0.08, 0.08, 0, 0.95, 2.6, HEAD, 0, LightId.Head);
  box(0.1, 0.1, 0.1, 0.06, 2.1, -5.3, 0xff2020, 0, LightId.Glow);
  box(0.1, 0.1, 0.1, 1.05, 1.5, 0.6, 0x20ff20, 0, LightId.Glow);
  box(0.1, 0.1, 0.1, -1.05, 1.5, 0.6, 0xff2020, 0, LightId.Glow);
  const body = flush();
  // rotors (separate meshes so they can spin)
  box(10.5, 0.04, 0.32, 0, 0, 0, 0x1a1a1a);
  box(0.32, 0.04, 10.5, 0, 0, 0, 0x1a1a1a);
  const rotor = flush();
  box(0.05, 1.5, 0.14, 0, 0, 0, 0x1a1a1a);
  const tail = flush();
  return {
    body, wheels: [], physWheels: [], headlights: [[0, 0.95, 2.7]], taillights: [], rotor, tailRotor: tail,
    rotorPos: [0, 2.95, 0.4], tailRotorPos: [0.12, 2.25, -5.1],
    door: [1.6, 0, 1.0], door2: [-1.6, 0, 1.0], exhaust: [0, 2.4, -0.6], engine: [0, 2.4, -0.4],
    half: [1.15, 1.0, 2.2], center: [0, 1.4, 0.4],
  };
}

const cache = new Map<string, VehicleMeshInfo>();
export function vehicleMesh(d: VehicleDef): VehicleMeshInfo {
  let m = cache.get(d.id);
  if (m) return m;
  m = d.kind === 'bike' ? buildBike(d) : d.kind === 'boat' ? buildBoat(d) : d.kind === 'heli' ? buildHeli(d) : buildCar(d);
  cache.set(d.id, m);
  return m;
}

/** Shared wheel geometry: axle along X, unit radius & width (scale per vehicle). */
export function wheelGeometry(): THREE.BufferGeometry {
  const tire = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
  tire.rotateZ(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 10, 1);
  rim.rotateZ(Math.PI / 2);
  const hub = new THREE.BoxGeometry(1.08, 0.18, 1.1);
  const hub2 = new THREE.BoxGeometry(1.08, 1.1, 0.18);
  const g = mergeGeometries([tag(tire, 0x151515, 0), tag(rim, 0xa8acb4, 0), tag(hub, 0x6a6e76, 0), tag(hub2, 0x6a6e76, 0)], false)!;
  g.computeVertexNormals();
  return g;
}
