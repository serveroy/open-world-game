import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { GROUPS } from '../physics/groups';
import type { Game, System } from '../game/Game';
import { Vehicle, type VehicleRole } from './Vehicle';
import { VEHICLES, vehicleDef, trafficPool, type VehicleDef } from './VehicleData';
import { wheelGeometry } from './VehicleMeshes';
import { makeTrafficState, stepTraffic, type TrafficState } from './TrafficAI';
import { Effects } from '../render/Particles';
import { SkidMarks } from '../render/SkidMarks';
import { Flares } from '../render/Flares';
import { litMaterial } from '../render/materials';
import { SpatialHash } from '../core/SpatialHash';
import { rand } from '../core/rng';
import { chunkCoord, chunkKey } from '../world/CityGen';
import { districtAt, landmark, MARINA_BASIN } from '../world/MapData';
import { WATER_Y } from '../world/constants';
import type { ContactForce } from '../physics/Physics';

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

interface Hashed {
  x: number;
  z: number;
  v: Vehicle;
}

export interface FixedSpawn {
  def: string;
  x: number;
  y?: number;
  z: number;
  yaw: number;
  paint?: number;
  live: Vehicle | null;
  respawnAt: number;
  role: VehicleRole;
}

/** Human-like obstacle for traffic braking & vehicle hit tests. */
export interface HumanObstacle {
  x: number;
  y: number;
  z: number;
  radius: number;
  ref: unknown;
}

export class VehicleManager implements System {
  name = 'vehicles';
  readonly vehicles: Vehicle[] = [];
  private hash = new SpatialHash<Hashed>(20);
  private hashItems: Hashed[] = [];
  readonly effects: Effects;
  readonly skids: SkidMarks;
  readonly flares: Flares;
  private wheels: THREE.InstancedMesh;
  private low: boolean;
  private shadows: boolean;
  private spawnTimer = 0;
  private parkedByChunk = new Map<number, Vehicle[]>();
  readonly fixedSpawns: FixedSpawn[] = [];
  readonly headlight: THREE.SpotLight;
  /** Providers of human obstacles (player on foot, peds). */
  humans: () => HumanObstacle[] = () => [];
  /** Called when a vehicle hits a human hard enough to matter. */
  onHitHuman: ((v: Vehicle, h: HumanObstacle, speed: number) => void) | null = null;
  onExplode: ((v: Vehicle) => void) | null = null;
  onImpact: ((v: Vehicle, intensity: number, other: unknown) => void) | null = null;
  trafficEnabled = true;
  maxTraffic: number;
  maxParked = 36;

  constructor(private game: Game) {
    const scene = game.scene;
    this.low = game.quality === 'low';
    this.shadows = game.renderer.preset.shadows && game.settings.data.shadows;
    this.maxTraffic = game.renderer.preset.maxTraffic;
    this.effects = new Effects(scene, game.renderer.preset.maxParticles);
    this.skids = new SkidMarks(scene, this.low ? 500 : 1200);
    this.flares = new Flares(scene, 600);
    this.wheels = new THREE.InstancedMesh(wheelGeometry(), litMaterial('wheels', { vertexColors: true, roughness: 0.7 }), 70 * 4);
    this.wheels.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wheels.frustumCulled = false;
    this.wheels.castShadow = this.shadows;
    this.wheels.count = 0;
    scene.add(this.wheels);
    this.headlight = new THREE.SpotLight(0xfff2d8, 0, 60, 0.5, 0.45, 1.2);
    this.headlight.castShadow = false;
    scene.add(this.headlight, this.headlight.target);
    game.physics.contactListeners.push((c) => this.onContact(c));
    this.setupFixedSpawns();
    const w = game.world;
    if (w) {
      w.onChunkLoaded = (k) => this.spawnParked(k);
      w.onChunkUnloaded = (k) => this.despawnParked(k);
    }
  }

