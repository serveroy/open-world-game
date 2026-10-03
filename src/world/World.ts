import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Physics } from '../physics/Physics';
import { GROUPS } from '../physics/groups';
import { WorldData, chunkCoord, chunkKey, CHUNKS_X, CHUNKS_Z, type PropType, type Prop } from './CityGen';
import { buildChunk, terrainColor, type BoxCollider } from './ChunkBuilder';
import { buildPropDefs, type PropDef } from './PropMeshes';
import { Terrain, HF_COLS, HF_ROWS } from './Terrain';
import { CHUNK_SIZE, WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z, WATER_Y } from './constants';
import { getWorldMaterial, patchWorldMaterial } from '../render/WorldMaterial';
import { GeoBuilder } from './GeoBuilder';
import { lightColor, LIGHT_CYCLE } from './Roads';
import { districtAt, districtName, type DistrictId } from './MapData';
import { basicMaterial } from '../render/materials';

interface LoadedChunk {
  key: number;
  cx: number;
  cz: number;
  mesh: THREE.Mesh;
  colliders: RAPIER.Collider[];
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Owns static world content: heightfield collider, streamed chunk meshes/colliders,
 * instanced props, night glows, traffic light lamps and the far LOD (terrain + skyline).
 */
export class World {
  readonly data: WorldData;
  readonly terrain: Terrain;
  private loaded = new Map<number, LoadedChunk>();
  private queue: number[] = [];
  private mat: THREE.Material;
  private propDefs: Record<PropType, PropDef>;
  private propMeshes = new Map<PropType, THREE.InstancedMesh>();
  private propsDirty = true;
  private broken = new Set<number>();
  private lampMesh: THREE.InstancedMesh;
  private lampSlots: { prop: Prop; node: number; ns: boolean; base: THREE.Vector3; face: THREE.Vector3 }[] = [];
  private glowMesh: THREE.InstancedMesh;
  private poolMesh: THREE.InstancedMesh;
  private glowMat: THREE.MeshBasicMaterial;
  private poolMat: THREE.MeshBasicMaterial;
  private lodMask: THREE.DataTexture;
  private lodMaskData: Uint8Array;
  private farTerrain: THREE.Mesh;
  private skyline: THREE.Mesh;
  radius: number;
  readonly focus = new THREE.Vector3();
  private focusChunk = [-999, -999];
  trafficTime = 0;
  district: DistrictId = 'sea';
  onDistrict: ((id: DistrictId, name: string) => void) | null = null;
  /** Called when a chunk finishes loading (for spawning parked cars etc.). */
  onChunkLoaded: ((key: number) => void) | null = null;
  onChunkUnloaded: ((key: number) => void) | null = null;
  private shadows: boolean;

