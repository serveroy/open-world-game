import * as THREE from 'three';
import type { Game, System } from '../game/Game';
import { WantedSystem } from './Wanted';
import type { Ped } from '../peds/Ped';
import type { Vehicle } from '../vehicles/Vehicle';
import { policeAppearance } from '../characters/Appearance';
import { driveToward } from '../vehicles/AIDriver';
import { makeTrafficState } from '../vehicles/TrafficAI';
import { Rng, rand } from '../core/rng';
import { angleDiff, clamp, headingOf } from '../core/math';
import { GROUPS } from '../physics/groups';
import type { Blip } from '../ui/Minimap';
import { landmark } from '../world/MapData';
import { WATER_Y } from '../world/constants';
import type { GameEvents } from '../game/events';
import { perimeterPoint, perimeterProject } from '../peds/PedManager';

type UnitKind = 'foot' | 'cruiser' | 'swat' | 'heli' | 'roadblock' | 'patrol';

interface Unit {
  kind: UnitKind;
  vehicle: Vehicle | null;
  extra: Vehicle[];
  cops: Ped[];
  /** Cops still inside the vehicle (spawned on exit). */
  crew: number;
  state: 'pursue' | 'exit' | 'onfoot' | 'leave' | 'block';
  t: number;
  route: [number, number][];
  routeT: number;
  routeI: number;
  stuck: number;
  reverseT: number;
  side: number;
  life: number;
  los?: boolean;
  losT?: number;
}

interface Spike {
  x: number;
  y: number;
  z: number;
  yaw: number;
  mesh: THREE.Mesh;
  t: number;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

const BUDGET: Record<number, { foot: number; cruiser: number; swat: number; heli: number; roadblock: boolean; accuracy: number }> = {
  0: { foot: 0, cruiser: 0, swat: 0, heli: 0, roadblock: false, accuracy: 0 },
  1: { foot: 2, cruiser: 1, swat: 0, heli: 0, roadblock: false, accuracy: 0.25 },
  2: { foot: 2, cruiser: 2, swat: 0, heli: 0, roadblock: false, accuracy: 0.35 },
  3: { foot: 3, cruiser: 3, swat: 0, heli: 0, roadblock: true, accuracy: 0.45 },
  4: { foot: 3, cruiser: 3, swat: 1, heli: 1, roadblock: true, accuracy: 0.55 },
  5: { foot: 4, cruiser: 4, swat: 2, heli: 1, roadblock: true, accuracy: 0.65 },
};

export class PoliceManager implements System {
  name = 'police';
  readonly wanted = new WantedSystem();
  readonly units: Unit[] = [];
  private spikes: Spike[] = [];
  private spikeGeo: THREE.BufferGeometry;
  private spikeMat: THREE.Material;
  private dispatchT = 0;
  private roadblockT = 20;
  copSees = false;
  private bustT = 0;
  private rng = new Rng(777);
  readonly spot: THREE.SpotLight;
  private beam: THREE.Mesh;
  private patrolT = 5;
  enabled = true;
  /** Player is somewhere police won't follow on foot (water). */
  private lastCrimeSeen = 0;