  private setupFixedSpawns(): void {
    const add = (def: string, x: number, z: number, yaw: number, opts: Partial<FixedSpawn> = {}): void => {
      this.fixedSpawns.push({ def, x, z, yaw, live: null, respawnAt: 0, role: 'static', ...opts });
    };
    const mb = MARINA_BASIN;
    add('marlin', mb.x0 + 40, mb.z0 + 52, Math.PI / 2, { paint: 0xf4f4f4 });
    add('skiff', mb.x0 + 70, mb.z0 + 98, Math.PI / 2);
    add('marlin', mb.x0 + 55, mb.z0 + 143, -Math.PI / 2, { paint: 0x1a3a8a });
    add('skiff', mb.x0 + 85, mb.z0 + 188, -Math.PI / 2);
    add('skiff', -1125, -628, Math.PI / 2);
    add('skiff', -1105, 622, -Math.PI / 2);
    const hp = landmark('helipad');
    add('kestrel', hp.bx, hp.bz, 0, { y: hp.height + 0.16 + 0.3, paint: 0x2a3a5a });
    const hosp = landmark('hospital');
    add('medic', hosp.bx + 20, hosp.bz + hosp.hz + 6, Math.PI / 2);
    const lena = landmark('respray');
    add('meridian', lena.x - 9, lena.z + 6, Math.PI / 2, { paint: 0x8a2a3a });
    add('bruiser', 1120, 335, 0, { paint: 0xe0b030 });
    add('mule', 1300, 345, Math.PI / 2);
    add('wasp', -505, 215, 0);
    add('thunder', 640, -80, Math.PI / 2);
    add('stiletto', -610, 700, 0, { paint: 0xf0f0f0 });
  }

  /** Spawn a vehicle at a world position (y = ground if omitted). */
  spawn(id: string | VehicleDef, x: number, z: number, yaw: number, opts: { y?: number; paint?: number; role?: VehicleRole; locked?: boolean } = {}): Vehicle {
    const def = typeof id === 'string' ? vehicleDef(id) : id;
    let y = opts.y;
    if (y === undefined) {
      const g = this.game.world ? this.game.world.groundY(x, z) : 0;
      y = def.kind === 'boat' ? Math.max(WATER_Y + 0.1, g + 0.4) : Math.max(g, def.kind === 'heli' ? g : -50) + 0.25;
      // sit on sidewalks / slabs
      const hit = this.game.physics.raycast(x, (y ?? 0) + 3, z, 0, -1, 0, 8);
      if (hit && def.kind !== 'boat') y = hit.y + 0.15;
    }
    const paint = opts.paint ?? rand.pick(def.colors);
    const v = new Vehicle(def, this.game.physics, this.game.scene, x, y, z, yaw, paint, this.low, this.shadows);
    v.role = opts.role ?? 'traffic';
    v.locked = opts.locked ?? false;
    v.health.onExplode = () => this.explode(v);
    this.vehicles.push(v);
    return v;
  }

  despawn(v: Vehicle): void {
    const i = this.vehicles.indexOf(v);
    if (i < 0) return;
    this.vehicles.splice(i, 1);
    v.dispose(this.game.scene);
    for (const f of this.fixedSpawns) if (f.live === v) {
      f.live = null;
      f.respawnAt = this.game.time + 60;
    }
  }

  // -------------------------------------------------------------------------
  private spawnParked(key: number): void {
    const w = this.game.world;
    if (!w) return;
    const ch = w.data.chunks.get(key);
    if (!ch || ch.parking.length === 0) return;
    let parked = 0;
    for (const arr of this.parkedByChunk.values()) parked += arr.length;
    const list: Vehicle[] = [];
    const night = (this.game.env?.night ?? 0) > 0.5;
    for (const pi of ch.parking) {
      if (parked >= this.maxParked) break;
      if (rand.next() > 0.35) continue;
      const sp = w.data.parking[pi]!;
      if (this.nearestVehicle(sp.x, sp.z, 6)) continue;
      const pool = trafficPool(sp.district, night);
      const id = rand.weighted(pool.ids, pool.weights);
      const def = vehicleDef(id);
      if (def.cls === 'bus' || def.cls === 'ambulance') continue;
      const v = this.spawn(def, sp.x, sp.z, sp.yaw, { role: 'parked', locked: rand.chance(0.75) });
      list.push(v);
      parked++;
    }
    if (list.length) this.parkedByChunk.set(key, list);
  }

