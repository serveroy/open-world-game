import { registerPed, unregisterPed } from '../ecs/world';
import * as THREE from 'three';
import type { Game, System } from '../game/Game';
import { Ped, type PedState, type PedArchetype } from './Ped';
import { randomAppearance, type Appearance } from '../characters/Appearance';
import { advancePhase, blendPose, computePose } from '../characters/Pose';
import { rand, Rng } from '../core/rng';
import { SpatialHash } from '../core/SpatialHash';
import { angleDiff, dampAngle, dampFactor, headingOf } from '../core/math';
import { GROUPS } from '../physics/groups';
import type { Block } from '../world/CityGen';
import { coastX, districtAt, LANDMARKS, type DistrictId } from '../world/MapData';
import type { Vehicle } from '../vehicles/Vehicle';
import type { CrimeType } from '../game/events';
import type { HumanObstacle } from '../vehicles/VehicleManager';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _e = new THREE.Euler();

interface Hashed {
  x: number;
  z: number;
  p: Ped;
}

const INSET = 1.7;
const DENSITY: Partial<Record<DistrictId, [number, number]>> = {
  downtown: [1, 0.45], midtown: [0.9, 0.4], velvet: [0.6, 1.2], rustvale: [0.6, 0.45], heights: [0.45, 0.15],
  docks: [0.3, 0.15], marina: [0.55, 0.35], beach: [0.7, 0.1], dustwater: [0.5, 0.25], desert: [0.03, 0.01], sea: [0, 0],
};

export function perimeterLength(b: Block): number {
  return 2 * (b.x1 - b.x0 - INSET * 2) + 2 * (b.z1 - b.z0 - INSET * 2);
}

/** Point on a block's sidewalk loop at arc-length s (clockwise from NW corner). */
export function perimeterPoint(b: Block, s: number, out: { x: number; z: number; dx: number; dz: number }): { x: number; z: number; dx: number; dz: number } {
  const x0 = b.x0 + INSET, x1 = b.x1 - INSET, z0 = b.z0 + INSET, z1 = b.z1 - INSET;
  const w = x1 - x0, d = z1 - z0;
  const P = 2 * (w + d);
  s = ((s % P) + P) % P;
  if (s < w) { out.x = x0 + s; out.z = z0; out.dx = 1; out.dz = 0; }
  else if (s < w + d) { out.x = x1; out.z = z0 + (s - w); out.dx = 0; out.dz = 1; }
  else if (s < 2 * w + d) { out.x = x1 - (s - w - d); out.z = z1; out.dx = -1; out.dz = 0; }
  else { out.x = x0; out.z = z1 - (s - 2 * w - d); out.dx = 0; out.dz = -1; }
  return out;
}

/** Arc length of the closest point on the loop to (x,z). */
export function perimeterProject(b: Block, x: number, z: number): number {
  const x0 = b.x0 + INSET, x1 = b.x1 - INSET, z0 = b.z0 + INSET, z1 = b.z1 - INSET;
  const w = x1 - x0, d = z1 - z0;
  const cx = Math.min(x1, Math.max(x0, x)), cz = Math.min(z1, Math.max(z0, z));
  const dn = Math.abs(cz - z0), ds = Math.abs(z1 - cz), dw = Math.abs(cx - x0), de = Math.abs(x1 - cx);
  const m = Math.min(dn, ds, dw, de);
  if (m === dn) return cx - x0;
  if (m === de) return w + (cz - z0);
  if (m === ds) return w + d + (x1 - cx);
  return 2 * w + d + (z1 - cz);
}

const _pp = { x: 0, z: 0, dx: 0, dz: 0 };

export class PedManager implements System {
  name = 'peds';
  readonly peds: Ped[] = [];
  private hash = new SpatialHash<Hashed>(12);
  private hashItems: Hashed[] = [];
  private spawnTimer = 0;
  maxPeds: number;
  enabled = true;
  private rng = new Rng(4242);
  /** Peds that called the police and finished their call this frame. */
  onReport: ((ped: Ped, crime: string, x: number, z: number) => void) | null = null;
  /** Ped melee attack on player hook (M5 wires damage). */
  onPedAttack: ((ped: Ped) => void) | null = null;
  onPedDied: ((ped: Ped, byPlayer: boolean) => void) | null = null;

  constructor(private game: Game) {
    this.maxPeds = game.renderer.preset.maxPeds;
    const vm = game.vehicles;
    if (vm) {
      vm.onTrafficSpawned = (v) => this.spawnDriver(v);
      vm.onVehicleDespawn = (v) => {
        for (const p of this.peds) if (p.vehicle === v && p.state === 'driving') this.despawn(p);
      };
      const prevHumans = vm.humans;
      vm.humans = () => this.humanObstacles(prevHumans());
      const prevHit = vm.onHitHuman;
      vm.onHitHuman = (v, h, speed) => {
        if (h.ref instanceof Ped) this.hitByVehicle(h.ref, v, speed);
        else prevHit?.(v, h, speed);
      };
    }
    game.events.on('explosion', (e) => this.alarm(e.x, e.z, 70, 'explosion'));
    game.events.on('shot', (e) => this.alarm(e.x, e.z, e.silenced ? 15 : 55, 'shot'));
  }

