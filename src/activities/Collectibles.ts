import * as THREE from 'three';
import type { Game, System } from '../game/Game';
import { pickSpread } from './logic';
import { DESERT_ROADS, ISLANDS, LANDMARKS, coastX, isSea } from '../world/MapData';
import type { WorldData } from '../world/CityGen';
import { formatMoney } from '../core/math';

export const SHELL_COUNT = 30;
export const SHELL_REWARD = 250;
export const SHELL_COMPLETE_BONUS = 25000;

/** Deterministic Saint Shell locations: city corners, beaches, islands and the desert. */
export function shellSpots(wd: WorldData): { x: number; z: number }[] {
  const city: { x: number; z: number }[] = [];
  for (const b of wd.blocks) {
    if (b.district === 'desert' || b.district === 'sea') continue;
    city.push({ x: b.x0 + 3.2, z: b.z0 + 3.2 }, { x: b.x1 - 3.2, z: b.z1 - 3.2 });
  }
  const beach: { x: number; z: number }[] = [];
  for (let z = -320; z <= 1040; z += 45) {
    const x = coastX(z) + 14;
    if (!isSea(x, z) && (z < 560 || z > 880)) beach.push({ x, z });
  }
  const islands: { x: number; z: number }[] = [];
  for (const isl of ISLANDS) {
    for (let a = 0; a < 12; a++) {
      const r = isl.r * 0.55;
      const x = isl.x + Math.cos(a * 0.52) * r, z = isl.z + Math.sin(a * 0.52) * r;
      if (!isSea(x, z)) islands.push({ x, z });
    }
  }
  const desert: { x: number; z: number }[] = [];
  for (const road of DESERT_ROADS) {
    for (let i = 1; i < road.points.length; i++) {
      const [x0, z0] = road.points[i - 1]!, [x1, z1] = road.points[i]!;
      const h = Math.atan2(x1 - x0, z1 - z0);
      desert.push({ x: (x0 + x1) / 2 + Math.cos(h) * 16, z: (z0 + z1) / 2 - Math.sin(h) * 16 });
    }
  }
  for (const l of LANDMARKS) if (l.kind === 'lighthouse' || l.kind === 'diner' || l.kind === 'helipad') desert.push({ x: l.x + 4, z: l.z + 4 });
  return [
    ...pickSpread(city, 14, 160, 11),
    ...pickSpread(beach, 5, 160, 12),
    ...pickSpread(islands, 4, 90, 13),
    ...pickSpread(desert, 7, 200, 14),
  ].slice(0, SHELL_COUNT);
}

/** Hidden Saint Shell collectibles (one instanced draw call). */
export class Collectibles implements System {
  name = 'collectibles';
  readonly spots: { x: number; z: number; y: number | null }[];
  readonly found = new Set<number>();
  private mesh: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3(1, 1, 1);
  private p = new THREE.Vector3();
  private t = 0;

  constructor(private game: Game) {
    this.spots = shellSpots(game.world!.data).map((s) => ({ ...s, y: null }));
    // scallop shell: a flattened, ribbed half-disc
    const geo = new THREE.CylinderGeometry(0.34, 0.06, 0.12, 14, 1, false, -Math.PI * 0.6, Math.PI * 1.2);
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const a = Math.atan2(x, z);
      const rib = 1 + Math.cos(a * 9) * 0.06;
      pos.setX(i, x * rib);
      pos.setZ(i, z * rib);
    }
    geo.rotateX(-Math.PI / 2.6);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({ color: 0xffb0d0, emissive: 0xff4d9a, emissiveIntensity: 0.9, roughness: 0.35, metalness: 0.2 });
    this.mesh = new THREE.InstancedMesh(geo, mat, this.spots.length);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    game.scene.add(this.mesh);
  }

  get count(): number {
    return this.found.size;
  }

  load(indices: number[]): void {
    this.found.clear();
    for (const i of indices) if (i >= 0 && i < this.spots.length) this.found.add(i);
  }

  save(): number[] {
    return [...this.found].sort((a, b) => a - b);
  }

  update(dt: number): void {
    const g = this.game;
    const w = g.world;
    if (!w) return;
    this.t += dt;
    const inVeh = !!g.vctrl?.inVehicle;
    const pp = inVeh ? g.vctrl!.vehicle!.position : g.player.pos;
    let n = 0;
    for (let i = 0; i < this.spots.length; i++) {
      if (this.found.has(i)) continue;
      const s = this.spots[i]!;
      const d = Math.hypot(s.x - pp.x, s.z - pp.z);
      if (d > 140) continue;
      if (s.y === null) {
        if (!w.isLoaded(s.x, s.z)) continue;
        s.y = Math.max(w.groundY(s.x, s.z), -0.6);
      }
      if (d < (inVeh ? 3.2 : 1.6) && Math.abs(pp.y - s.y) < 3) {
        this.collect(i);
        continue;
      }
      this.q.setFromAxisAngle(_up, this.t * 1.6 + i);
      this.p.set(s.x, s.y + 0.7 + Math.sin(this.t * 2.2 + i) * 0.12, s.z);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(n++, this.m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private collect(i: number): void {
    const g = this.game;
    this.found.add(i);
    g.wallet.add(SHELL_REWARD, 'Saint Shell');
    g.stats.max('shells', this.found.size);
    g.haptic([15, 30, 15]);
    if (this.found.size >= this.spots.length) {
      g.wallet.add(SHELL_COMPLETE_BONUS, 'All Saint Shells');
      g.hud.big('ALL SAINT SHELLS', 'passed', `+${formatMoney(SHELL_COMPLETE_BONUS)}`, 4);
    } else g.hud.toast(`🐚 Saint Shell ${this.found.size}/${this.spots.length}  +${formatMoney(SHELL_REWARD)}`, 2200);
    g.events.emit('pickup', { kind: 'shell', amount: 1 });
    g.events.emit('saveRequested', { reason: 'collectible' });
  }
}

const _up = new THREE.Vector3(0, 1, 0);