  private despawnParked(key: number): void {
    const list = this.parkedByChunk.get(key);
    if (!list) return;
    for (const v of list) if (v.role === 'parked' && !v.driver && !v.persistent) this.despawn(v);
    this.parkedByChunk.delete(key);
  }

  private trafficCount(): number {
    let n = 0;
    for (const v of this.vehicles) if (v.role === 'traffic') n++;
    return n;
  }

  private spawnTraffic(): void {
    const w = this.game.world;
    if (!w || !this.trafficEnabled) return;
    const p = this.game.focus;
    const g = w.data.graph;
    const cam = this.game.renderer.camera;
    cam.getWorldDirection(_v2);
    for (let tries = 0; tries < 12; tries++) {
      const e = g.edges[Math.floor(rand.next() * g.edges.length)]!;
      const a = g.nodes[e.a]!;
      const t = 0.2 + rand.next() * 0.6;
      const dir: 1 | -1 = rand.chance(0.5) ? 1 : -1;
      const lp = w.data.lanePoint(e.id, dir === 1 ? t : 1 - t, dir);
      const d = Math.hypot(lp.x - p.x, lp.z - p.z);
      if (d < 70 || d > 210) continue;
      if (!w.isLoaded(lp.x, lp.z)) continue;
      // avoid popping in right in front of the camera
      const dx = (lp.x - cam.position.x) / d, dz = (lp.z - cam.position.z) / d;
      if (d < 130 && dx * _v2.x + dz * _v2.z > 0.6) continue;
      if (this.nearestVehicle(lp.x, lp.z, 14)) continue;
      void a;
      const night = (this.game.env?.night ?? 0) > 0.5;
      const pool = trafficPool(districtAt(lp.x, lp.z), night);
      const id = rand.weighted(pool.ids, pool.weights);
      const def = vehicleDef(id);
      if (def.cls === 'bus' && e.width < 11.5) continue;
      const v = this.spawn(def, lp.x, lp.z, lp.yaw, { role: 'traffic' });
      const st = makeTrafficState(g, e.id, dir);
      v.ai = st;
      v.driver = { kind: 'ped', ref: null };
      v.engineOn = true;
      // start at cruising speed
      const f = v.forward(_v);
      const s = Math.min(e.speed * 0.7, 12);
      v.body.setLinvel({ x: f.x * s, y: 0, z: f.z * s }, true);
      this.onTrafficSpawned?.(v);
      return;
    }
  }
  onTrafficSpawned: ((v: Vehicle) => void) | null = null;
  onVehicleDespawn: ((v: Vehicle) => void) | null = null;

