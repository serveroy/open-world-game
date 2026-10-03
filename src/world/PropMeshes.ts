import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { PropType } from './CityGen';

/** Collision proxy for a prop type (local space, yaw applied at placement). */
export type PropShape =
  | { kind: 'none' }
  | { kind: 'cyl'; r: number; h: number; y?: number }
  | { kind: 'box'; hx: number; hy: number; hz: number; ox?: number; oy?: number; oz?: number }
  | { kind: 'multi'; parts: ({ kind: 'cyl'; r: number; h: number; x: number; z: number } | { kind: 'box'; hx: number; hy: number; hz: number; x: number; y: number; z: number })[] };

export interface PropDef {
  geo: THREE.BufferGeometry;
  shape: PropShape;
  /** Breakable by vehicles (knocked over) */
  breakable?: boolean;
  castShadow?: boolean;
  /** Colour variants applied via instanceColor */
  variants?: number[];
  /** Local light glow offsets (bulbs) for night glow sprites */
  glows?: [number, number, number][];
  /** Max view distance */
  far?: number;
}

/** Vertex-colour helper producing world-material compatible attributes. */
function prep(geo: THREE.BufferGeometry, hex: number, emissive = 0): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.deleteAttribute('uv');
  const n = g.attributes.position!.count;
  const c = new THREE.Color(hex);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('uvm', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  const wp = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) wp[i * 4 + 3] = emissive;
  g.setAttribute('wparams', new THREE.BufferAttribute(wp, 4));
  return g;
}
function merge(...parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const m = mergeGeometries(parts, false);
  if (!m) throw new Error('prop merge failed');
  return m;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number, e = 0): THREE.BufferGeometry => {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return prep(g, hex, e);
};
const cyl = (r0: number, r1: number, h: number, x: number, y: number, z: number, hex: number, seg = 8, e = 0): THREE.BufferGeometry => {
  const g = new THREE.CylinderGeometry(r1, r0, h, seg);
  g.translate(x, y + h / 2, z);
  return prep(g, hex, e);
};
const blob = (r: number, x: number, y: number, z: number, hex: number, sx = 1, sy = 1, sz = 1, detail = 1): THREE.BufferGeometry => {
  const g = new THREE.IcosahedronGeometry(r, detail);
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return prep(g, hex);
};

function palm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  let x = 0, y = 0;
  const segs = 6;
  for (let i = 0; i < segs; i++) {
    const h = 1.35;
    const g = new THREE.CylinderGeometry(0.17 - i * 0.012, 0.22 - i * 0.012, h, 7);
    g.translate(0, h / 2, 0);
    g.rotateZ(-0.06 * i);
    g.translate(x, y, 0);
    parts.push(prep(g, i % 2 ? 0x8a6a48 : 0x7a5a3a));
    x += Math.sin(0.06 * i) * h;
    y += Math.cos(0.06 * i) * h * 0.98;
  }
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const leaf = new THREE.ConeGeometry(0.5, 3.6, 3, 1);
    leaf.scale(1, 1, 0.18);
    leaf.translate(0, 1.8, 0);
    leaf.rotateZ(Math.PI / 2 + 0.55 + (k % 2) * 0.3);
    leaf.rotateY(a);
    leaf.translate(x, y, 0);
    parts.push(prep(leaf, k % 2 ? 0x3a7a2a : 0x4a8a30));
  }
  parts.push(blob(0.35, x, y - 0.1, 0, 0x6a5a2a));
  return merge(...parts);
}

function tree(): THREE.BufferGeometry {
  return merge(
    cyl(0.22, 0.16, 3, 0, 0, 0, 0x5a4030, 6),
    blob(1.9, 0, 4.2, 0, 0x4a7a32, 1, 0.9, 1),
    blob(1.4, 0.9, 5.2, 0.4, 0x56883a, 1, 0.9, 1, 0),
    blob(1.3, -0.8, 4.9, -0.5, 0x3e6e2c, 1, 0.9, 1, 0),
  );
}

