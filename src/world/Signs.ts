import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { LANDMARKS, type Landmark, type LandmarkKind } from './MapData';
import type { WorldData } from './CityGen';

/** Line under the name: what the place is. */
export const KIND_TAG: Partial<Record<LandmarkKind, string>> = {
  police: 'POLICE', hospital: 'HOSPITAL · EMERGENCY', gunshop: 'GUNS · AMMO · ARMOR', respray: 'RESPRAY · BODY SHOP', modshop: 'PERFORMANCE MODS',
  barber: 'BARBER', clothes: 'CLOTHING', tattoo: 'TATTOO STUDIO', safehouse: 'SAFEHOUSE', club: 'NIGHTCLUB · 20:00–05:00', gas: 'GAS',
  bank: 'BANK', helipad: 'HELIPAD', boatrental: 'BOATS', diner: 'DINER', business: 'BUSINESS', warehouse: 'SHIPPING', villa: 'PRIVATE',
};

const KIND_STYLE: Partial<Record<LandmarkKind, { bg: string; fg: string; tag: string }>> = {
  gunshop: { bg: '#1c1210', fg: '#ff8a4a', tag: '#ffd9c4' },
  barber: { bg: '#0c1c1e', fg: '#4affea', tag: '#d4fffa' },
  tattoo: { bg: '#140c1e', fg: '#c07aff', tag: '#eadcff' },
  clothes: { bg: '#f2ece2', fg: '#1a1612', tag: '#6a5a4a' },
  modshop: { bg: '#0c1426', fg: '#5ab4ff', tag: '#d4e8ff' },
  respray: { bg: '#2a1408', fg: '#ffd250', tag: '#fff0c4' },
  club: { bg: '#14061a', fg: '#ff4dd2', tag: '#ffd4f4' },
  business: { bg: '#1a1606', fg: '#ffe02a', tag: '#fff6c4' },
  safehouse: { bg: '#0e1a10', fg: '#7dffa1', tag: '#d8ffe2' },
  police: { bg: '#0c1426', fg: '#ffffff', tag: '#9ac0ff' },
  hospital: { bg: '#f4f4f4', fg: '#c81e1e', tag: '#3a3a3a' },
};

const CELL_W = 512, CELL_H = 96, COLS = 2;

/** Landmarks that get a storefront name sign. */
export function signedLandmarks(): Landmark[] {
  return LANDMARKS.filter((l) => l.kind !== 'lighthouse' && l.kind !== 'helipad');
}

/**
 * Lit name signs over every landmark's door, drawn as one merged mesh with a single canvas atlas
 * (one draw call for the whole city). Signs are unlit so they read as illuminated at night.
 */
export function buildSigns(wd: WorldData): THREE.Mesh | null {
  if (typeof document === 'undefined') return null;
  const list = signedLandmarks();
  const rows = Math.ceil(list.length / COLS);
  const canvas = document.createElement('canvas');
  canvas.width = CELL_W * COLS;
  canvas.height = THREE.MathUtils.ceilPowerOfTwo(rows * CELL_H);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const geos: THREE.BufferGeometry[] = [];
  list.forEach((l, i) => {
    const cx = (i % COLS) * CELL_W, cy = Math.floor(i / COLS) * CELL_H;
    const st = KIND_STYLE[l.kind] ?? { bg: '#16141c', fg: '#ffffff', tag: '#c8c4d0' };
    ctx.fillStyle = st.bg;
    ctx.fillRect(cx, cy, CELL_W, CELL_H);
    ctx.strokeStyle = st.fg;
    ctx.lineWidth = 4;
    ctx.strokeRect(cx + 4, cy + 4, CELL_W - 8, CELL_H - 8);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = st.fg;
    let size = 44;
    ctx.font = `900 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    const name = l.name.toUpperCase();
    while (ctx.measureText(name).width > CELL_W - 36 && size > 20) {
      size -= 2;
      ctx.font = `900 ${size}px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    }
    ctx.fillText(name, cx + CELL_W / 2, cy + 38);
    ctx.fillStyle = st.tag;
    ctx.font = `700 19px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`;
    ctx.fillText(KIND_TAG[l.kind] ?? '', cx + CELL_W / 2, cy + 74);
    // quad on the facade above the door
    const b = wd.buildings.find((x) => x.landmark === l.id);
    const fx = Math.round(Math.sin(l.yaw)), fz = Math.round(Math.cos(l.yaw));
    const base = b?.tiers[0] ?? { hx: l.hx, hz: l.hz };
    const bx = b?.x ?? l.bx, bz = b?.z ?? l.bz, y0 = b?.y ?? 0.16, h = b?.h ?? l.height;
    const along = fx !== 0 ? base.hz : base.hx;
    const w = Math.min(along * 1.7, 8.5), hh = w * (CELL_H / CELL_W);
    const y = y0 + Math.min(Math.max(3.9, h - hh - 0.4), 5.4) + hh / 2;
    // centre on the door along the facade, pushed just in front of the wall
    const px = fx !== 0 ? bx + fx * (base.hx + 0.3) : THREE.MathUtils.clamp(l.x, bx - base.hx + w / 2, bx + base.hx - w / 2);
    const pz = fz !== 0 ? bz + fz * (base.hz + 0.3) : THREE.MathUtils.clamp(l.z, bz - base.hz + w / 2, bz + base.hz - w / 2);
    const g = new THREE.PlaneGeometry(w, hh);
    const uv = g.attributes.uv!;
    const u0 = cx / canvas.width, u1 = (cx + CELL_W) / canvas.width;
    const v1 = 1 - cy / canvas.height, v0 = 1 - (cy + CELL_H) / canvas.height;
    for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) < 0.5 ? u0 : u1, uv.getY(k) < 0.5 ? v0 : v1);
    g.rotateY(Math.atan2(fx, fz));
    g.translate(px, y, pz);
    geos.push(g);
  });
  const merged = mergeGeometries(geos);
  for (const g of geos) g.dispose();
  if (!merged) return null;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  const mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, fog: true });
  const mesh = new THREE.Mesh(merged, mat);
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.name = 'landmark-signs';
  return mesh;
}