  constructor(private game: Game) {
    this.spikeGeo = (() => {
      const g = new THREE.BoxGeometry(4.5, 0.06, 0.45);
      return g;
    })();
    this.spikeMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, metalness: 0.7, roughness: 0.4 });
    this.spot = new THREE.SpotLight(0xe8f0ff, 0, 140, 0.22, 0.4, 0.6);
    this.spot.castShadow = false;
    game.scene.add(this.spot, this.spot.target);
    const cone = new THREE.ConeGeometry(6, 40, 16, 1, true);
    cone.translate(0, -20, 0);
    this.beam = new THREE.Mesh(cone, new THREE.MeshBasicMaterial({ color: 0xd8e8ff, transparent: true, opacity: 0.08, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.beam.visible = false;
    game.scene.add(this.beam);
    this.wanted.onChange = (s, prev) => {
      game.events.emit('wantedChanged', { stars: s, prev });
      if (s > prev) game.haptic([20, 30, 20]);
      if (s === 0 && prev > 0) game.hud.toast('You lost the cops', 2000);
    };
    game.events.on('crime', (e) => this.onCrime(e));
    // police vehicles parked at HQ (stealable)
    const hq = landmark('police_hq');
    const vm = game.vehicles;
    if (vm) {
      vm.fixedSpawns.push({ def: 'interceptor', x: hq.bx - 20, z: hq.bz + hq.hz + 7, yaw: Math.PI / 2, live: null, respawnAt: 0, role: 'static', paint: 0x101418 });
      vm.fixedSpawns.push({ def: 'interceptor', x: hq.bx - 8, z: hq.bz + hq.hz + 7, yaw: Math.PI / 2, live: null, respawnAt: 0, role: 'static', paint: 0x101418 });
      vm.fixedSpawns.push({ def: 'enforcer', x: hq.bx + 10, z: hq.bz + hq.hz + 7, yaw: Math.PI / 2, live: null, respawnAt: 0, role: 'static', paint: 0x1c2026 });
    }
  }

  private onCrime(e: GameEvents['crime']): void {
    if (!this.enabled) return;
    const byCop = e.byCop || this.copCanSee(e.x, 1.2, e.z, 55);
    if (byCop) this.lastCrimeSeen = this.game.time;
    this.wanted.crime(e.type, e.witnessed, byCop, e.x, e.z);
  }

  /** Does any police unit see a point? */
  copCanSee(x: number, y: number, z: number, range = 60): boolean {
    const ph = this.game.physics;
    for (const u of this.units) {
      for (const c of u.cops) {
        if (!c.alive) continue;
        const d = Math.hypot(c.pos.x - x, c.pos.z - z);
        if (d > range) continue;
        if (Math.abs(angleDiff(c.yaw, headingOf(x - c.pos.x, z - c.pos.z))) > 1.2 && d > 8) continue;
        if (ph.lineOfSight(c.pos.x, c.pos.y + 1.6, c.pos.z, x, y, z, true)) return true;
      }
      const v = u.vehicle;
      if (v && !v.destroyed && (u.kind === 'cruiser' || u.kind === 'swat' || u.kind === 'patrol' || u.kind === 'roadblock') && v.driver) {
        const d = Math.hypot(v.position.x - x, v.position.z - z);
        if (d < range && ph.lineOfSight(v.position.x, v.position.y + 1.5, v.position.z, x, y, z, false)) return true;
      }
      if (u.kind === 'heli' && v && !v.destroyed) {
        const d = Math.hypot(v.position.x - x, v.position.z - z);
        if (d < 130 && ph.lineOfSight(v.position.x, v.position.y - 2, v.position.z, x, y + 0.5, z, false)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  private spawnCop(x: number, y: number, z: number, swat: boolean): Ped | null {
    const peds = this.game.peds;
    if (!peds) return null;
    const p = peds.spawn(policeAppearance(this.rng, swat), x, y, z, 'scripted', swat ? 'swat' : 'cop');
    if (!p) return null;
    p.weapon = swat ? 'rifle' : this.wanted.stars >= 3 && rand.chance(0.5) ? 'smg' : 'pistol';
    p.held = swat ? 'rifle' : p.weapon === 'smg' ? 'smg' : 'pistol';
    p.health = p.maxHealth = swat ? 150 : 100;
    p.armor = swat ? 80 : 20;
    p.persistent = true;
    p.ai.cover = null;
    p.ai.shootT = 1 + rand.next();
    p.ai.flank = rand.chance(0.5) ? 1 : -1;
    return p;
  }

  private roadSpawn(minD: number, maxD: number, behind: boolean): { x: number; z: number; yaw: number; edge: number; dir: 1 | -1 } | null {
    const w = this.game.world;
    if (!w) return null;
    const p = this.game.player.pos;
    const g = w.data.graph;
    const pv = this.playerVel(_v2);
    const sp = Math.hypot(pv.x, pv.z);
    for (let i = 0; i < 30; i++) {
      const e = g.edges[Math.floor(rand.next() * g.edges.length)]!;
      const dir: 1 | -1 = rand.chance(0.5) ? 1 : -1;
      const lp = w.data.lanePoint(e.id, 0.3 + rand.next() * 0.4, dir);
      const d = Math.hypot(lp.x - p.x, lp.z - p.z);
      if (d < minD || d > maxD || !w.isLoaded(lp.x, lp.z)) continue;
      if (behind && sp > 4 && ((lp.x - p.x) * pv.x + (lp.z - p.z) * pv.z) / (d * sp) > 0.3) continue;
      // face roughly toward the player
      const toward = headingOf(p.x - lp.x, p.z - lp.z);
      const yaw = Math.abs(angleDiff(lp.yaw, toward)) < Math.PI / 2 ? lp.yaw : lp.yaw + Math.PI;
      return { x: lp.x, z: lp.z, yaw, edge: e.id, dir };
    }
    return null;
  }

  private playerVel(out: THREE.Vector3): THREE.Vector3 {
    const v = this.game.vctrl?.vehicle;
    if (v) {
      const l = v.body.linvel();
      return out.set(l.x, 0, l.z);
    }
    return out.copy(this.game.player.vel).setY(0);
  }

  private spawnCruiser(kind: 'cruiser' | 'swat' | 'patrol'): void {
    const vm = this.game.vehicles;
    if (!vm) return;
    const s = this.roadSpawn(kind === 'patrol' ? 80 : 100, kind === 'patrol' ? 200 : 180, kind !== 'patrol');
    if (!s) return;
    if (vm.nearestVehicle(s.x, s.z, 8)) return;
    const v = vm.spawn(kind === 'swat' ? 'enforcer' : 'interceptor', s.x, s.z, s.yaw, { role: 'police', paint: kind === 'swat' ? 0x1c2026 : 0x101418 });
    v.persistent = true;
    v.engineOn = true;
    v.lights = true;
    v.siren = kind !== 'patrol';
    const drv = this.spawnCop(s.x, v.position.y, s.z, kind === 'swat');
    if (drv) {
      drv.state = 'driving';
      drv.vehicle = v;
      drv.setCollision(false);
      v.driver = { kind: 'ped', ref: drv };
    } else v.driver = { kind: 'ped', ref: null };
    const unit: Unit = { kind, vehicle: v, extra: [], cops: drv ? [drv] : [], crew: kind === 'swat' ? 3 : 1, state: 'pursue', t: 0, route: [], routeT: 0, routeI: 0, stuck: 0, reverseT: 0, side: rand.chance(0.5) ? 1 : -1, life: 0 };
    if (kind === 'patrol') {
      v.ai = makeTrafficState(this.game.world!.data.graph, s.edge, s.dir);
      v.role = 'traffic';
      v.siren = false;
    }
    this.units.push(unit);
  }

  private spawnFoot(): void {
    const peds = this.game.peds;
    if (!peds) return;
    const p = this.game.player.pos;
    for (let i = 0; i < 10; i++) {
      const a = rand.next() * Math.PI * 2, d = 35 + rand.next() * 30;
      const x = p.x + Math.cos(a) * d, z = p.z + Math.sin(a) * d;
      const b = peds.blockAt(x, z, 10);
      if (!b) continue;
      // stand on the sidewalk loop (never inside a building)
      const pt = { x: 0, z: 0, dx: 0, dz: 0 };
      perimeterPoint(b, perimeterProject(b, x, z), pt);
      if (Math.hypot(pt.x - p.x, pt.z - p.z) < 25) continue;
      const y = b.y;
      const c = this.spawnCop(pt.x, y, pt.z, false);
      if (c) this.units.push({ kind: 'foot', vehicle: null, extra: [], cops: [c], crew: 0, state: 'onfoot', t: 0, route: [], routeT: 0, routeI: 0, stuck: 0, reverseT: 0, side: 1, life: 0 });
      return;
    }
  }

  private spawnHeli(): void {
    const vm = this.game.vehicles;
    if (!vm) return;
    const p = this.game.player.pos;
    const a = rand.next() * Math.PI * 2;
    const x = p.x + Math.cos(a) * 160, z = p.z + Math.sin(a) * 160;
    const v = vm.spawn('kestrel', x, z, headingOf(p.x - x, p.z - z), { y: Math.max(p.y, 0) + 55, role: 'police', paint: 0x1a2a4a });
    v.persistent = true;
    v.engineOn = true;
    v.rotorSpeed = 1;
    v.driver = { kind: 'ped', ref: null };
    v.lights = true;
    this.units.push({ kind: 'heli', vehicle: v, extra: [], cops: [], crew: 0, state: 'pursue', t: 0, route: [], routeT: 0, routeI: 0, stuck: 0, reverseT: 0, side: 1, life: 0 });
  }

  private spawnRoadblock(): void {
    const w = this.game.world;
    const vm = this.game.vehicles;
    if (!w || !vm) return;
    const pv = this.playerVel(_v2);
    const sp = Math.hypot(pv.x, pv.z);
    if (sp < 8) return;
    const p = this.game.player.pos;
    const ahead = 130 + sp * 2;
    const ex = p.x + (pv.x / sp) * ahead, ez = p.z + (pv.z / sp) * ahead;
    const near = w.data.graph.nearestEdge(ex, ez, 60);
    if (!near || !w.isLoaded(ex, ez)) return;
    const e = near.edge;
    const a = w.data.graph.nodes[e.a]!;
    const cx = a.x + e.dx * e.length * near.t, cz = a.z + e.dz * e.length * near.t;
    const roadYaw = Math.atan2(e.dx, e.dz);
    const across = roadYaw + Math.PI / 2;
    const y = e.kind === 'city' ? 0.05 : w.groundY(cx, cz) + 0.1;
    const unit: Unit = { kind: 'roadblock', vehicle: null, extra: [], cops: [], crew: 0, state: 'block', t: 0, route: [], routeT: 0, routeI: 0, stuck: 0, reverseT: 0, side: 1, life: 0 };
    const off = e.width * 0.26;
    for (const s of [-1, 1]) {
      const x = cx + Math.sin(across) * off * s, z = cz + Math.cos(across) * off * s;
      const v = vm.spawn('interceptor', x, z, across + (s > 0 ? 0.25 : -0.25), { role: 'police', y: y + 0.2, paint: 0x101418 });
      v.persistent = true;
      v.siren = true;
      v.lights = true;
      v.engineOn = false;
      v.handbrake = true;
      unit.extra.push(v);
      // cops take position behind their cruiser (away from the approaching player)
      const bx = x - (pv.x / sp) * -4.5, bz = z - (pv.z / sp) * -4.5;
      const c = this.spawnCop(bx, y, bz, false);
      if (c) {
        c.ai.hold = true;
        unit.cops.push(c);
      }
    }
    // spike strip toward the player
    const sx = cx - (pv.x / sp) * 14, sz = cz - (pv.z / sp) * 14;
    const mesh = new THREE.Mesh(this.spikeGeo, this.spikeMat);
    mesh.position.set(sx, y + 0.03, sz);
    mesh.rotation.y = across;
    mesh.scale.x = e.width / 4.5;
    this.game.scene.add(mesh);
    this.spikes.push({ x: sx, y, z: sz, yaw: across, mesh, t: 70 });
    this.units.push(unit);
  }

  // ---------------------------------------------------------------------------
  private dispatch(): void {
    const stars = this.wanted.stars;
    const b = BUDGET[stars]!;
    const count = (k: UnitKind): number => this.units.filter((u) => u.kind === k && u.state !== 'leave').length;
    const footCops = this.units.reduce((n, u) => n + u.cops.filter((c) => c.alive && c.state !== 'driving').length, 0);
    if (stars > 0) {
      const inVeh = this.game.vctrl?.inVehicle ?? false;
      if (count('cruiser') < b.cruiser + (inVeh ? 1 : 0)) this.spawnCruiser('cruiser');
      else if (count('swat') < b.swat) this.spawnCruiser('swat');
      else if (!inVeh && footCops < b.foot) this.spawnFoot();
      if (count('heli') < b.heli) this.spawnHeli();
      if (b.roadblock && inVeh && this.roadblockT <= 0 && count('roadblock') < 1) {
        this.roadblockT = 40;
        this.spawnRoadblock();
      }
    } else {
      // calm: a couple of patrol cruisers drive with traffic
      if (this.patrolT <= 0) {
        this.patrolT = 20;
        if (count('patrol') < 2) this.spawnCruiser('patrol');
      }
    }
  }

  fixedUpdate(dt: number): void {
    const g = this.game;
    if (!g.world) return;
    const player = g.player;
    const pp = player.pos;
    this.dispatchT -= dt;
    this.roadblockT -= dt;
    this.patrolT -= dt;
    if (this.dispatchT <= 0 && this.enabled) {
      this.dispatchT = 1.2;
      this.dispatch();
    }
    // vision
    const hidden = this.isHidden();
    this.copSees = this.wanted.stars > 0 && this.copCanSee(pp.x, pp.y + 1.2, pp.z, 70);
    this.wanted.update(dt, this.copSees, pp.x, pp.z, hidden);
    const stars = this.wanted.stars;
    const acc = BUDGET[stars]!.accuracy;
    // units
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i]!;
      u.t += dt;
      u.life += dt;
      if (stars === 0 && u.kind !== 'patrol' && u.state !== 'leave') {
        u.state = 'leave';
        u.t = 0;
      }
      this.stepUnit(u, dt, acc);
      if (this.unitDead(u)) {
        this.removeUnit(u);
        this.units.splice(i, 1);
      }
    }
    // spikes
    for (let i = this.spikes.length - 1; i >= 0; i--) {
      const s = this.spikes[i]!;
      s.t -= dt;
      for (const v of g.vehicles?.vehicles ?? []) {
        if (v.role === 'police' || !v.ctrl) continue;
        if (Math.hypot(v.position.x - s.x, v.position.z - s.z) > 8) continue;
        for (let w = 0; w < v.wheelPos.length; w++) {
          const wp = v.wheelPos[w]!;
          const dx = wp.x - s.x, dz = wp.z - s.z;
          const along = dx * Math.sin(s.yaw) + dz * Math.cos(s.yaw);
          const perp = dx * Math.cos(s.yaw) - dz * Math.sin(s.yaw);
          if (Math.abs(perp) < 0.5 && Math.abs(along) < s.mesh.scale.x * 2.3) {
            const physI = v.def.kind === 'bike' ? (w === 0 ? 0 : 2) : w;
            if (!v.tirePopped[physI]) {
              v.popTire(physI);
              if (v.def.kind === 'bike') v.popTire(physI + 1);
              g.vehicles?.effects.dust(wp.x, wp.y + 0.2, wp.z, 0x9a9a9a, 0.7);
              if (v.driver?.kind === 'player') g.hud.toast('Tyre blown!', 1200);
            }
          }
        }
      }
      if (s.t <= 0 || Math.hypot(s.x - pp.x, s.z - pp.z) > 300) {
        g.scene.remove(s.mesh);
        this.spikes.splice(i, 1);
      }
    }
    this.checkBusted(dt);
  }

  private isHidden(): boolean {
    // under a roof / inside a structure: ray straight up hits geometry
    const p = this.game.player.pos;
    const up = this.game.physics.raycast(p.x, p.y + 2, p.z, 0, 1, 0, 30, GROUPS.rayWorld);
    return !!up;
  }

  private unitDead(u: Unit): boolean {
    const p = this.game.player.pos;
    const alive = u.cops.some((c) => c.alive);
    const vOk = u.vehicle && !u.vehicle.destroyed;
    if (u.kind === 'roadblock') return u.t > 70 || (u.extra.every((v) => v.position.distanceTo(p) > 220) && u.t > 10);
    if (u.state === 'leave' && u.t > 25) return true;
    const ref = u.vehicle?.position ?? u.cops[0]?.pos;
    if (ref && ref.distanceTo(p) > 330) return true;
    if (u.kind === 'heli') return !vOk;
    return !alive && !vOk && u.crew <= 0;
  }

  private removeUnit(u: Unit): void {
    const peds = this.game.peds;
    const vm = this.game.vehicles;
    for (const c of u.cops) {
      c.persistent = false;
      if (c.alive && peds) peds.despawn(c);
      else if (c.alive === false) c.persistent = false;
    }
    const p = this.game.player.pos;
    for (const v of [u.vehicle, ...u.extra]) {
      if (!v || !vm) continue;
      if (v.driver?.kind === 'player') continue;
      v.persistent = false;
      v.siren = false;
      if (v.position.distanceTo(p) > 60 || u.state === 'leave') vm.despawn(v);
      else {
        v.role = 'parked';
        v.driver = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  private stepUnit(u: Unit, dt: number, acc: number): void {
    const g = this.game;
    const pp = g.player.pos;
    const v = u.vehicle;
    if (u.kind === 'patrol') {
      // patrol cruiser: traffic AI handles driving; becomes pursuit when wanted
      if (this.wanted.stars > 0 && v && !v.destroyed) {
        u.kind = 'cruiser';
        v.role = 'police';
        v.ai = null;
        v.siren = true;
      }
      return;
    }
    if (u.kind === 'heli') return this.stepHeli(u, dt, acc);
    if (u.kind === 'roadblock') {
      for (const c of u.cops) this.stepCop(c, u, dt, acc);
      return;
    }
    // vehicle phase
    if (v && (u.state === 'pursue' || u.state === 'leave')) {
      const drv = v.driver?.kind === 'ped' ? v.driver.ref : null;
      if (!drv || v.destroyed || (drv as Ped).alive === false) {
        // vehicle lost its driver
        if (u.state === 'pursue') u.state = 'onfoot';
      } else if (u.state === 'leave') {
        driveToward(v, v.position.x + Math.sin(v.yaw) * 30, v.position.z + Math.cos(v.yaw) * 30, 12);
        v.siren = false;
      } else this.pursue(u, v, dt);
    }
    for (const c of u.cops) if (c.state !== 'driving') this.stepCop(c, u, dt, acc);
    void pp;
  }

  private pursue(u: Unit, v: Vehicle, dt: number): void {
    const g = this.game;
    const pv = g.vctrl?.vehicle ?? null;
    const target = pv ? pv.position : g.player.pos;
    const d = v.position.distanceTo(target);
    // on-foot suspect nearby: stop and get out
    if (!pv && d < 28) {
      v.throttle = 0;
      v.brake = 1;
      v.steer = 0;
      if (Math.abs(v.speed) < 2) this.exitVehicle(u, v);
      return;
    }
    if (u.reverseT > 0) {
      u.reverseT -= dt;
      v.throttle = 0;
      v.brake = 0.8;
      v.steer = u.side;
      return;
    }
    let tx = target.x, tz = target.z;
    const w = g.world!;
    u.losT = (u.losT ?? 0) - dt;
    if (u.losT <= 0) {
      u.losT = 0.5;
      u.los = g.physics.lineOfSight(v.position.x, v.position.y + 1, v.position.z, target.x, target.y + 1, target.z, false);
    }
    if (d > 70 || !u.los || (!pv && d > 26)) {
      // follow the road network
      u.routeT -= dt;
      if (u.routeT <= 0 || u.route.length === 0) {
        u.routeT = 3;
        u.route = w.data.graph.route(v.position.x, v.position.z, target.x, target.z);
        u.routeI = 1;
      }
      while (u.routeI < u.route.length - 1 && Math.hypot(u.route[u.routeI]![0] - v.position.x, u.route[u.routeI]![1] - v.position.z) < 14) u.routeI++;
      const n = u.route[Math.min(u.routeI, u.route.length - 1)];
      if (n) {
        tx = n[0];
        tz = n[1];
      }
    } else if (pv) {
      // lead target; close in for a PIT on the rear quarter
      const lv = pv.body.linvel();
      const lead = Math.min(1.2, d / 25);
      tx += lv.x * lead;
      tz += lv.z * lead;
      if (d < 18 && this.wanted.stars >= 2) {
        const f = pv.forward(_v);
        const rx = -f.z * u.side, rz = f.x * u.side;
        tx = pv.position.x - f.x * 1.8 + rx * 1.1 + lv.x * 0.3;
        tz = pv.position.z - f.z * 1.8 + rz * 1.1 + lv.z * 0.3;
      }
    }
    const speedT = d > 70 || !u.los ? v.def.maxSpeed * (d > 70 ? 0.92 : 0.6) : Math.max(10, (pv ? Math.abs(pv.speed) : 6) + Math.min(14, d * 0.6));
    driveToward(v, tx, tz, speedT, { aggressive: true, reverseOk: true });
    // catch-up boost when far behind
    if (d > 90) v.throttle = Math.min(1, v.throttle * 1.2);
    // stuck → reverse
    if (Math.abs(v.speed) < 1 && v.throttle > 0.3) u.stuck += dt;
    else u.stuck = Math.max(0, u.stuck - dt);
    if (u.stuck > 2.5) {
      u.stuck = 0;
      u.reverseT = 1.4;
      u.side = -u.side;
    }
    // if the suspect is stopped in a car nearby, get out and arrest
    if (pv && d < 12 && Math.abs(pv.speed) < 1.5 && Math.abs(v.speed) < 3) this.exitVehicle(u, v);
  }

  private exitVehicle(u: Unit, v: Vehicle): void {
    u.state = 'onfoot';
    const drv = v.driver?.kind === 'ped' ? (v.driver.ref as Ped | null) : null;
    v.driver = null;
    v.throttle = 0;
    v.brake = 1;
    v.handbrake = true;
    v.role = 'parked';
    const swat = u.kind === 'swat';
    const doors = [v.info.door, v.info.door2];
    if (drv) {
      v.toWorld(doors[0]!, _v);
      drv.state = 'scripted';
      drv.vehicle = null;
      drv.pos.set(_v.x, v.position.y, _v.z);
      drv.prevPos.copy(drv.pos);
      drv.setCollision(true);
    }
    for (let i = 0; i < u.crew; i++) {
      v.toWorld(doors[(i + 1) % 2]!, _v);
      _v.z += (i >> 1) * 1.2;
      const c = this.spawnCop(_v.x, v.position.y, _v.z, swat);
      if (c) u.cops.push(c);
    }
    u.crew = 0;
  }

  /** Foot cop behaviour: arrest at low heat, take cover and shoot at higher heat. */
  private stepCop(c: Ped, u: Unit, dt: number, acc: number): void {
    const g = this.game;
    const peds = g.peds!;
    if (!c.alive || c.state === 'driving') return;
    if (c.state !== 'scripted') {
      // knocked down etc. — PedManager handles; resume when standing
      if (c.state === 'flee' || c.state === 'walk' || c.state === 'wander') c.setState('scripted');
      else return;
    }
    if (c.actionT > 0 && (c.anim.action === 'fall' || c.anim.action === 'getup')) return;
    c.prevPos.copy(c.pos);
    const p = g.player;
    const pp = p.pos;
    const d = Math.hypot(pp.x - c.pos.x, pp.z - c.pos.z);
    const stars = this.wanted.stars;
    if (u.state === 'leave' || stars === 0) {
      c.hostile = false;
      peds.moveToward(c, c.pos.x + Math.sin(c.yaw) * 10, c.pos.z + Math.cos(c.yaw) * 10, 1.4, dt);
      peds.settleGround(c, dt);
      c.sync();
      return;
    }
    c.hostile = stars >= 2 || (p.mode === 'vehicle' && stars >= 1 && d > 8);
    const los = g.physics.lineOfSight(c.pos.x, c.pos.y + 1.5, c.pos.z, pp.x, pp.y + 1.2, pp.z, true);
    const face = (): void => {
      c.yaw = headingOf(pp.x - c.pos.x, pp.z - c.pos.z);
    };
    const shoot = (): void => {
      c.ai.shootT = (c.ai.shootT as number) - dt;
      if ((c.ai.shootT as number) <= 0 && los && p.mode !== 'dead' && g.combat) {
        const w = (c.weapon ?? 'pistol') as 'pistol' | 'smg' | 'rifle';
        c.ai.shootT = (w === 'pistol' ? 0.9 : 0.28) + rand.next() * 0.7;
        const tgtY = p.mode === 'vehicle' ? (g.vctrl?.vehicle?.position.y ?? pp.y) + 1 : pp.y + 1.2;
        g.combat.npcShoot(c, pp.x, tgtY, pp.z, w, acc);
      }
    };
    if (c.ai.hold) {
      // roadblock: stay behind cover, shoot at approaching suspects
      face();
      c.vel.set(0, 0, 0);
      if (d < 60 && stars >= 2) shoot();
      peds.settleGround(c, dt);
      c.sync();
      return;
    }
    if (!c.hostile && p.mode === 'foot') {
      // arrest: run at the suspect
      if (d > 1.3) peds.moveToward(c, pp.x, pp.z, d > 6 ? 5.4 : 3.2, dt, true);
      else {
        c.vel.set(0, 0, 0);
        face();
      }
    } else if (p.mode === 'vehicle' && d < 6 && Math.abs(g.vctrl?.vehicle?.speed ?? 0) < 1.5) {
      // pull the suspect from a stopped car
      const pv = g.vctrl!.vehicle!;
      pv.toWorld(pv.info.door, _v);
      peds.moveToward(c, _v.x, _v.z, 4.5, dt, false);
    } else {
      // combat: hold a firing position 9–18 m away, prefer cover, flank sideways
      c.ai.coverT = ((c.ai.coverT as number | undefined) ?? 0) - dt;
      if (!c.ai.cover || (c.ai.coverT as number) <= 0 || d > 30) {
        c.ai.coverT = 5 + rand.next() * 4;
        c.ai.cover = this.pickPosition(c, (c.ai.flank as number) ?? 1);
      }
      const cp = c.ai.cover as { x: number; z: number } | null;
      if (cp && Math.hypot(cp.x - c.pos.x, cp.z - c.pos.z) > 0.8) peds.moveToward(c, cp.x, cp.z, 4.6, dt, true);
      else {
        c.vel.multiplyScalar(0.7);
        face();
      }
      if (d < 50) shoot();
      if (Math.hypot(c.vel.x, c.vel.z) < 1) face();
    }
    peds.settleGround(c, dt);
    c.sync();
  }

  /** Choose a firing position: ~12 m from the suspect, flanking, preferably near cover. */
  private pickPosition(c: Ped, flank: number): { x: number; z: number } {
    const g = this.game;
    const pp = g.player.pos;
    const base = headingOf(c.pos.x - pp.x, c.pos.z - pp.z);
    let best = { x: c.pos.x, z: c.pos.z }, bestScore = -Infinity;
    for (let i = 0; i < 6; i++) {
      const a = base + flank * (0.3 + rand.next() * 0.9) * (i % 2 ? 1 : 0.5);
      const r = 9 + rand.next() * 9;
      const x = pp.x + Math.sin(a) * r, z = pp.z + Math.cos(a) * r;
      const ground = g.physics.raycast(x, 3, z, 0, -1, 0, 6, GROUPS.rayWorld);
      if (!ground || ground.y < WATER_Y) continue;
      // reachable (no wall between cop and spot)
      if (!g.physics.lineOfSight(c.pos.x, c.pos.y + 1, c.pos.z, x, ground.y + 1, z, false)) continue;
      // cover: something waist-high between spot and player
      const cover = !g.physics.lineOfSight(x, ground.y + 0.8, z, pp.x, pp.y + 0.8, pp.z, true);
      const peek = g.physics.lineOfSight(x, ground.y + 1.6, z, pp.x, pp.y + 1.2, pp.z, true);
      const score = (cover ? 2 : 0) + (peek ? 1.5 : -1) - Math.abs(r - 13) * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }
    return best;
  }

  private stepHeli(u: Unit, dt: number, acc: number): void {
    const g = this.game;
    const v = u.vehicle;
    if (!v || v.destroyed) return;
    const pp = g.player.pos;
    const leave = u.state === 'leave';
    // circle above the suspect
    const ang = u.t * 0.25;
    const rad = 28;
    const tx = leave ? v.position.x + 200 : pp.x + Math.cos(ang) * rad;
    const tz = leave ? v.position.z : pp.z + Math.sin(ang) * rad;
    const ground = g.world ? Math.max(g.world.groundY(tx, tz), WATER_Y) : 0;
    const ty = Math.max(pp.y, ground) + (leave ? 80 : 36);
    const p = v.position;
    _v.set(tx - p.x, ty - p.y, tz - p.z);
    const dist = _v.length();
    const speed = Math.min(26, dist * 0.6);
    _v.normalize().multiplyScalar(speed);
    const lv = v.body.linvel();
    const k = Math.min(1, dt * 1.5);
    v.body.setLinvel({ x: lv.x + (_v.x - lv.x) * k, y: lv.y + (_v.y - lv.y) * k, z: lv.z + (_v.z - lv.z) * k }, true);
    // face the suspect, tilt with velocity
    const yaw = headingOf(pp.x - p.x, pp.z - p.z);
    const fwdSpeed = lv.x * Math.sin(yaw) + lv.z * Math.cos(yaw);
    const sideSpeed = lv.x * Math.cos(yaw) - lv.z * Math.sin(yaw);
    _q.setFromEuler(new THREE.Euler(clamp(fwdSpeed * 0.02, -0.3, 0.3), yaw, clamp(sideSpeed * 0.02, -0.3, 0.3), 'YXZ'));
    v.body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
    v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    v.rotorSpeed = 1;
    v.engineOn = true;
    // sniper fire at 4+ stars
    if (this.wanted.stars >= 4 && !leave) {
      u.routeT -= dt;
      if (u.routeT <= 0 && g.combat && g.physics.lineOfSight(p.x, p.y - 2, p.z, pp.x, pp.y + 1, pp.z, false)) {
        u.routeT = this.wanted.stars >= 5 ? 1.4 : 2.6;
        const shooter = u.cops[0];
        if (!shooter) {
          const c = this.spawnCop(p.x, p.y - 1.5, p.z, true);
          if (c) {
            c.state = 'driving';
            c.vehicle = v;
            c.setCollision(false);
            u.cops.push(c);
          }
        } else {
          shooter.pos.set(p.x, p.y - 1.6, p.z);
          g.combat.npcShoot(shooter, pp.x, pp.y + 1, pp.z, 'rifle', acc * 0.6);
        }
      }
    }
  }

  private checkBusted(dt: number): void {
    const g = this.game;
    const p = g.player;
    if (this.wanted.stars === 0 || g.respawn.active) {
      this.bustT = 0;
      return;
    }
    let close = false;
    for (const u of this.units) for (const c of u.cops) {
      if (!c.alive || c.state !== 'scripted') continue;
      const d = Math.hypot(c.pos.x - p.pos.x, c.pos.z - p.pos.z);
      if (p.mode === 'foot' && d < 1.7) close = true;
      if (p.mode === 'vehicle' && d < 3.2 && Math.abs(g.vctrl?.vehicle?.speed ?? 9) < 1) close = true;
    }
    const attacking = g.input.down('attack') && (g.combat?.arsenal.def.kind ?? 'melee') !== 'melee';
    if (close && !attacking && (p.mode !== 'foot' || Math.hypot(p.vel.x, p.vel.z) < 2.5)) this.bustT += dt;
    else this.bustT = Math.max(0, this.bustT - dt * 2);
    if (this.bustT > (p.mode === 'vehicle' ? 1.8 : 1.1)) {
      this.bustT = 0;
      g.respawn.busted();
      this.wanted.clear();
    }
  }

  // ---------------------------------------------------------------------------
  update(dt: number): void {
    const g = this.game;
    const w = this.wanted;
    g.hud.wanted(w.stars, w.flashing);
    // minimap
    const mm = g.minimap;
    if (mm) {
      mm.searchArea = w.searching && w.stars > 0 ? { x: w.lastSeen.x, z: w.lastSeen.z, r: w.searchRadius } : null;
      mm.flash = w.stars > 0 && !w.searching ? 'red' : 'none';
    }
    // helicopter spotlight
    const heli = this.units.find((u) => u.kind === 'heli' && u.vehicle && !u.vehicle.destroyed);
    const night = (g.env?.night ?? 0) > 0.3;
    if (heli?.vehicle && night) {
      const v = heli.vehicle;
      const pp = g.player.pos;
      this.spot.position.set(v.renderPos.x, v.renderPos.y - 1, v.renderPos.z);
      // track with a little lag when searching
      const tgt = w.searching ? _v2.set(w.lastSeen.x + Math.sin(heli.t) * 12, pp.y, w.lastSeen.z + Math.cos(heli.t * 0.8) * 12) : _v2.copy(pp);
      this.spot.target.position.lerp(tgt, Math.min(1, dt * 3));
      this.spot.intensity = 900;
      this.beam.visible = true;
      this.beam.position.copy(this.spot.position);
      _v.subVectors(this.spot.target.position, this.spot.position);
      const len = _v.length();
      this.beam.scale.set(len / 40, len / 40, len / 40);
      _q.setFromUnitVectors(new THREE.Vector3(0, -1, 0), _v.normalize());
      this.beam.quaternion.copy(_q);
    } else {
      this.spot.intensity = 0;
      this.beam.visible = false;
    }
  }

  /** Police blips for the minimap (cones while searching). */
  blips(out: Blip[]): void {
    const flash = Math.floor(performance.now() / 300) % 2 === 0;
    const col = flash ? '#ff4d4d' : '#4d8aff';
    const searching = this.wanted.searching;
    for (const u of this.units) {
      if (u.kind === 'patrol') {
        if (u.vehicle) out.push({ x: u.vehicle.position.x, z: u.vehicle.position.z, color: '#4d8aff', shape: 'square', size: 3.5 });
        continue;
      }
      for (const v of [u.vehicle, ...u.extra]) {
        if (!v || v.destroyed) continue;
        out.push({ x: v.position.x, z: v.position.z, color: col, shape: u.kind === 'heli' ? 'diamond' : 'square', size: 4.5, cone: searching ? { yaw: v.yaw, range: u.kind === 'heli' ? 60 : 45 } : undefined });
      }
      for (const c of u.cops) {
        if (!c.alive || c.state === 'driving') continue;
        out.push({ x: c.pos.x, z: c.pos.z, color: col, shape: 'dot', size: 3.2, cone: searching ? { yaw: c.yaw, range: 35 } : undefined });
      }
    }
  }

  /** Clear everything (respawn / mission reset). */
  reset(): void {
    for (const u of this.units) this.removeUnit(u);
    this.units.length = 0;
    for (const s of this.spikes) this.game.scene.remove(s.mesh);
    this.spikes.length = 0;
    this.wanted.minStars = 0;
    this.wanted.clear();
  }

  get recentlySeenCrime(): boolean {
    return this.game.time - this.lastCrimeSeen < 5;
  }
}