function cactus(): THREE.BufferGeometry {
  const c = 0x4a7a3a;
  const armL = new THREE.CylinderGeometry(0.17, 0.17, 1.4, 7);
  armL.translate(0.65, 2.3, 0);
  const elbowL = new THREE.CylinderGeometry(0.17, 0.17, 0.5, 7);
  elbowL.rotateZ(Math.PI / 2);
  elbowL.translate(0.4, 1.7, 0);
  const armR = new THREE.CylinderGeometry(0.15, 0.15, 1.0, 7);
  armR.translate(-0.55, 2.8, 0);
  const elbowR = new THREE.CylinderGeometry(0.15, 0.15, 0.4, 7);
  elbowR.rotateZ(Math.PI / 2);
  elbowR.translate(-0.35, 2.35, 0);
  return merge(cyl(0.28, 0.24, 3.6, 0, 0, 0, c), blob(0.24, 0, 3.6, 0, c, 1, 0.8, 1, 0), prep(armL, c), prep(elbowL, c), prep(armR, 0x427032), prep(elbowR, 0x427032));
}

function streetlight(): THREE.BufferGeometry {
  const pole = 0x3a3c40;
  const arm = new THREE.BoxGeometry(0.1, 0.1, 2.2);
  arm.translate(0, 7.0, 1.0);
  return merge(cyl(0.14, 0.09, 7.1, 0, 0, 0, pole, 5), prep(arm, pole), box(0.5, 0.18, 0.8, 0, 6.92, 2.1, 0x2a2a2a), box(0.36, 0.05, 0.6, 0, 6.82, 2.1, 0xfff2c8, 1.2));
}

function trafficlight(): THREE.BufferGeometry {
  const pole = 0x2a2c30;
  const arm = new THREE.BoxGeometry(0.12, 0.12, 5);
  arm.translate(0, 5.4, 2.5);
  return merge(cyl(0.15, 0.12, 5.6, 0, 0, 0, pole, 6), prep(arm, pole), box(0.36, 1.1, 0.34, 0, 4.95, 4.6, 0x1a1a1a), box(0.3, 0.9, 0.3, 0, 1.3, 0.2, 0x1a1a1a));
}

function crane(): THREE.BufferGeometry {
  const c = 0xd04a2a;
  const parts: THREE.BufferGeometry[] = [];
  for (const [x, z] of [[-6, -5], [6, -5], [-6, 5], [6, 5]] as const) parts.push(box(0.8, 24, 0.8, x, 12, z, c));
  parts.push(box(13.6, 1.4, 1.2, 0, 24, -5, c), box(13.6, 1.4, 1.2, 0, 24, 5, c), box(1.2, 1.4, 11, -6, 24, 0, c), box(1.2, 1.4, 11, 6, 24, 0, c));
  parts.push(box(2.2, 2.2, 52, 0, 27, 14, c), box(5, 4, 6, 0, 27.5, -6, 0x3a3a3a), box(3, 3, 3, 0, 26, 2, 0xe8e8e8));
  parts.push(box(0.1, 10, 0.1, 0, 20.5, 34, 0x222222), box(2.6, 0.4, 6.2, 0, 15.4, 34, 0xe0a020));
  return merge(...parts);
}

function container(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(2.44, 2.59, 6.06, 1, 1, 6);
  g.translate(0, 1.295, 0);
  const ribs: THREE.BufferGeometry[] = [prep(g, 0xffffff)];
  for (let i = -2.5; i <= 2.5; i += 0.5) ribs.push(box(2.5, 2.45, 0.08, 0, 1.3, i, 0xdddddd));
  ribs.push(box(2.3, 2.4, 0.06, 0, 1.3, 3.04, 0xbbbbbb));
  return merge(...ribs);
}

function billboard(): THREE.BufferGeometry {
  return merge(box(0.4, 7, 0.4, -3.5, 3.5, 0, 0x4a4a4a), box(0.4, 7, 0.4, 3.5, 3.5, 0, 0x4a4a4a), box(10.5, 4.2, 0.3, 0, 8, 0, 0xf0f0f0), box(10, 3.7, 0.32, 0, 8, 0.01, 0xffffff, 0.3), box(10.6, 0.2, 1, 0, 5.8, 0.5, 0x4a4a4a));
}