  private humanCache: HumanObstacle[] = [];
  private humanObstacles(base: HumanObstacle[]): HumanObstacle[] {
    const out = this.humanCache;
    out.length = 0;
    for (const b of base) out.push(b);
    for (const p of this.peds) {
      if (p.state === 'driving' || p.state === 'dead' || p.state === 'pulled' || p.state === 'enterCar') continue;
      out.push({ x: p.pos.x, y: p.pos.y + 0.9, z: p.pos.z, radius: 0.32, ref: p });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  spawn(app: Appearance, x: number, y: number, z: number, state: PedState = 'walk', archetype: PedArchetype = 'normal'): Ped | null {
    const slot = this.game.chars.alloc(app);
    if (slot < 0) return null;
    const p = new Ped(this.game.physics, slot, app, x, y, z);
    p.state = state;
    p.archetype = archetype;
    // body-language variety: some bystanders fold their arms, suits walk formally, late-night
    // Velvet Row has the odd stagger
    const night = this.game.env?.night ?? 0;
    const drunk = archetype === 'normal' && districtAt(x, z) === 'velvet' && night > 0.5 && this.rng.chance(0.15);
    this.game.chars.setStyle(slot, {
      gait: drunk ? 'drunk' : app.top === 'suit' ? 'formal' : 'normal',
      folded: archetype === 'normal' && !app.female && this.rng.chance(0.3),
    });
    p.cash = Math.floor(this.rng.range(5, 80));
    this.peds.push(p);
    registerPed(p);
    return p;
  }

  onPedDespawn: ((p: Ped) => void) | null = null;
  despawn(p: Ped): void {
    const i = this.peds.indexOf(p);
    if (i < 0) return;
    this.onPedDespawn?.(p);
    this.peds.splice(i, 1);
    unregisterPed(p);
    this.game.chars.free(p.slot);
    p.dispose();
    if (p.partner) p.partner.partner = null;
  }

  spawnDriver(v: Vehicle): void {
    if (this.game.chars.used >= this.game.chars.capacity - 4) return;
    const d = districtAt(v.position.x, v.position.z);
    const app = randomAppearance(this.rng, { nightlife: d === 'velvet', desert: d === 'desert' || d === 'dustwater' });
    if (v.def.cls === 'taxi') app.hat = 'cap';
    const p = this.spawn(app, v.position.x, v.position.y, v.position.z, 'driving', this.rng.chance(0.2) ? 'brave' : this.rng.chance(0.3) ? 'snitch' : 'normal');
    if (!p) return;
    p.vehicle = v;
    p.setCollision(false);
    v.driver = { kind: 'ped', ref: p };
  }

  private localDensity(): number {
    const f = this.game.focus;
    const night = (this.game.env?.night ?? 0) > 0.5;
    const d = districtAt(f.x, f.z);
    const dd = DENSITY[d] ?? [0.3, 0.1];
    const rain = this.game.env?.rainAmount ?? 0;
    return dd[night ? 1 : 0] * (1 - rain * 0.5);
  }

  private onFootCount(): number {
    let n = 0;
    for (const p of this.peds) if (p.state !== 'driving' && !p.persistent) n++;
    return n;
  }

  private trySpawn(): void {
    const w = this.game.world;
    if (!w) return;
    const f = this.game.focus;
    const cam = this.game.renderer.camera;
    cam.getWorldDirection(_v2);
    const night = (this.game.env?.night ?? 0) > 0.5;
    for (let tries = 0; tries < 14; tries++) {
      const ang = rand.next() * Math.PI * 2;
      const dist = 35 + rand.next() * 95;
      const x = f.x + Math.cos(ang) * dist, z = f.z + Math.sin(ang) * dist;
      if (!w.isLoaded(x, z)) continue;
      const d = districtAt(x, z);
      const dens = DENSITY[d]?.[night ? 1 : 0] ?? 0.2;
      if (rand.next() > dens) continue;
      // avoid popping in right in front of the camera
      const dx = (x - cam.position.x) / dist, dz = (z - cam.position.z) / dist;
      if (dist < 60 && dx * _v2.x + dz * _v2.z > 0.5) continue;
      const block = this.blockAt(x, z, 40);
      const app = randomAppearance(this.rng, { nightlife: d === 'velvet' && night, desert: d === 'desert' || d === 'dustwater' });
      const arche: PedArchetype = d === 'rustvale' && rand.chance(0.3) ? 'gang' : rand.chance(0.15) ? 'brave' : rand.chance(0.3) ? 'snitch' : 'normal';
      if (block) {
        const P = perimeterLength(block);
        const s = rand.next() * P;
        perimeterPoint(block, s, _pp);
        const p = this.spawn(app, _pp.x, block.y, _pp.z, 'walk', arche);
        if (!p) return;
        if (arche === 'gang' && rand.chance(0.45)) p.weapon = rand.chance(0.8) ? 'pistol' : 'smg';
        p.block = block.id;
        p.pathS = s;
        p.pathDir = rand.chance(0.5) ? 1 : -1;
        p.speed = 1.1 + rand.next() * 0.5;
        const r = rand.next();
        if (r < 0.14) {
          p.setState('idle');
          p.play(rand.chance(0.5) ? 'phone' : 'talk', 9999);
          p.stateT = -rand.next() * 15;
        } else if (r < 0.26) {
          // chatting pair
          const q = this.spawn(randomAppearance(this.rng), _pp.x + _pp.dz * 1.1, block.y, _pp.z - _pp.dx * 1.1, 'chat', 'normal');
          if (q) {
            p.setState('chat');
            p.partner = q;
            q.partner = p;
            q.block = block.id;
            q.pathS = s;
            p.stateT = q.stateT = -rand.next() * 20;
          }
        } else if (night && d === 'velvet' && r < 0.55) {
          p.setState('dance');
          p.stateT = -rand.next() * 30;
        }
        return;
      }
      // wander zones: beach, Dustwater, piers, gas stations
      const zone = this.wanderZone(x, z);
      if (zone) {
        const p = this.spawn(app, zone.x, this.game.world!.groundY(zone.x, zone.z), zone.z, 'wander', arche);
        if (!p) return;
        p.wanderCenter.set(zone.x, 0, zone.z);
        p.wanderR = zone.r;
        p.speed = 1.0 + rand.next() * 0.4;
        if (d === 'beach' && rand.chance(0.35)) {
          p.setState('sit');
          p.stateT = -rand.next() * 60;
        }
        return;
      }
    }
  }

  private wanderZone(x: number, z: number): { x: number; z: number; r: number } | null {
    const d = districtAt(x, z);
    if ((d === 'beach' || d === 'velvet') && x < -700 && z > -320 && z < 340) {
      const cx = coastX(z);
      return { x: cx + 30 + rand.next() * 40, z, r: 25 };
    }
    if (d === 'dustwater') return { x: 1130 + rand.next() * 160, z: 300 + rand.next() * 120, r: 30 };
    for (const l of LANDMARKS) {
      if ((l.kind === 'gas' || l.kind === 'diner' || l.kind === 'boatrental') && Math.hypot(l.x - x, l.z - z) < 80) return { x: l.x + (rand.next() - 0.5) * 16, z: l.z + 6 + rand.next() * 8, r: 12 };
    }
    return null;
  }

  blockAt(x: number, z: number, maxD = 4): Block | null {
    const w = this.game.world;
    if (!w) return null;
    let best: Block | null = null, bd = maxD;
    for (const b of w.data.blocks) {
      const dx = Math.max(b.x0 - x, 0, x - b.x1), dz = Math.max(b.z0 - z, 0, z - b.z1);
      const d = Math.hypot(dx, dz);
      if (d < bd || (d === 0 && bd > 0)) {
        bd = d;
        best = b;
        if (d === 0) break;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  /** Something scary happened: nearby peds flee / cower / call police. */
  alarm(x: number, z: number, radius: number, kind: 'shot' | 'explosion' | 'melee' | 'vehicle' | 'gunpoint'): void {
    for (const p of this.peds) {
      if (!p.alive || p.persistent || p.state === 'driving' || p.state === 'pulled' || p.archetype === 'cop' || p.archetype === 'swat') continue;
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d > radius) continue;
      p.threat.set(x, 0, z);
      if (p.state === 'fight' || p.state === 'chase') continue;
      if ((p.archetype === 'gang' || p.archetype === 'brave') && kind === 'melee' && d < 15) {
        this.provoke(p);
        continue;
      }
      if (p.screamCooldown <= 0 && d < radius * 0.7) {
        p.screamCooldown = 4 + rand.next() * 4;
        this.game.events.emit('noise', { x: p.pos.x, z: p.pos.z, radius: 20, kind: 'scream' });
      }
      if (kind === 'gunpoint' && d < 8) {
        p.setState(rand.chance(0.5) ? 'handsup' : 'cower');
        continue;
      }
      const r = rand.next();
      if (d < 12 && r < 0.25) p.setState('cower');
      else if (r < 0.4 && kind !== 'explosion') p.setState('hide');
      else p.setState('flee');
      if (p.partner) p.partner.partner = null;
      p.partner = null;
    }
  }

  provoke(p: Ped): void {
    if (!p.alive || p.archetype === 'cop') return;
    p.hostile = true;
    if (p.archetype === 'normal' && rand.chance(0.7)) p.setState('flee');
    else p.setState('fight');
  }

  /**
   * Crime witnessed? Peds with line of sight may call the police (after a delay).
   * Returns true if anyone saw it.
   */
  witness(type: CrimeType, x: number, z: number, radius = 45): boolean {
    let seen = false;
    const ph = this.game.physics;
    for (const p of this.peds) {
      if (!p.alive || p.state === 'driving' || p.archetype === 'cop' || p.archetype === 'swat' || p.hostile) continue;
      const d = Math.hypot(p.pos.x - x, p.pos.z - z);
      if (d > radius) continue;
      if (!ph.lineOfSight(p.pos.x, p.pos.y + 1.6, p.pos.z, x, 1.2 + (this.game.player.pos.y || 0), z)) continue;
      seen = true;
      const caller = p.archetype === 'snitch' || rand.chance(0.18);
      if (caller && !p.reportCrime && p.state !== 'call') {
        p.reportCrime = type;
        p.reportPos.set(x, 0, z);
        p.setState('call');
        p.play('phone', 9999);
      }
    }
    return seen;
  }

  damage(p: Ped, amount: number, byPlayer: boolean, fromX: number, fromZ: number): void {
    if (!p.alive) return;
    let dmg = amount;
    if (p.armor > 0) {
      const a = Math.min(p.armor, dmg * 0.7);
      p.armor -= a;
      dmg -= a;
    }
    p.health -= dmg;
    p.threat.set(fromX, 0, fromZ);
    if (p.health <= 0) {
      this.kill(p, byPlayer);
      return;
    }
    p.play('hurt', 0.35);
    if (p.state === 'call') {
      p.reportCrime = null;
      p.anim.action = 'none';
    }
    if (byPlayer) {
      if (p.archetype === 'gang' || p.archetype === 'brave' || p.archetype === 'cop' || p.archetype === 'swat') {
        p.hostile = true;
        if (p.archetype !== 'cop' && p.archetype !== 'swat') p.setState(p.health < 30 ? 'flee' : 'fight');
      } else p.setState('flee');
    }
  }

  kill(p: Ped, byPlayer: boolean): void {
    if (p.state === 'dead') return;
    p.health = 0;
    p.setState('dead');
    p.anim.action = 'none';
    p.play('fall', 9999);
    p.setCollision(true);
    p.deadTime = 0;
    p.reportCrime = null;
    if (p.partner) {
      p.partner.partner = null;
      p.partner = null;
    }
    this.onPedDied?.(p, byPlayer);
    this.game.events.emit('pedKilled', { ped: p, byPlayer, cop: p.archetype === 'cop' || p.archetype === 'swat', x: p.pos.x, z: p.pos.z, weapon: 'unknown' });
  }

  hitByVehicle(p: Ped, v: Vehicle, speed: number): void {
    if (!p.alive || p.state === 'driving' || p.actionT > 0 && p.anim.action === 'fall') return;
    const lv = v.body.linvel();
    p.vel.set(lv.x * 0.7 + (p.pos.x - v.position.x) * 1.5, 0, lv.z * 0.7 + (p.pos.z - v.position.z) * 1.5);
    const byPlayer = v.driver?.kind === 'player';
    this.damage(p, speed * (speed > 9 ? 9 : 5), byPlayer, v.position.x, v.position.z);
    if (p.alive) {
      p.setState('down');
      p.play('fall', 1.6);
    }
    if (byPlayer) {
      this.game.events.emit('crime', { type: 'hitAndRun', x: p.pos.x, z: p.pos.z, witnessed: this.witness('hitAndRun', p.pos.x, p.pos.z, 35), byCop: false });
    }
  }

  // ---------------------------------------------------------------------------
  fixedUpdate(dt: number): void {
    // spatial hash for separation
    this.hash.clear();
    while (this.hashItems.length < this.peds.length) this.hashItems.push({ x: 0, z: 0, p: this.peds[0]! });
    for (let i = 0; i < this.peds.length; i++) {
      const h = this.hashItems[i]!;
      const p = this.peds[i]!;
      h.x = p.pos.x;
      h.z = p.pos.z;
      h.p = p;
      this.hash.insert(h);
    }
    const player = this.game.player;
    for (const p of this.peds) {
      p.prevPos.copy(p.pos);
      p.stateT += dt;
      if (p.screamCooldown > 0) p.screamCooldown -= dt;
      if (p.attackCooldown > 0) p.attackCooldown -= dt;
      if (p.actionT > 0) {
        p.actionT -= dt;
        p.anim.actionT = 1 - Math.max(0, p.actionT) / p.actionDur;
        if (p.actionT <= 0 && p.anim.action !== 'fall') {
          p.anim.action = 'none';
          p.anim.actionT = 0;
        }
      }
      this.think(p, dt, player.pos);
    }
  }

  moveToward(p: Ped, tx: number, tz: number, speed: number, dt: number, avoidWalls = true): number {
    const dx = tx - p.pos.x, dz = tz - p.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) {
      p.vel.set(0, 0, 0);
      return d;
    }
    let hx = dx / d, hz = dz / d;
    if (avoidWalls) {
      p.wallTimer -= dt;
      if (p.wallTimer <= 0) {
        p.wallTimer = 0.25;
        const hit = this.game.physics.raycast(p.pos.x, p.pos.y + 0.9, p.pos.z, hx, 0, hz, 2.2, GROUPS.rayWorldVehicles, p.body);
        if (hit && hit.distance > 0.05 && Math.abs(hit.ny) < 0.7) {
          // turn along the wall
          const nx = hit.nx, nz = hit.nz;
          const tx2 = -nz, tz2 = nx;
          const s = tx2 * hx + tz2 * hz >= 0 ? 1 : -1;
          p.target.set(p.pos.x + tx2 * s * 4 + nx * 1.2, 0, p.pos.z + tz2 * s * 4 + nz * 1.2);
          p.ai.detour = 0.8;
        }
      }
      if ((p.ai.detour as number) > 0) {
        p.ai.detour = (p.ai.detour as number) - dt;
        const ddx = p.target.x - p.pos.x, ddz = p.target.z - p.pos.z;
        const dd = Math.hypot(ddx, ddz) || 1;
        hx = ddx / dd;
        hz = ddz / dd;
      }
    }
    // separation from neighbours
    let sx = 0, sz = 0;
    this.hash.query(p.pos.x, p.pos.z, 1.2, (h, d2) => {
      if (h.p === p || d2 < 1e-4 || h.p === p.partner) return;
      const k = (1.2 - Math.sqrt(d2)) / 1.2;
      sx += (p.pos.x - h.x) * k * 2;
      sz += (p.pos.z - h.z) * k * 2;
    });
    const pl = this.game.player;
    if (pl.mode === 'foot') {
      const pdx = p.pos.x - pl.pos.x, pdz = p.pos.z - pl.pos.z;
      const pd = Math.hypot(pdx, pdz);
      if (pd < 1.0 && pd > 0.01 && p.state !== 'fight') {
        sx += (pdx / pd) * 2;
        sz += (pdz / pd) * 2;
      }
    }
    hx += sx;
    hz += sz;
    const l = Math.hypot(hx, hz) || 1;
    hx /= l;
    hz /= l;
    const k = dampFactor(8, dt);
    p.vel.x += (hx * speed - p.vel.x) * k;
    p.vel.z += (hz * speed - p.vel.z) * k;
    p.pos.x += p.vel.x * dt;
    p.pos.z += p.vel.z * dt;
    p.yaw = dampAngle(p.yaw, headingOf(p.vel.x, p.vel.z), 10, dt);
    return d;
  }

  settleGround(p: Ped, dt: number): void {
    p.groundTimer -= dt;
    if (p.groundTimer <= 0) {
      p.groundTimer = 0.3 + rand.next() * 0.2;
      const hit = this.game.physics.raycast(p.pos.x, p.pos.y + 1.4, p.pos.z, 0, -1, 0, 6, GROUPS.rayWorld, p.body);
      p.groundY = hit ? hit.y : this.game.world ? this.game.world.groundY(p.pos.x, p.pos.z) : 0;
    }
    p.pos.y += (p.groundY - p.pos.y) * Math.min(1, dt * 12);
  }

  private think(p: Ped, dt: number, playerPos: THREE.Vector3): void {
    const w = this.game.world;
    const st = p.state;
    if (st === 'driving') {
      const v = p.vehicle;
      if (!v) return;
      p.pos.copy(v.position);
      return;
    }
    if (st === 'pulled' || st === 'scripted' || st === 'enterCar' || st === 'ragdoll') {
      p.sync();
      return;
    }
    if (st === 'dead') {
      p.deadTime += dt;
      // slide to a stop after knockback
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
      p.pos.x += p.vel.x * dt;
      p.pos.z += p.vel.z * dt;
      this.settleGround(p, dt);
      p.sync();
      return;
    }
    // fast vehicle coming at us on the sidewalk → dodge
    if (st !== 'down' && st !== 'dodge' && st !== 'fight' && this.game.vehicles) {
      const v = this.game.vehicles.nearestVehicle(p.pos.x, p.pos.z, 14);
      if (v && Math.abs(v.speed) > 7) {
        const lv = v.body.linvel();
        const dx = p.pos.x - v.position.x, dz = p.pos.z - v.position.z;
        const d = Math.hypot(dx, dz);
        const closing = (lv.x * dx + lv.z * dz) / (d || 1);
        const lat = Math.abs(lv.x * dz - lv.z * dx) / (Math.hypot(lv.x, lv.z) || 1);
        if (closing > 6 && lat < 2.5 && d / closing < 1.2) {
          const side = lv.x * dz - lv.z * dx > 0 ? 1 : -1;
          const sp = Math.hypot(lv.x, lv.z) || 1;
          p.target.set(p.pos.x - (lv.z / sp) * side * 4, 0, p.pos.z + (lv.x / sp) * side * 4);
          p.setState('dodge');
          p.ai.prev = st;
          if (p.partner) p.partner.partner = null;
          p.partner = null;
        }
      }
    }
    switch (p.state) {
      case 'walk': {
        if (!w || p.block < 0) {
          p.setState('wander');
          p.wanderCenter.copy(p.pos);
          p.wanderR = 10;
          break;
        }
        const b = w.data.blocks[p.block]!;
        p.pathS += p.pathDir * p.speed * dt;
        perimeterPoint(b, p.pathS, _pp);
        // corner → maybe cross the street
        const P = perimeterLength(b);
        const sMod = ((p.pathS % P) + P) % P;
        const corners = [0, b.x1 - b.x0 - INSET * 2, P / 2, P - (b.z1 - b.z0 - INSET * 2)];
        if (p.stateT > 4 && corners.some((c) => Math.abs(sMod - c) < p.speed * dt * 1.5) && rand.chance(0.25)) {
          const dirX = _pp.dx * p.pathDir, dirZ = _pp.dz * p.pathDir;
          const tx = _pp.x + dirX * 18, tz = _pp.z + dirZ * 18;
          const nb = this.blockAt(tx, tz, 6);
          if (nb && nb.id !== b.id) {
            p.target.set(tx, 0, tz);
            p.ai.nextBlock = nb.id;
            p.setState('cross');
            break;
          }
        }
        this.moveToward(p, _pp.x, _pp.z, p.speed * 1.3 + Math.hypot(_pp.x - p.pos.x, _pp.z - p.pos.z), dt, false);
        if (Math.hypot(p.vel.x, p.vel.z) > 0.2) p.yaw = dampAngle(p.yaw, headingOf(_pp.dx * p.pathDir, _pp.dz * p.pathDir), 8, dt);
        if (p.stateT > 25 && rand.chance(dt * 0.03)) {
          p.setState('idle');
          p.play(rand.chance(0.5) ? 'phone' : 'talk', 9999);
          p.stateT = -rand.next() * 6;
        }
        break;
      }
      case 'cross': {
        const d = this.moveToward(p, p.target.x, p.target.z, p.speed * 1.25, dt, false);
        if (d < 1 || p.stateT > 20) {
          const nb = w?.data.blocks[(p.ai.nextBlock as number) ?? -1];
          if (nb) {
            p.block = nb.id;
            p.pathS = perimeterProject(nb, p.pos.x, p.pos.z);
          }
          p.setState('walk');
        }
        break;
      }
      case 'idle':
      case 'chat':
      case 'sit':
      case 'dance': {
        p.vel.multiplyScalar(0.8);
        if (p.state === 'chat' && p.partner) p.yaw = dampAngle(p.yaw, headingOf(p.partner.pos.x - p.pos.x, p.partner.pos.z - p.pos.z), 5, dt);
        if (p.state === 'chat' && p.anim.action !== 'talk') p.play('talk', 9999);
        if (p.state === 'dance' && p.anim.action !== 'dance') p.play('dance', 9999);
        if (p.state === 'sit' && p.anim.action !== 'sit') p.play('sit', 9999);
        if (p.stateT > 22) {
          p.anim.action = 'none';
          p.actionT = 0;
          if (p.partner) {
            p.partner.partner = null;
            p.partner = null;
          }
          if (p.block >= 0) {
            const b = w?.data.blocks[p.block];
            if (b) p.pathS = perimeterProject(b, p.pos.x, p.pos.z);
            p.setState('walk');
          } else p.setState('wander');
        }
        break;
      }
      case 'wander': {
        if (p.stateT < 0) break;
        const arrive = this.moveToward(p, p.target.x, p.target.z, p.speed, dt);
        if (arrive < 0.8 || p.stateT > 12 || p.target.lengthSq() === 0) {
          const a = rand.next() * Math.PI * 2, r = rand.next() * p.wanderR;
          p.target.set(p.wanderCenter.x + Math.cos(a) * r, 0, p.wanderCenter.z + Math.sin(a) * r);
          p.stateT = rand.chance(0.4) ? -(2 + rand.next() * 6) : 0;
          if (p.stateT < 0) p.vel.set(0, 0, 0);
        }
        break;
      }
      case 'flee': {
        if (p.anim.action === 'phone') p.anim.action = 'none';
        const dx = p.pos.x - p.threat.x, dz = p.pos.z - p.threat.z;
        const d = Math.hypot(dx, dz) || 1;
        this.moveToward(p, p.pos.x + (dx / d) * 10, p.pos.z + (dz / d) * 10, 5.2, dt);
        if (p.stateT > 9 && d > 45) this.resumeRoutine(p);
        if (p.stateT > 22) this.resumeRoutine(p);
        break;
      }
      case 'hide': {
        if (p.stateT < 0.1) {
          // pick the closest wall within 12 m
          let best = 13;
          for (let k = 0; k < 6; k++) {
            const a = (k / 6) * Math.PI * 2;
            const hit = this.game.physics.raycast(p.pos.x, p.pos.y + 0.9, p.pos.z, Math.cos(a), 0, Math.sin(a), 12, GROUPS.rayWorld, p.body);
            if (hit && hit.distance < best) {
              best = hit.distance;
              p.target.set(hit.x + hit.nx * 0.6, 0, hit.z + hit.nz * 0.6);
            }
          }
          if (best > 12) {
            p.setState('flee');
            break;
          }
        }
        const d = this.moveToward(p, p.target.x, p.target.z, 4.8, dt, false);
        if (d < 0.6) {
          p.vel.set(0, 0, 0);
          if (p.anim.action !== 'cower') p.play('cower', 9999);
        }
        if (p.stateT > 14) {
          p.anim.action = 'none';
          this.resumeRoutine(p);
        }
        break;
      }
      case 'cower':
      case 'handsup': {
        p.vel.set(0, 0, 0);
        const act = p.state === 'cower' ? 'cower' : 'handsup';
        if (p.anim.action !== act) p.play(act, 9999);
        p.yaw = dampAngle(p.yaw, headingOf(p.threat.x - p.pos.x, p.threat.z - p.pos.z), 6, dt);
        if (p.stateT > 6) {
          p.anim.action = 'none';
          p.setState('flee');
        }
        break;
      }
      case 'call': {
        p.vel.multiplyScalar(0.8);
        if (p.anim.action !== 'phone') p.play('phone', 9999);
        p.yaw = dampAngle(p.yaw, headingOf(p.reportPos.x - p.pos.x, p.reportPos.z - p.pos.z), 4, dt);
        if (p.stateT > 5.5 && p.reportCrime) {
          this.onReport?.(p, p.reportCrime, p.reportPos.x, p.reportPos.z);
          this.game.events.emit('crime', { type: 'reported', x: p.reportPos.x, z: p.reportPos.z, witnessed: true, byCop: false });
          p.reportCrime = null;
          p.anim.action = 'none';
          p.setState('flee');
        }
        break;
      }
      case 'fight':
      case 'chase': {
        const pl = this.game.player;
        const committed = p.persistent && p.hostile;
        const d = Math.hypot(playerPos.x - p.pos.x, playerPos.z - p.pos.z);
        if (p.weapon && p.hostile) {
          // armed: hold a firing distance and strafe; CombatSystem handles the shooting
          const want = 11 + (p.id % 5);
          const dx = p.pos.x - playerPos.x, dz = p.pos.z - playerPos.z;
          const dd = Math.hypot(dx, dz) || 1;
          const side = p.id % 2 ? 1 : -1;
          const strafe = Math.sin(this.game.time * 0.7 + p.id) * 4 * side;
          const tx = playerPos.x + (dx / dd) * want + (-dz / dd) * strafe, tz = playerPos.z + (dz / dd) * want + (dx / dd) * strafe;
          if (Math.abs(d - want) > 2 || Math.abs(strafe) > 1) this.moveToward(p, tx, tz, d > 30 ? 5 : 2.6, dt, true);
          else p.vel.multiplyScalar(0.7);
          if (Math.hypot(p.vel.x, p.vel.z) < 1.2) p.yaw = dampAngle(p.yaw, headingOf(playerPos.x - p.pos.x, playerPos.z - p.pos.z), 8, dt);
          if (!committed && (d > 60 || p.stateT > 60)) {
            p.hostile = false;
            this.resumeRoutine(p);
          }
          break;
        }
        if (pl.mode === 'vehicle' || pl.mode === 'dead') {
          if (p.stateT > 3 && !committed) this.resumeRoutine(p);
          p.vel.multiplyScalar(0.9);
          break;
        }
        if (!committed && (d > 35 || p.stateT > 40)) {
          p.hostile = false;
          this.resumeRoutine(p);
          break;
        }
        if (d > 1.25) this.moveToward(p, playerPos.x, playerPos.z, p.state === 'chase' ? 5.5 : d > 6 ? 4.8 : 2.4, dt, false);
        else {
          p.vel.multiplyScalar(0.6);
          p.yaw = dampAngle(p.yaw, headingOf(playerPos.x - p.pos.x, playerPos.z - p.pos.z), 10, dt);
          if (p.state === 'chase') p.setState('fight');
          if (p.attackCooldown <= 0) {
            p.attackCooldown = 0.9 + rand.next() * 0.6;
            p.play(rand.chance(0.5) ? 'punch' : 'punch2', 0.45);
            this.onPedAttack?.(p);
          }
        }
        break;
      }
      case 'dodge': {
        const d = this.moveToward(p, p.target.x, p.target.z, 5.5, dt, false);
        if (d < 0.5 || p.stateT > 0.9) {
          const prev = p.ai.prev as PedState | undefined;
          if (prev === 'walk' && p.block >= 0) {
            const b = w?.data.blocks[p.block];
            if (b) p.pathS = perimeterProject(b, p.pos.x, p.pos.z);
            p.setState('walk');
          } else p.setState(rand.chance(0.5) ? 'flee' : 'wander');
          p.threat.copy(p.pos);
        }
        break;
      }
      case 'down': {
        p.vel.multiplyScalar(Math.max(0, 1 - dt * 3));
        p.pos.x += p.vel.x * dt;
        p.pos.z += p.vel.z * dt;
        if (p.stateT > 1.6 && p.anim.action === 'fall') p.play('getup', 0.8);
        if (p.stateT > 2.5) {
          p.anim.action = 'none';
          const after = p.ai.afterDown as string | undefined;
          p.ai.afterDown = undefined;
          if (after === 'call' && p.reportCrime) {
            p.setState('call');
            p.play('phone', 9999);
          } else if (after === 'chase') p.setState('chase');
          else if (after === 'fight' || (p.hostile && (p.archetype === 'brave' || p.archetype === 'gang'))) p.setState('fight');
          else p.setState('flee');
        }
        break;
      }
    }
    this.settleGround(p, dt);
    p.sync();
  }

  resumeRoutine(p: Ped): void {
    const b = this.blockAt(p.pos.x, p.pos.z, 8);
    p.anim.action = 'none';
    p.actionT = 0;
    if (b) {
      p.block = b.id;
      p.pathS = perimeterProject(b, p.pos.x, p.pos.z);
      p.speed = 1.2 + rand.next() * 0.4;
      p.setState('walk');
    } else {
      p.wanderCenter.copy(p.pos);
      p.wanderR = 15;
      p.setState('wander');
    }
  }

  update(dt: number, alpha: number): void {
    const g = this.game;
    const f = g.focus;
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.enabled) {
      this.spawnTimer = 0.25;
      const target = Math.round(this.maxPeds * Math.min(1.2, this.localDensity()));
      const have = this.onFootCount();
      const burst = have < target * 0.5 ? 4 : 1;
      for (let i = 0; i < burst && this.onFootCount() < target; i++) this.trySpawn();
      // despawn far / old
      for (let i = this.peds.length - 1; i >= 0; i--) {
        const p = this.peds[i]!;
        if (p.persistent || p.state === 'driving') continue;
        const d = Math.hypot(p.pos.x - f.x, p.pos.z - f.z);
        if (d > 170 || (p.state === 'dead' && (p.deadTime > 45 || d > 90)) || (d > 120 && this.onFootCount() > target + 4)) this.despawn(p);
      }
    }
    const cam = g.renderer.camera;
    for (const p of this.peds) {
      if (p.state === 'driving') {
        this.renderDriver(p, dt);
        continue;
      }
      if (p.state === 'pulled') continue; // rendered by TheftController
      p.renderPos.lerpVectors(p.prevPos, p.pos, alpha);
      const d = p.renderPos.distanceTo(cam.position);
      if (d > 140) {
        g.chars.hide(p.slot);
        continue;
      }
      const a = p.anim;
      a.speed = p.state === 'dead' ? 0 : Math.hypot(p.vel.x, p.vel.z);
      a.grounded = true;
      a.crouch = 0;
      a.aim = p.held !== 'none' && p.hostile ? (p.held === 'pistol' ? 'pistol' : p.held === 'bat' || p.held === 'knife' ? 'none' : 'rifle') : 'none';
      a.aimPitch = 0;
      advancePhase(a, dt);
      if (p.ragdoll) continue; // ragdoll system renders it
      // LOD: far peds update pose less precisely
      computePose(p.targetPose, a);
      blendPose(p.pose, p.targetPose, dampFactor(a.action !== 'none' ? 18 : 12, dt));
      g.chars.update(p.slot, p.renderPos.x, p.renderPos.y, p.renderPos.z, p.yaw, p.pose, p.held, a);
    }
  }

  private renderDriver(p: Ped, dt: number): void {
    const v = p.vehicle;
    if (!v) return;
    const g = this.game;
    const d = v.renderPos.distanceTo(g.renderer.camera.position);
    if (d > 90 || v.kind === 'bike' && false) {
      g.chars.hide(p.slot);
      return;
    }
    const seat = v.def.seats[0]!;
    _v.set(seat[0], seat[1] - 0.55, seat[2]).applyQuaternion(v.renderQuat).add(v.renderPos);
    _e.setFromQuaternion(v.renderQuat, 'YXZ');
    const a = p.anim;
    a.driving = true;
    a.bike = v.kind === 'bike';
    a.steer = v.steer;
    a.action = 'none';
    a.time += dt;
    computePose(p.targetPose, a);
    blendPose(p.pose, p.targetPose, dampFactor(10, dt));
    g.chars.update(p.slot, _v.x, _v.y, _v.z, _e.y, p.pose, 'none', a);
    a.driving = false;
    p.yaw = _e.y;
    p.renderPos.copy(_v);
  }

  /** Nearest living ped to a point (optionally filtered). */
  nearest(x: number, z: number, r: number, filter?: (p: Ped) => boolean): Ped | null {
    let best: Ped | null = null, bd = r * r;
    for (const p of this.peds) {
      if (!p.alive || (filter && !filter(p))) continue;
      const dx = p.pos.x - x, dz = p.pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Utility for cutscenes / missions: make a ped face something. */
  face(p: Ped, x: number, z: number): void {
    p.yaw = headingOf(x - p.pos.x, z - p.pos.z);
  }

  angleTo(p: Ped, x: number, z: number): number {
    return Math.abs(angleDiff(p.yaw, headingOf(x - p.pos.x, z - p.pos.z)));
  }
}