  nearestVehicle(x: number, z: number, r: number, filter?: (v: Vehicle) => boolean): Vehicle | null {
    let best: Vehicle | null = null, bd = r * r;
    for (const v of this.vehicles) {
      if (filter && !filter(v)) continue;
      const dx = v.position.x - x, dz = v.position.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  private obstacleAhead = (v: Vehicle, range: number): number => {
    const p = v.position;
    const f = v.forward(_v);
    let best = range;
    const test = (x: number, z: number, halfW: number): void => {
      const dx = x - p.x, dz = z - p.z;
      const along = dx * f.x + dz * f.z;
      if (along < 0 || along > best) return;
      const lat = Math.abs(dx * f.z - dz * f.x);
      if (lat < 1.6 + halfW) best = along;
    };
    this.hash.query(p.x + f.x * range * 0.5, p.z + f.z * range * 0.5, range * 0.6, (h) => {
      if (h.v === v) return;
      test(h.x, h.z, h.v.def.width * 0.4);
    });
    for (const h of this.humans()) test(h.x, h.z, 0.3);
    return best;
  };

  fixedUpdate(dt: number): void {
    // rebuild spatial hash
    this.hash.clear();
    if (this.hashItems.length < this.vehicles.length) for (let i = this.hashItems.length; i < this.vehicles.length; i++) this.hashItems.push({ x: 0, z: 0, v: this.vehicles[0]! });
    for (let i = 0; i < this.vehicles.length; i++) {
      const v = this.vehicles[i]!;
      const h = this.hashItems[i]!;
      h.x = v.position.x;
      h.z = v.position.z;
      h.v = v;
      this.hash.insert(h);
    }
    const w = this.game.world;
    const ctx = w ? { data: w.data, time: w.trafficTime, obstacleAhead: this.obstacleAhead } : null;
    const night = this.game.env ? this.game.env.night > 0.35 || this.game.env.rainAmount > 0.5 || this.game.env.sandAmount > 0.3 : false;
    const pv = this.game.vctrl?.vehicle ?? null;
    const pvel = pv ? pv.body.linvel() : null;
    for (const v of this.vehicles) {
      if (v.ai && ctx && v.role === 'traffic' && v.driver?.kind === 'ped' && !v.destroyed) {
        stepTraffic(v, v.ai as TrafficState, ctx, dt);
        // swerve away from the player's car when it is on a collision course
        if (pv && pvel && pv !== v) {
          const dx = pv.position.x - v.position.x, dz = pv.position.z - v.position.z;
          const d = Math.hypot(dx, dz);
          if (d < 22 && d > 0.1) {
            const lv = v.body.linvel();
            const rvx = pvel.x - lv.x, rvz = pvel.z - lv.z;
            const closing = -(rvx * dx + rvz * dz) / d;
            if (closing > 6 && d / closing < 1.6) {
              const f = v.forward(_v);
              const side = f.x * dz - f.z * dx; // >0: threat on our left
              v.steer = side > 0 ? 0.8 : -0.8;
              v.brake = Math.max(v.brake, 0.6);
              v.throttle = 0;
              if (v.hornT <= 0) v.hornT = 0.8;
            }
          }
        }
      }
      if (v.driver && v.driver.kind === 'ped') v.lights = night;
      v.fixedUpdate(dt);
    }
  }

  postStep(): void {
    for (const v of this.vehicles) v.captureTransform();
    // vehicle vs humans
    const humans = this.humans();
    if (humans.length && this.onHitHuman) {
      for (const v of this.vehicles) {
        const lv = v.body.linvel();
        const sp = Math.hypot(lv.x, lv.z);
        if (sp < 2.5) continue;
        const [hx, , hz] = v.info.half;
        _q.copy(v.curQuat).invert();
        for (const h of humans) {
          const dx = h.x - v.position.x, dz = h.z - v.position.z;
          if (dx * dx + dz * dz > (hz + 3) * (hz + 3)) continue;
          if (Math.abs(h.y - v.position.y - v.info.center[1]) > 2.5) continue;
          _v.set(dx, 0, dz).applyQuaternion(_q);
          if (Math.abs(_v.x) < hx + h.radius && Math.abs(_v.z) < hz + h.radius) {
            // only count if the vehicle moves toward the human
            if (lv.x * dx + lv.z * dz > 0 || Math.abs(_v.z) < hz * 0.8) this.onHitHuman(v, h, sp);
          }
        }
      }
    }
  }

  private onContact(c: ContactForce): void {
    for (const [own, other] of [[c.a, c.b], [c.b, c.a]] as const) {
      if (!own || own.kind !== 'vehicle') continue;
      const v = own.ref as Vehicle;
      const accel = c.force / v.def.mass;
      const dmg = v.health.impact(accel * (v.mods.armor ? 1 - v.mods.armor * 0.15 : 1));
      if (dmg > 0) {
        // dent toward the direction of travel (or toward the other vehicle)
        const lv = v.body.linvel();
        if (other && other.kind === 'vehicle') {
          const o = other.ref as Vehicle;
          _v.subVectors(o.position, v.position);
        } else if (Math.hypot(lv.x, lv.z) > 1) _v.set(lv.x, 0, lv.z);
        else _v.set(c.dirX, c.dirY, c.dirZ);
        _q.copy(v.curQuat).invert();
        _v.applyQuaternion(_q);
        v.dent(_v, dmg / v.def.health * 3);
        if (accel > 200) {
          _v.copy(v.position);
          for (let i = 0; i < 4; i++) this.effects.spark(_v.x, _v.y + 0.6, _v.z, 6);
        }
        if (v.ai && (v.ai as TrafficState).kind === 'traffic') {
          const st = v.ai as TrafficState;
          st.shock = 1.5 + rand.next() * 2;
          if (v.hornT <= 0) v.hornT = 1.2;
        }
        this.onImpact?.(v, Math.min(1, accel / 600), other?.ref);
      }
      if (other && other.kind === 'prop' && accel > 25 && this.game.world) {
        const idx = other.ref as number;
        const p = this.game.world.data.props[idx];
        if (p && this.game.world.propDef(p.type).breakable) {
          this.game.world.breakProp(idx);
          this.spawnDebris(p.x, p.y, p.z, p.type);
        }
      }
    }
  }

  private debris: { mesh: THREE.Mesh; body: RAPIER.RigidBody; t: number }[] = [];
  /** Knocked-over prop becomes a short-lived dynamic body. */
  private spawnDebris(x: number, y: number, z: number, type: string): void {
    const world = this.game.physics.world;
    const tall = type === 'streetlight' || type === 'trafficlight';
    const h = tall ? 6 : 1;
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y + h / 2, z).setLinearDamping(0.3).setAngularDamping(0.5));
    world.createCollider(RAPIER.ColliderDesc.cuboid(tall ? 0.12 : 0.3, h / 2, tall ? 0.12 : 0.3).setDensity(tall ? 60 : 200).setCollisionGroups(GROUPS.prop), body);
    body.applyImpulse({ x: (Math.random() - 0.5) * 80, y: 40, z: (Math.random() - 0.5) * 80 }, true);
    const geo = new THREE.BoxGeometry(tall ? 0.18 : 0.6, h, tall ? 0.18 : 0.6);
    const mesh = new THREE.Mesh(geo, litMaterial('debris', { color: tall ? 0x3a3c40 : 0x8a3030 }));
    mesh.castShadow = this.shadows;
    this.game.scene.add(mesh);
    this.debris.push({ mesh, body, t: 12 });
    if (this.debris.length > 12) this.removeDebris(0);
  }
  private removeDebris(i: number): void {
    const d = this.debris[i]!;
    this.game.scene.remove(d.mesh);
    d.mesh.geometry.dispose();
    this.game.physics.removeBody(d.body);
    this.debris.splice(i, 1);
  }