function canopy(): THREE.BufferGeometry {
  const parts = [box(20, 0.9, 11, 0, 5.4, 0, 0xf0f0f0), box(20.2, 0.5, 11.2, 0, 4.9, 0, 0xd02a2a), box(18, 0.05, 9, 0, 4.85, 0, 0xfff8e8, 1.2)];
  for (const x of [-8, 8]) for (const z of [-3.5, 3.5]) parts.push(box(0.5, 5, 0.5, x, 2.5, z, 0xe0e0e0));
  return merge(...parts);
}

export function buildPropDefs(): Record<PropType, PropDef> {
  const none: PropShape = { kind: 'none' };
  return {
    streetlight: { geo: streetlight(), shape: { kind: 'cyl', r: 0.16, h: 7 }, breakable: true, glows: [[0, 6.75, 2.1]], far: 330 },
    trafficlight: { geo: trafficlight(), shape: { kind: 'cyl', r: 0.16, h: 5.5 }, breakable: true, far: 300 },
    palm: { geo: palm(), shape: { kind: 'cyl', r: 0.24, h: 7 }, castShadow: true, far: 400 },
    tree: { geo: tree(), shape: { kind: 'cyl', r: 0.25, h: 3 }, castShadow: true, far: 400 },
    bush: { geo: merge(blob(1, 0, 0.6, 0, 0x4a7a32, 1.2, 0.8, 1.1), blob(0.7, 0.6, 0.5, 0.3, 0x3e6e2c)), shape: none, far: 160 },
    hydrant: { geo: merge(cyl(0.16, 0.14, 0.7, 0, 0, 0, 0xc02a2a), blob(0.16, 0, 0.72, 0, 0xc02a2a, 1, 0.7, 1, 0), box(0.45, 0.1, 0.1, 0, 0.45, 0, 0xb02020)), shape: { kind: 'cyl', r: 0.18, h: 0.8 }, breakable: true, far: 120 },
    bench: { geo: merge(box(1.8, 0.08, 0.5, 0, 0.45, 0, 0x7a5a3a), box(1.8, 0.4, 0.06, 0, 0.75, -0.22, 0x7a5a3a), box(0.08, 0.45, 0.45, -0.8, 0.22, 0, 0x2a2a2a), box(0.08, 0.45, 0.45, 0.8, 0.22, 0, 0x2a2a2a)), shape: { kind: 'box', hx: 0.9, hy: 0.45, hz: 0.25, oy: 0.45 }, breakable: true, far: 120 },
    trashcan: { geo: merge(cyl(0.28, 0.3, 0.95, 0, 0, 0, 0x3a5a3a), cyl(0.32, 0.32, 0.06, 0, 0.95, 0, 0x2a3a2a)), shape: { kind: 'cyl', r: 0.3, h: 1 }, breakable: true, far: 120 },
    container: { geo: container(), shape: { kind: 'box', hx: 1.22, hy: 1.3, hz: 3.03, oy: 1.3 }, castShadow: true, variants: [0xb83a2a, 0x2a5a9a, 0x3a8a4a, 0xd8a030, 0x6a6a6a, 0xe8e8e8], far: 500 },
    crane: { geo: crane(), shape: { kind: 'multi', parts: [{ kind: 'box', hx: 0.5, hy: 12, hz: 0.5, x: -6, y: 12, z: -5 }, { kind: 'box', hx: 0.5, hy: 12, hz: 0.5, x: 6, y: 12, z: -5 }, { kind: 'box', hx: 0.5, hy: 12, hz: 0.5, x: -6, y: 12, z: 5 }, { kind: 'box', hx: 0.5, hy: 12, hz: 0.5, x: 6, y: 12, z: 5 }] }, castShadow: true, far: 900 },
    cactus: { geo: cactus(), shape: { kind: 'cyl', r: 0.3, h: 3.6 }, castShadow: true, far: 260 },
    rock: { geo: (() => { const g = new THREE.DodecahedronGeometry(1.3, 0); g.scale(1.3, 0.8, 1); g.translate(0, 0.5, 0); return prep(g, 0x9a7a5a); })(), shape: { kind: 'box', hx: 1.4, hy: 0.9, hz: 1.1, oy: 0.5 }, far: 300 },
    deadtree: { geo: merge(cyl(0.18, 0.1, 3.5, 0, 0, 0, 0x5a4a3a), (() => { const g = new THREE.CylinderGeometry(0.05, 0.09, 1.8, 5); g.rotateZ(0.8); g.translate(0.6, 2.8, 0); return prep(g, 0x5a4a3a); })(), (() => { const g = new THREE.CylinderGeometry(0.04, 0.08, 1.5, 5); g.rotateZ(-0.9); g.rotateY(1.2); g.translate(-0.3, 2.2, 0.4); return prep(g, 0x5a4a3a); })()), shape: { kind: 'cyl', r: 0.2, h: 3 }, far: 220 },
    billboard: { geo: billboard(), shape: { kind: 'multi', parts: [{ kind: 'cyl', r: 0.25, h: 7, x: -3.5, z: 0 }, { kind: 'cyl', r: 0.25, h: 7, x: 3.5, z: 0 }] }, castShadow: true, variants: [0xffe0a0, 0xa0d8ff, 0xffa0c0, 0xc0ffa0], far: 700 },
    pump: { geo: merge(box(0.9, 1.7, 0.55, 0, 0.85, 0, 0xe8e8e8), box(0.95, 0.35, 0.6, 0, 1.75, 0, 0xd02a2a), box(0.5, 0.3, 0.05, 0, 1.2, 0.29, 0x2a2a2a, 0.6), box(1.6, 0.25, 1.1, 0, 0.12, 0, 0xb8b8b0)), shape: { kind: 'box', hx: 0.45, hy: 0.9, hz: 0.3, oy: 0.9 }, far: 250 },
    phonebooth: { geo: merge(box(1, 2.3, 1, 0, 1.15, 0, 0x2a4a8a), box(0.8, 1.6, 1.02, 0, 1.2, 0, 0x8ab0d0)), shape: { kind: 'box', hx: 0.5, hy: 1.15, hz: 0.5, oy: 1.15 }, breakable: true, far: 140 },
    acunit: { geo: merge(box(2, 1.2, 1.4, 0, 0.6, 0, 0x9a9a9a), cyl(0.5, 0.5, 0.1, 0, 1.2, 0, 0x5a5a5a)), shape: none, far: 300 },
    watertower: { geo: merge(cyl(1.8, 1.8, 3.2, 0, 2, 0, 0x7a5a3a, 10), (() => { const g = new THREE.ConeGeometry(1.95, 1, 10); g.translate(0, 5.7, 0); return prep(g, 0x5a4a3a); })(), box(0.15, 2, 0.15, -1.3, 1, -1.3, 0x3a3a3a), box(0.15, 2, 0.15, 1.3, 1, -1.3, 0x3a3a3a), box(0.15, 2, 0.15, -1.3, 1, 1.3, 0x3a3a3a), box(0.15, 2, 0.15, 1.3, 1, 1.3, 0x3a3a3a)), shape: none, castShadow: true, far: 600 },
    dumpster: { geo: merge(box(2, 1.25, 1.2, 0, 0.72, 0, 0xffffff), box(2.05, 0.1, 1.25, 0, 1.38, 0, 0x2a2a2a), box(0.1, 0.12, 0.1, -0.8, 0.06, 0.4, 0x222222)), shape: { kind: 'box', hx: 1, hy: 0.7, hz: 0.6, oy: 0.7 }, variants: [0x2a6a3a, 0x2a4a8a, 0x8a3a2a], far: 160 },
    umbrella: { geo: merge(cyl(0.04, 0.04, 2.3, 0, 0, 0, 0xdddddd), (() => { const g = new THREE.ConeGeometry(1.4, 0.5, 8); g.translate(0, 2.4, 0); return prep(g, 0xffffff); })(), box(1.8, 0.1, 0.7, 1.2, 0.2, 0.2, 0xf0e8d8)), shape: none, variants: [0xe04a3a, 0x3a8ae0, 0xe0c03a, 0x3ac08a, 0xe07ac0], far: 200 },
    lifeguard: { geo: merge(box(0.2, 2.5, 0.2, -1, 1.25, -1, 0xe8e8e8), box(0.2, 2.5, 0.2, 1, 1.25, -1, 0xe8e8e8), box(0.2, 2.5, 0.2, -1, 1.25, 1, 0xe8e8e8), box(0.2, 2.5, 0.2, 1, 1.25, 1, 0xe8e8e8), box(2.6, 2, 2.6, 0, 3.5, 0, 0xe05a3a), (() => { const g = new THREE.ConeGeometry(2.2, 1, 4); g.rotateY(Math.PI / 4); g.translate(0, 5, 0); return prep(g, 0xf0f0f0); })()), shape: { kind: 'box', hx: 1.3, hy: 2.25, hz: 1.3, oy: 2.25 }, castShadow: true, far: 400 },
    pier: { geo: box(1, 1, 1, 0, 0, 0, 0x7a5a3a), shape: none },
    canopy: { geo: canopy(), shape: { kind: 'multi', parts: [{ kind: 'cyl', r: 0.3, h: 5, x: -8, z: -3.5 }, { kind: 'cyl', r: 0.3, h: 5, x: 8, z: -3.5 }, { kind: 'cyl', r: 0.3, h: 5, x: -8, z: 3.5 }, { kind: 'cyl', r: 0.3, h: 5, x: 8, z: 3.5 }, { kind: 'box', hx: 10, hy: 0.6, hz: 5.5, x: 0, y: 5.3, z: 0 }] }, castShadow: true, far: 500 },
    busstop: { geo: merge(box(3, 0.08, 1.4, 0, 2.5, 0, 0x3a3a3a), box(3, 2.4, 0.06, 0, 1.25, -0.65, 0x9ac0d8), box(0.08, 2.5, 1.4, -1.5, 1.25, 0, 0x3a3a3a), box(0.08, 2.5, 1.4, 1.5, 1.25, 0, 0x3a3a3a), box(2.4, 0.08, 0.4, 0, 0.5, -0.4, 0x5a4a3a), box(1.2, 1.8, 0.07, 0.6, 1.4, -0.6, 0xffe8b0, 0.4)), shape: { kind: 'box', hx: 1.5, hy: 1.25, hz: 0.1, oy: 1.25, oz: -0.65 }, far: 180 },
    barrier: { geo: merge(box(2, 0.5, 0.6, 0, 0.25, 0, 0xc8c4bc), box(2, 0.4, 0.3, 0, 0.7, 0, 0xc8c4bc)), shape: { kind: 'box', hx: 1, hy: 0.45, hz: 0.3, oy: 0.45 }, far: 200 },
    fence: { geo: box(1, 1, 1, 0, 0, 0, 0x8a8a8a), shape: none },
    neonsign: { geo: box(2, 0.6, 0.1, 0, 0, 0, 0xff2a8a, 1.4), shape: none },
    antenna: { geo: merge(cyl(0.08, 0.04, 12, 0, 0, 0, 0x8a8a8a, 5), box(0.15, 0.15, 0.15, 0, 12, 0, 0xff2a2a, 2)), shape: none, far: 900 },
    bollard: { geo: cyl(0.12, 0.12, 0.9, 0, 0, 0, 0xe0c040), shape: { kind: 'cyl', r: 0.13, h: 0.9 }, far: 100 },
    mailbox: { geo: merge(box(0.5, 1.1, 0.45, 0, 0.55, 0, 0x2a4a9a), blob(0.25, 0, 1.1, 0, 0x2a4a9a, 1, 0.6, 0.9, 0)), shape: { kind: 'box', hx: 0.25, hy: 0.6, hz: 0.25, oy: 0.6 }, breakable: true, far: 100 },
  };
}
