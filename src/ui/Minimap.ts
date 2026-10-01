import type { WorldData } from '../world/CityGen';
import { DISTRICTS, LANDMARKS, isSea, type LandmarkKind } from '../world/MapData';
import { WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../world/constants';

export type BlipShape = 'dot' | 'square' | 'triangle' | 'diamond' | 'ring' | 'icon';
export interface Blip {
  x: number;
  z: number;
  color: string;
  shape: BlipShape;
  size?: number;
  /** Letter / emoji for icon blips */
  label?: string;
  /** Show at the map edge when off-screen (mission targets). */
  pin?: boolean;
  /** Vision cone (police in search mode): heading & range */
  cone?: { yaw: number; range: number };
  /** Height relation marker (▲ above, ▼ below) */
  dy?: number;
}

export const LANDMARK_ICONS: Partial<Record<LandmarkKind, { label: string; color: string }>> = {
  police: { label: '★', color: '#4d8aff' },
  hospital: { label: '+', color: '#ff4d4d' },
  gunshop: { label: '⌖', color: '#ff9a4d' },
  respray: { label: '✦', color: '#ffd250' },
  modshop: { label: '⚙', color: '#9ad0ff' },
  barber: { label: '✂', color: '#ff7ad0' },
  clothes: { label: '👕', color: '#d0a0ff' },
  tattoo: { label: '✒', color: '#a07aff' },
  safehouse: { label: '⌂', color: '#7dffa1' },
  club: { label: '♫', color: '#ff4dd2' },
  gas: { label: '⛽', color: '#ffd250' },
  boatrental: { label: '⚓', color: '#7ad0ff' },
  helipad: { label: 'H', color: '#ffffff' },
  diner: { label: '☕', color: '#ffb07a' },
  business: { label: '$', color: '#7dffa1' },
};

/** Renders the full map once to an offscreen canvas (2 m/px). Shared by minimap and phone map. */
export function renderBaseMap(wd: WorldData): HTMLCanvasElement {
  const scale = 0.5; // px per metre
  const W = (WORLD_MAX_X - WORLD_MIN_X) * scale, H = (WORLD_MAX_Z - WORLD_MIN_Z) * scale;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const tx = (x: number): number => (x - WORLD_MIN_X) * scale;
  const tz = (z: number): number => (z - WORLD_MIN_Z) * scale;
  // sea / land
  const img = g.createImageData(W, H);
  const dcol = new Map<string, [number, number, number]>();
  const hex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
  for (const d of DISTRICTS) dcol.set(d.id, hex(d.color));
  const t = wd.terrain;
  for (let j = 0; j < H; j += 1)
    for (let i = 0; i < W; i += 1) {
      const x = WORLD_MIN_X + (i + 0.5) / scale, z = WORLD_MIN_Z + (j + 0.5) / scale;
      const h = t.sample(x, z);
      let r: number, gg: number, b: number;
      if (isSea(x, z) || h < -1.2) {
        const deep = Math.min(1, Math.max(0, (-h - 1) / 12));
        r = 40 - deep * 20; gg = 110 - deep * 50; b = 150 - deep * 40;
      } else {
        let col: [number, number, number] | undefined;
        for (const d of DISTRICTS) if (x >= d.x0 && x < d.x1 && z >= d.z0 && z < d.z1) { col = dcol.get(d.id); break; }
        col = col ?? [200, 180, 140];
        if (h < 0.5 && x < 300) col = [205, 190, 150];
        const shade = x > 300 ? Math.min(1.25, 0.85 + h * 0.012) : 1;
        r = col[0] * shade; gg = col[1] * shade; b = col[2] * shade;
      }
      const o = (j * W + i) * 4;
      img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  // buildings
  g.fillStyle = 'rgba(30,30,40,0.55)';
  for (const b of wd.buildings) g.fillRect(tx(b.x - b.hx), tz(b.z - b.hz), b.hx * 2 * scale, b.hz * 2 * scale);
  // roads
  const gr = wd.graph;
  g.lineCap = 'round';
  for (const pass of [0, 1]) {
    for (const e of gr.edges) {
      const a = gr.nodes[e.a]!, bb = gr.nodes[e.b]!;
      g.strokeStyle = pass === 0 ? 'rgba(20,20,24,0.7)' : e.kind === 'highway' ? '#f0d890' : '#e8e8e8';
      g.lineWidth = Math.max(2, e.width * scale * (pass === 0 ? 1.3 : 0.85));
      g.beginPath();
      g.moveTo(tx(a.x), tz(a.z));
      g.lineTo(tx(bb.x), tz(bb.z));
      g.stroke();
    }
  }
  return c;
}

/** Circular rotating minimap. */
export class Minimap {
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private size = 150;
  blips: Blip[] = [];
  route: [number, number][] | null = null;
  routeColor = '#c86aff';
  zoom = 1; // 1 = ~180 m radius
  private acc = 0;
  searchArea: { x: number; z: number; r: number } | null = null;
  flash: 'none' | 'red' | 'blue' = 'none';
  private flashT = 0;

  constructor(private wrap: HTMLDivElement, private base: HTMLCanvasElement) {
    this.canvas = document.createElement('canvas');
    wrap.appendChild(this.canvas);
    this.g = this.canvas.getContext('2d')!;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const r = this.wrap.getBoundingClientRect();
    this.size = Math.max(80, Math.round(r.width || 150));
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = this.size * dpr;
    this.canvas.height = this.size * dpr;
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** @param heading camera yaw (map rotates so camera forward is up) */
  draw(dt: number, px: number, pz: number, heading: number, playerYaw: number, speed: number): void {
    this.acc += dt;
    if (this.acc < 1 / 24) return;
    this.acc = 0;
    if (this.wrap.getBoundingClientRect().width !== this.size) this.resize();
    const g = this.g;
    const S = this.size;
    const half = S / 2;
    const radiusM = 170 * this.zoom * (1 + Math.min(speed, 40) / 60);
    const ppm = half / radiusM; // px per metre
    g.save();
    g.clearRect(0, 0, S, S);
    g.translate(half, half);
    // rotation: camera forward (sin h, cos h) should point up (-y on canvas).
    // world +z maps to canvas +y; rotate by (h - π)… derive: angle = π + h
    g.rotate(Math.PI + heading);
    const bs = 0.5; // base px per metre
    const k = ppm / bs;
    g.scale(k, k);
    g.translate(-(px - WORLD_MIN_X) * bs, -(pz - WORLD_MIN_Z) * bs);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.base, 0, 0);
    // search area
    const w2c = (x: number, z: number): [number, number] => [(x - WORLD_MIN_X) * bs, (z - WORLD_MIN_Z) * bs];
    if (this.searchArea) {
      const [sx, sz] = w2c(this.searchArea.x, this.searchArea.z);
      g.fillStyle = this.flash === 'red' ? 'rgba(255,60,60,0.22)' : 'rgba(80,120,255,0.22)';
      g.beginPath();
      g.arc(sx, sz, this.searchArea.r * bs, 0, Math.PI * 2);
      g.fill();
    }
    // route
    if (this.route && this.route.length > 1) {
      g.strokeStyle = this.routeColor;
      g.lineWidth = 5 / k;
      g.lineJoin = 'round';
      g.beginPath();
      const [x0, z0] = w2c(this.route[0]![0], this.route[0]![1]);
      g.moveTo(x0, z0);
      for (let i = 1; i < this.route.length; i++) {
        const [x, z] = w2c(this.route[i]![0], this.route[i]![1]);
        g.lineTo(x, z);
      }
      g.stroke();
    }
    // landmark icons
    g.font = `${12 / k}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const l of LANDMARKS) {
      const ic = LANDMARK_ICONS[l.kind];
      if (!ic) continue;
      const d = Math.hypot(l.x - px, l.z - pz);
      if (d > radiusM * 1.1) continue;
      const [x, z] = w2c(l.x, l.z);
      g.save();
      g.translate(x, z);
      g.rotate(-(Math.PI + heading));
      g.fillStyle = 'rgba(0,0,0,0.65)';
      g.beginPath();
      g.arc(0, 0, 8 / k, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = ic.color;
      g.fillText(ic.label, 0, 0.5 / k);
      g.restore();
    }
    // blips
    for (const b of this.blips) {
      let [x, z] = w2c(b.x, b.z);
      const d = Math.hypot(b.x - px, b.z - pz);
      let edge = false;
      if (d > radiusM * 0.92) {
        if (!b.pin) continue;
        const f = (radiusM * 0.9) / d;
        [x, z] = w2c(px + (b.x - px) * f, pz + (b.z - pz) * f);
        edge = true;
      }
      if (b.cone) {
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.beginPath();
        g.moveTo(x, z);
        const r = b.cone.range * bs;
        const a = Math.atan2(Math.cos(b.cone.yaw), Math.sin(b.cone.yaw));
        g.arc(x, z, r, a - 0.6, a + 0.6);
        g.closePath();
        g.fill();
      }
      const s = ((b.size ?? 5) * (edge ? 0.85 : 1)) / k;
      g.fillStyle = b.color;
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.lineWidth = 1.2 / k;
      g.beginPath();
      if (b.shape === 'square') g.rect(x - s, z - s, s * 2, s * 2);
      else if (b.shape === 'diamond') {
        g.moveTo(x, z - s * 1.3); g.lineTo(x + s, z); g.lineTo(x, z + s * 1.3); g.lineTo(x - s, z); g.closePath();
      } else if (b.shape === 'triangle') {
        g.moveTo(x, z - s * 1.2); g.lineTo(x + s, z + s); g.lineTo(x - s, z + s); g.closePath();
      } else if (b.shape === 'ring') {
        g.arc(x, z, s * 1.6, 0, Math.PI * 2);
        g.lineWidth = 2.5 / k;
        g.strokeStyle = b.color;
        g.stroke();
        continue;
      } else g.arc(x, z, s, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      if (b.label) {
        g.save();
        g.translate(x, z);
        g.rotate(-(Math.PI + heading));
        g.fillStyle = '#000';
        g.fillText(b.label, 0, 0.5 / k);
        g.restore();
      }
    }
    g.restore();
    // player arrow (always centre, rotated relative to camera)
    g.save();
    g.translate(half, half);
    g.rotate(-(playerYaw - heading));
    g.fillStyle = '#fff';
    g.strokeStyle = '#000';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(0, -8);
    g.lineTo(6, 6);
    g.lineTo(0, 3);
    g.lineTo(-6, 6);
    g.closePath();
    g.fill();
    g.stroke();
    g.restore();
    // north indicator
    g.save();
    g.translate(half, half);
    g.rotate(Math.PI + heading);
    g.fillStyle = '#ff4d5a';
    g.font = 'bold 11px system-ui';
    g.textAlign = 'center';
    g.fillText('N', 0, -half + 10);
    g.restore();
    // flashing border
    this.flashT += 1 / 24;
    this.wrap.classList.toggle('flash-red', this.flash !== 'none' && Math.floor(this.flashT * 3) % 2 === 0);
    this.wrap.classList.toggle('flash-blue', this.flash !== 'none' && Math.floor(this.flashT * 3) % 2 === 1);
  }
}