  explode(v: Vehicle): void {
    const p = v.position;
    this.effects.explosion(p.x, p.y + 0.8, p.z, v.def.kind === 'heli' ? 1.6 : 1.2);
    v.body.applyImpulse({ x: (Math.random() - 0.5) * v.def.mass * 2, y: v.def.mass * 7, z: (Math.random() - 0.5) * v.def.mass * 2 }, true);
    v.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * v.def.mass * 4, y: 0, z: (Math.random() - 0.5) * v.def.mass * 4 }, true);
    v.engineOn = false;
    v.lights = false;
    v.siren = false;
    v.u.uGlass.value = 1;
    this.blast(p.x, p.y, p.z, 9, v.def.mass * 9, v);
    this.game.cam.addShake(Math.max(0, 1.2 - this.game.focus.distanceTo(p) / 40));
    this.game.events.emit('explosion', { x: p.x, y: p.y, z: p.z, radius: 9, byPlayer: false });
    this.onExplode?.(v);
  }

  /** Radial impulse + damage to vehicles within radius. */
  blast(x: number, y: number, z: number, radius: number, impulse: number, except?: Vehicle): void {
    for (const o of this.vehicles) {
      if (o === except) continue;
      const d = o.position.distanceTo(_v.set(x, y, z));
      if (d > radius) continue;
      const k = 1 - d / radius;
      _v2.subVectors(o.position, _v).normalize();
      o.body.applyImpulse({ x: _v2.x * impulse * k, y: impulse * k * 0.6, z: _v2.z * impulse * k }, true);
      o.health.apply(o.def.health * 0.9 * k);
    }
  }

  update(dt: number, alpha: number): void {
    const game = this.game;
    const night = game.env?.night ?? 0;
    const focus = game.focus;
    // spawn / despawn
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0) {
      this.spawnTimer = 0.35;
      const tc = this.trafficCount();
      if (tc < this.maxTraffic) {
        this.spawnTraffic();
        if (tc < this.maxTraffic * 0.5) this.spawnTraffic();
      }
      for (const f of this.fixedSpawns) {
        const d = Math.hypot(f.x - focus.x, f.z - focus.z);
        if (!f.live && d < 260 && game.time >= f.respawnAt && game.world?.isLoaded(f.x, f.z)) {
          if (this.nearestVehicle(f.x, f.z, 4)) continue;
          f.live = this.spawn(f.def, f.x, f.z, f.yaw, { y: f.y, paint: f.paint, role: f.role });
        } else if (f.live && d > 420 && !f.live.driver && !f.live.persistent) {
          const lv = f.live;
          f.live = null;
          this.despawn(lv);
        }
      }
      for (let i = this.vehicles.length - 1; i >= 0; i--) {
        const v = this.vehicles[i]!;
        if (v.persistent || v.driver?.kind === 'player') continue;
        const d = Math.hypot(v.position.x - focus.x, v.position.z - focus.z);
        const isTraffic = v.role === 'traffic' || v.role === 'emergency';
        const far = isTraffic ? 270 : 500;
        const stuck = isTraffic && v.ai && (v.ai as TrafficState).stuck > 20 && d > 60;
        const sunk = v.submerged > 20;
        const wreckOld = v.destroyed && d > 90;
        if (d > far || stuck || sunk || wreckOld || v.position.y < -40) {
          this.onVehicleDespawn?.(v);
          this.despawn(v);
        }
      }
    }
    // visuals
    this.flares.begin();
    let wi = 0;
    const camPos = game.renderer.camera.position;
    let headlightV: Vehicle | null = null;
    for (const v of this.vehicles) {
      v.updateVisual(dt, alpha, night);
      const dCam = v.renderPos.distanceTo(camPos);
      // wheels
      if (v.ctrl && dCam < 260) {
        for (let i = 0; i < v.info.wheels.length; i++) {
          if (wi >= this.wheels.instanceMatrix.count) break;
          v.wheelMatrix(i, _m);
          this.wheels.setMatrixAt(wi++, _m);
        }
      }
      // skids & tyre smoke
      if (v.ctrl && dCam < 120) {
        for (let i = 0; i < v.info.wheels.length; i++) {
          const physI = v.def.kind === 'bike' ? (i === 0 ? 0 : 2) : i;
          const slip = v.wheelSlip[physI]!;
          const wp = v.wheelPos[i]!;
          if (v.wheelContact[physI] && slip > 0.55 && Math.abs(v.speed) > 1.5) {
            const last = v.lastSkid[i];
            if (last) this.skids.add(last.x, last.y, last.z, wp.x, wp.y, wp.z, v.def.wheelWidth * 1.1, (slip - 0.5) * 1.5);
            if (!last) v.lastSkid[i] = wp.clone();
            else last.copy(wp);
            if (rand.next() < (slip - 0.5) * 0.9) this.effects.tireSmoke(wp.x, wp.y + 0.2, wp.z, Math.min(1.4, slip));
          } else v.lastSkid[i] = null;
        }
      }
      // damage effects
      const st = v.health.state;
      if (dCam < 200) {
        const eng = v.toWorld(v.info.engine, _v);
        if (st === 'smoking' && rand.next() < 0.35) this.effects.engineSmoke(eng.x, eng.y + 0.2, eng.z, 1 - v.health.fraction / 0.35);
        if (st === 'burning') this.effects.fire(eng.x, eng.y + 0.1, eng.z, 1);
        if (st === 'wrecked' && rand.next() < 0.25) this.effects.fire(v.renderPos.x, v.renderPos.y + 0.8, v.renderPos.z, 0.7);
        if (v.def.kind === 'boat' && v.inWater && Math.abs(v.speed) > 4 && rand.next() < 0.5) {
          const bow = v.toWorld([0, 0.2, v.def.length * 0.35], _v);
          this.effects.splash(bow.x, WATER_Y + 0.1, bow.z, 0.4);
        }
        if (v.engineOn && v.ctrl && Math.abs(v.speed) < 3 && rand.next() < 0.06) {
          const ex = v.toWorld(v.info.exhaust, _v);
          this.effects.smoke.emit({ x: ex.x, y: ex.y, z: ex.z, vy: 0.3, life: 1, size0: 0.15, size1: 0.6, color0: 0xb0b0b0, alpha0: 0.2, alpha1: 0, drag: 1 });
        }
      }
      // flares (lights)
      if (dCam < 320) {
        const lightsOn = v.lights && !v.destroyed;
        if (lightsOn && night > 0.1) for (const h of v.info.headlights) {
          const hp = v.toWorld(h, _v);
          this.flares.add(hp.x, hp.y, hp.z, 1.3, 0xfff0d0, 0.8);
        }
        const braking = v.engineOn && v.brake > 0.1 && v.speed > 0.5;
        if ((lightsOn && night > 0.1) || braking) for (const t of v.info.taillights) {
          const tp = v.toWorld(t, _v);
          this.flares.add(tp.x, tp.y, tp.z, braking ? 0.9 : 0.55, 0xff2010, braking ? 0.9 : 0.5);
        }
        if (v.siren && !v.destroyed) {
          const top = v.toWorld([0, v.info.half[1] * 2 + v.info.center[1] - v.info.half[1] + 0.2, 0], _v);
          const ph = Math.floor(v.sirenT * 5) % 2;
          this.flares.add(top.x, top.y, top.z, 2.2, ph ? 0xff1010 : 0x1030ff, 1);
        }
      }
      if (v.driver?.kind === 'player' && v.lights && night > 0.3 && v.def.kind !== 'boat') headlightV = v;
    }
    for (let i = wi; i < this.wheels.count; i++) this.wheels.setMatrixAt(i, ZERO);
    this.wheels.count = wi;
    this.wheels.instanceMatrix.needsUpdate = true;
    this.flares.end();
    // player headlight
    if (headlightV && game.quality !== 'low') {
      const v = headlightV;
      const hp = v.toWorld([0, v.info.headlights[0]?.[1] ?? 0.8, v.def.length / 2 + 0.3], _v);
      this.headlight.position.copy(hp);
      v.toWorld([0, 0, v.def.length / 2 + 18], this.headlight.target.position);
      this.headlight.target.position.y -= 2.5;
      this.headlight.intensity = 40 * night;
    } else this.headlight.intensity = 0;
    // debris
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!;
      d.t -= dt;
      const p = d.body.translation(), r = d.body.rotation();
      d.mesh.position.set(p.x, p.y, p.z);
      d.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      if (d.t <= 0) this.removeDebris(i);
    }
    this.effects.update(dt);
  }

  /** Clear transient vehicles (e.g. on respawn). */
  clearTraffic(): void {
    for (let i = this.vehicles.length - 1; i >= 0; i--) {
      const v = this.vehicles[i]!;
      if (!v.persistent && v.driver?.kind !== 'player' && (v.role === 'traffic' || v.destroyed)) this.despawn(v);
    }
  }

  allDefs(): VehicleDef[] {
    return VEHICLES;
  }

  chunkOf(v: Vehicle): number {
    const [cx, cz] = chunkCoord(v.position.x, v.position.z);
    return chunkKey(cx, cz);
  }
}