  constructor(private scene: THREE.Scene, private physics: Physics, seed: number, opts: { radius: number; low: boolean; shadows: boolean }, onProgress?: (p: number, msg: string) => void) {
    this.radius = opts.radius;
    this.shadows = opts.shadows;
    this.terrain = new Terrain(seed);
    onProgress?.(0.05, 'Shaping terrain');
    this.terrain.build((p) => onProgress?.(0.05 + p * 0.35, 'Shaping terrain'));
    onProgress?.(0.42, 'Laying roads');
    this.data = new WorldData(seed, this.terrain);
    onProgress?.(0.55, 'Building physics');
    const hf = RAPIER.ColliderDesc.heightfield(HF_ROWS, HF_COLS, this.terrain.rapierHeights(), { x: WORLD_MAX_X - WORLD_MIN_X, y: 1, z: WORLD_MAX_Z - WORLD_MIN_Z })
      .setTranslation((WORLD_MIN_X + WORLD_MAX_X) / 2, 0, (WORLD_MIN_Z + WORLD_MAX_Z) / 2)
      .setCollisionGroups(GROUPS.static)
      .setFriction(0.9);
    const hfc = physics.world.createCollider(hf);
    physics.setOwner(hfc, { kind: 'static', ref: 'terrain' });
    this.mat = getWorldMaterial(opts.low);
    this.propDefs = buildPropDefs();
    onProgress?.(0.62, 'Planting palms');
    this.createPropMeshes(opts.low);

    // night glows
    this.glowMat = new THREE.MeshBasicMaterial({ color: 0xffe0a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true });
    this.glowMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.45, 0), this.glowMat, 1500);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.count = 0;
    scene.add(this.glowMesh);
    const poolTex = radialTexture();
    this.poolMat = new THREE.MeshBasicMaterial({ map: poolTex, color: 0xffd8a0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: true, polygonOffset: true, polygonOffsetFactor: -2 });
    const pg = new THREE.PlaneGeometry(11, 11);
    pg.rotateX(-Math.PI / 2);
    this.poolMesh = new THREE.InstancedMesh(pg, this.poolMat, 1500);
    this.poolMesh.frustumCulled = false;
    this.poolMesh.count = 0;
    this.poolMesh.renderOrder = 2;
    scene.add(this.poolMesh);
    this.lampMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(0.14, 6, 4), basicMaterial('tl-lamp', { color: 0xffffff }), 1500);
    this.lampMesh.frustumCulled = false;
    this.lampMesh.count = 0;
    scene.add(this.lampMesh);

    // far LOD
    this.lodMaskData = new Uint8Array(CHUNKS_X * CHUNKS_Z);
    this.lodMask = new THREE.DataTexture(this.lodMaskData, CHUNKS_X, CHUNKS_Z, THREE.RedFormat, THREE.UnsignedByteType);
    this.lodMask.needsUpdate = true;
    onProgress?.(0.7, 'Painting the skyline');
    const farMat = opts.low ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    patchWorldMaterial(farMat, { lodMask: this.lodMask, grain: false });
    this.farTerrain = new THREE.Mesh(this.buildFarTerrain(), farMat);
    this.farTerrain.frustumCulled = false;
    scene.add(this.farTerrain);
    const skyMat = opts.low ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    patchWorldMaterial(skyMat, { lodMask: this.lodMask, grain: false });
    this.skyline = new THREE.Mesh(this.buildSkyline(), skyMat);
    this.skyline.frustumCulled = false;
    scene.add(this.skyline);
  }

  setRadius(r: number): void {
    this.radius = r;
    this.focusChunk = [-999, -999];
  }

  setShadows(on: boolean): void {
    this.shadows = on;
    for (const c of this.loaded.values()) {
      c.mesh.castShadow = on;
      c.mesh.receiveShadow = on;
    }
    for (const [t, m] of this.propMeshes) m.castShadow = on && !!this.propDefs[t].castShadow;
  }

  // ---------------------------------------------------------------------------
  private createPropMeshes(low: boolean): void {
    const counts = new Map<PropType, number>();
    for (const p of this.data.props) counts.set(p.type, (counts.get(p.type) ?? 0) + 1);
    const propMat = low ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    patchWorldMaterial(propMat, { grain: false });
    for (const [type, def] of Object.entries(this.propDefs) as [PropType, PropDef][]) {
      const n = counts.get(type) ?? 0;
      if (n === 0 || type === 'pier' || type === 'fence') continue;
      const mesh = new THREE.InstancedMesh(def.geo, propMat, Math.min(n, 5000));
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.castShadow = this.shadows && !!def.castShadow;
      mesh.receiveShadow = false;
      if (def.variants) {
        for (let i = 0; i < mesh.instanceMatrix.count; i++) mesh.setColorAt(i, _c.setHex(0xffffff));
      }
      mesh.name = `prop_${type}`;
      this.scene.add(mesh);
      this.propMeshes.set(type, mesh);
    }
  }

  /** Mark a prop broken (knocked over): removed from instancing and collisions. */
  breakProp(index: number): void {
    if (this.broken.has(index)) return;
    this.broken.add(index);
    const p = this.data.props[index]!;
    const [cx, cz] = chunkCoord(p.x, p.z);
    const ch = this.loaded.get(chunkKey(cx, cz));
    if (ch) {
      for (let i = ch.colliders.length - 1; i >= 0; i--) {
        const c = ch.colliders[i]!;
        const o = this.physics.ownerOf(c);
        if (o && o.kind === 'prop' && o.ref === index) {
          this.physics.removeCollider(c);
          ch.colliders.splice(i, 1);
        }
      }
    }
    this.propsDirty = true;
  }
  isBroken(index: number): boolean {
    return this.broken.has(index);
  }
  propDef(type: PropType): PropDef {
    return this.propDefs[type];
  }
  restoreProps(): void {
    if (this.broken.size === 0) return;
    this.broken.clear();
    // reload loaded chunks' prop colliders by forcing a rebuild
    const keys = Array.from(this.loaded.keys());
    for (const k of keys) this.unload(k);
    this.focusChunk = [-999, -999];
  }

  private rebuildProps(): void {
    const counters = new Map<PropType, number>();
    const fx = this.focus.x, fz = this.focus.z;
    let glows = 0;
    this.lampSlots.length = 0;
    for (const ch of this.loaded.values()) {
      const content = this.data.chunks.get(ch.key)!;
      const ccx = WORLD_MIN_X + (ch.cx + 0.5) * CHUNK_SIZE, ccz = WORLD_MIN_Z + (ch.cz + 0.5) * CHUNK_SIZE;
      const chunkDist = Math.hypot(ccx - fx, ccz - fz) - CHUNK_SIZE * 0.7;
      for (const pi of content.props) {
        if (this.broken.has(pi)) continue;
        const p = this.data.props[pi]!;
        const mesh = this.propMeshes.get(p.type);
        const def = this.propDefs[p.type];
        if (!mesh) continue;
        if (def.far !== undefined && chunkDist > def.far) continue;
        const i = counters.get(p.type) ?? 0;
        if (i >= mesh.instanceMatrix.count) continue;
        counters.set(p.type, i + 1);
        _q.setFromAxisAngle(UP, p.yaw);
        _m.compose(_v.set(p.x, p.y, p.z), _q, _s.set(p.s, p.s, p.s));
        mesh.setMatrixAt(i, _m);
        if (def.variants && mesh.instanceColor) mesh.setColorAt(i, _c.setHex(def.variants[p.c % def.variants.length]!));
        if (def.glows && glows < 1500 && chunkDist < 260) {
          for (const g of def.glows) {
            _v.set(g[0], g[1], g[2]).applyQuaternion(_q).multiplyScalar(p.s).add(_s.set(p.x, p.y, p.z));
            _m.makeTranslation(_v.x, _v.y, _v.z);
            this.glowMesh.setMatrixAt(glows, _m);
            _m.makeTranslation(_v.x, p.y + 0.07, _v.z);
            this.poolMesh.setMatrixAt(glows, _m);
            glows++;
          }
        }
        if (p.type === 'trafficlight' && this.lampSlots.length < 480) {
          const armDir = _v.set(Math.sin(p.yaw), 0, Math.cos(p.yaw));
          const base = new THREE.Vector3(p.x + armDir.x * 4.6, p.y + 4.95, p.z + armDir.z * 4.6);
          // lamps face the drivers approaching the junction: perpendicular to the arm, away from node
          const node = this.data.graph.nodes[p.c]!;
          const ns = Math.abs(Math.sin(p.yaw)) > 0.5;
          const face = ns ? new THREE.Vector3(0, 0, Math.sign(p.z - node.z)) : new THREE.Vector3(Math.sign(p.x - node.x), 0, 0);
          this.lampSlots.push({ prop: p, node: p.c, ns, base, face });
        }
      }
    }
    for (const [type, mesh] of this.propMeshes) {
      mesh.count = counters.get(type) ?? 0;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.glowMesh.count = glows;
    this.poolMesh.count = glows;
    this.glowMesh.instanceMatrix.needsUpdate = true;
    this.poolMesh.instanceMatrix.needsUpdate = true;
    this.lampMesh.count = this.lampSlots.length * 3;
    this.propsDirty = false;
  }

  private updateLamps(): void {
    const t = this.trafficTime;
    const g = this.data.graph;
    for (let i = 0; i < this.lampSlots.length; i++) {
      const s = this.lampSlots[i]!;
      const node = g.nodes[s.node]!;
      const col = lightColor((t + node.phase) % LIGHT_CYCLE, s.ns);
      for (let k = 0; k < 3; k++) {
        const y = s.base.y + 0.33 - k * 0.33;
        _m.makeTranslation(s.base.x + s.face.x * 0.19, y, s.base.z + s.face.z * 0.19);
        this.lampMesh.setMatrixAt(i * 3 + k, _m);
        const on = (k === 0 && col === 'red') || (k === 1 && col === 'yellow') || (k === 2 && col === 'green');
        const hex = k === 0 ? (on ? 0xff2a1a : 0x2a0a08) : k === 1 ? (on ? 0xffc020 : 0x2a2008) : on ? 0x30ff60 : 0x082a10;
        this.lampMesh.setColorAt(i * 3 + k, _c.setHex(hex));
      }
    }
    this.lampMesh.instanceMatrix.needsUpdate = true;
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  private buildFarTerrain(): THREE.BufferGeometry {
    const g = new GeoBuilder();
    const step = 25;
    const nx = (WORLD_MAX_X - WORLD_MIN_X) / step, nz = (WORLD_MAX_Z - WORLD_MIN_Z) / step;
    const chunkAttr: number[] = [];
    const t = this.terrain;
    const hAt = (x: number, z: number): number => t.sample(x, z) - 0.35;
    for (let j = 0; j < nz; j++)
      for (let i = 0; i < nx; i++) {
        const x0 = WORLD_MIN_X + i * step, z0 = WORLD_MIN_Z + j * step;
        const x1 = x0 + step, z1 = z0 + step;
        const h = hAt(x0 + step / 2, z0 + step / 2);
        terrainColor(this.data, x0 + step / 2, z0 + step / 2, h, 0, _c);
        g.colorRGB(_c.r, _c.g, _c.b).params(0);
        g.quad(x0, hAt(x0, z1), z1, x1, hAt(x1, z1), z1, x1, hAt(x1, z0), z0, x0, hAt(x0, z0), z0);
        const cx = Math.floor(i * step / CHUNK_SIZE), cz = Math.floor(j * step / CHUNK_SIZE);
        for (let k = 0; k < 6; k++) chunkAttr.push(cx, cz);
      }
    // simplified road ribbons in the far view
    const gr = this.data.graph;
    for (const e of gr.edges) {
      const a = gr.nodes[e.a]!, b = gr.nodes[e.b]!;
      g.color(0x3e3e40).params(0);
      const n0 = g.vertexCount;
      g.strip(a.x, a.z, b.x, b.z, e.width, (e.kind === 'city' ? 0 : t.sample(a.x, a.z)) - 0.2, (e.kind === 'city' ? 0 : t.sample(b.x, b.z)) - 0.2);
      const [cx, cz] = chunkCoord((a.x + b.x) / 2, (a.z + b.z) / 2);
      for (let k = n0; k < g.vertexCount; k++) chunkAttr.push(cx, cz);
    }
    const geo = g.build();
    geo.setAttribute('chunk', new THREE.Float32BufferAttribute(chunkAttr, 2));
    return geo;
  }

  private buildSkyline(): THREE.BufferGeometry {
    const g = new GeoBuilder();
    const chunkAttr: number[] = [];
    for (const b of this.data.buildings) {
      if (b.h < 12) continue;
      const n0 = g.vertexCount;
      for (const t of b.tiers) {
        g.color(b.color, 0.95).params(b.windows, b.floorH, b.seed, 0);
        g.box(b.x + t.ox, b.y, b.z + t.oz, t.hx, t.h, t.hz, b.roof);
      }
      const [cx, cz] = chunkCoord(b.x, b.z);
      for (let k = n0; k < g.vertexCount; k++) chunkAttr.push(cx, cz);
    }
    const geo = g.build();
    geo.setAttribute('chunk', new THREE.Float32BufferAttribute(chunkAttr, 2));
    return geo;
  }

  // ---------------------------------------------------------------------------
  private load(key: number): void {
    if (this.loaded.has(key)) return;
    const content = this.data.chunks.get(key);
    if (!content) return;
    const built = buildChunk(this.data, content);
    const mesh = new THREE.Mesh(built.geometry, this.mat);
    mesh.castShadow = this.shadows;
    mesh.receiveShadow = this.shadows;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.scene.add(mesh);
    const colliders: RAPIER.Collider[] = [];
    for (const c of built.colliders) colliders.push(this.addBox(c));
    // prop colliders
    for (const pi of content.props) {
      if (this.broken.has(pi)) continue;
      const p = this.data.props[pi]!;
      const def = this.propDefs[p.type];
      this.addPropColliders(p, pi, def, colliders);
    }
    this.loaded.set(key, { key, cx: content.cx, cz: content.cz, mesh, colliders });
    this.lodMaskData[content.cz * CHUNKS_X + content.cx] = 255;
    this.lodMask.needsUpdate = true;
    this.propsDirty = true;
    this.onChunkLoaded?.(key);
  }

  private addBox(c: BoxCollider): RAPIER.Collider {
    const d = RAPIER.ColliderDesc.cuboid(c.hx, c.hy, c.hz).setTranslation(c.x, c.y, c.z).setCollisionGroups(GROUPS.static).setFriction(0.7);
    if (c.yaw) d.setRotation({ x: 0, y: Math.sin(c.yaw / 2), z: 0, w: Math.cos(c.yaw / 2) });
    const col = this.physics.world.createCollider(d);
    this.physics.setOwner(col, { kind: 'static', ref: c.kind });
    return col;
  }

  private addPropColliders(p: Prop, index: number, def: PropDef, out: RAPIER.Collider[]): void {
    const sh = def.shape;
    if (sh.kind === 'none') return;
    const cs = Math.cos(p.yaw), sn = Math.sin(p.yaw);
    const rot = { x: 0, y: Math.sin(p.yaw / 2), z: 0, w: Math.cos(p.yaw / 2) };
    const group = def.breakable ? GROUPS.prop : GROUPS.static;
    const mk = (desc: RAPIER.ColliderDesc): void => {
      desc.setCollisionGroups(group).setFriction(0.6);
      const c = this.physics.world.createCollider(desc);
      this.physics.setOwner(c, { kind: 'prop', ref: index });
      out.push(c);
    };
    const s = p.s;
    if (sh.kind === 'cyl') mk(RAPIER.ColliderDesc.cylinder((sh.h * s) / 2, sh.r * s).setTranslation(p.x, p.y + (sh.h * s) / 2 + (sh.y ?? 0), p.z));
    else if (sh.kind === 'box') {
      const ox = (sh.ox ?? 0) * s, oz = (sh.oz ?? 0) * s;
      mk(RAPIER.ColliderDesc.cuboid(sh.hx * s, sh.hy * s, sh.hz * s).setTranslation(p.x + ox * cs + oz * sn, p.y + (sh.oy ?? 0) * s, p.z - ox * sn + oz * cs).setRotation(rot));
    } else {
      for (const part of sh.parts) {
        const lx = part.x * s, lz = part.z * s;
        const wx = p.x + lx * cs + lz * sn, wz = p.z - lx * sn + lz * cs;
        if (part.kind === 'cyl') mk(RAPIER.ColliderDesc.cylinder((part.h * s) / 2, part.r * s).setTranslation(wx, p.y + (part.h * s) / 2, wz));
        else mk(RAPIER.ColliderDesc.cuboid(part.hx * s, part.hy * s, part.hz * s).setTranslation(wx, p.y + part.y * s, wz).setRotation(rot));
      }
    }
  }

  private unload(key: number): void {
    const ch = this.loaded.get(key);
    if (!ch) return;
    this.scene.remove(ch.mesh);
    ch.mesh.geometry.dispose();
    for (const c of ch.colliders) this.physics.removeCollider(c);
    this.loaded.delete(key);
    this.lodMaskData[ch.cz * CHUNKS_X + ch.cx] = 0;
    this.lodMask.needsUpdate = true;
    this.propsDirty = true;
    this.onChunkUnloaded?.(key);
  }

  isLoaded(x: number, z: number): boolean {
    const [cx, cz] = chunkCoord(x, z);
    return this.loaded.has(chunkKey(cx, cz));
  }
  get loadedKeys(): IterableIterator<number> {
    return this.loaded.keys();
  }

  /** Synchronously load everything around a point (loading screen / teleport). */
  loadAround(x: number, z: number): void {
    this.focus.set(x, 0, z);
    this.updateStreaming(true);
  }

  private updateStreaming(sync: boolean): void {
    const [fcx, fcz] = chunkCoord(this.focus.x, this.focus.z);
    if (fcx !== this.focusChunk[0] || fcz !== this.focusChunk[1] || sync) {
      this.focusChunk = [fcx, fcz];
      const want = new Set<number>();
      const r = this.radius;
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          const cx = fcx + dx, cz = fcz + dz;
          if (cx < 0 || cz < 0 || cx >= CHUNKS_X || cz >= CHUNKS_Z) continue;
          want.add(chunkKey(cx, cz));
        }
      for (const k of Array.from(this.loaded.keys())) {
        const ch = this.loaded.get(k)!;
        if (Math.max(Math.abs(ch.cx - fcx), Math.abs(ch.cz - fcz)) > r + 1) this.unload(k);
      }
      this.queue = Array.from(want).filter((k) => !this.loaded.has(k));
      // nearest first (sort by squared chunk distance)
      this.queue.sort((a, b) => {
        const ax = (a % 64) - fcx, az = Math.floor(a / 64) - fcz, bx = (b % 64) - fcx, bz = Math.floor(b / 64) - fcz;
        return ax * ax + az * az - (bx * bx + bz * bz);
      });
      this.propsDirty = true;
    }
    if (sync) {
      while (this.queue.length) this.load(this.queue.shift()!);
    } else if (this.queue.length) {
      // time-sliced: one chunk per frame keeps hitches small
      this.load(this.queue.shift()!);
    }
  }

  update(dt: number, focus: THREE.Vector3, night: number): void {
    this.focus.copy(focus);
    this.trafficTime += dt;
    this.updateStreaming(false);
    if (this.propsDirty) this.rebuildProps();
    this.updateLamps();
    const glowOn = night > 0.05;
    this.glowMesh.visible = glowOn;
    this.poolMesh.visible = glowOn;
    this.glowMat.opacity = night * 0.9;
    this.poolMat.opacity = night * 0.55;
    const d = districtAt(focus.x, focus.z);
    if (d !== this.district) {
      this.district = d;
      this.onDistrict?.(d, districtName(d));
    }
  }

  groundY(x: number, z: number): number {
    return this.terrain.sample(x, z);
  }

  get chunkCount(): number {
    return this.loaded.size;
  }
  /** Is a point within the playable region and not deep water? */
  isWater(x: number, z: number): boolean {
    return this.terrain.sample(x, z) < WATER_Y - 1;
  }
}

function radialTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.4, 'rgba(255,255,255,0.45)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
