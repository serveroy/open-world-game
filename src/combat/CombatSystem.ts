import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import type { Game, System } from '../game/Game';
import { Arsenal, WEAPONS, type WeaponDef, type WeaponId } from './Weapons';
import { Tracers, Decals, Casings } from './CombatFX';
import { RagdollSystem } from '../characters/Ragdoll';
import { Joint } from '../characters/CharacterRenderer';
import { GROUPS } from '../physics/groups';
import type { RayHit } from '../physics/Physics';
import { Ped } from '../peds/Ped';
import { Vehicle } from '../vehicles/Vehicle';
import { WeaponWheel } from '../ui/WeaponWheel';
import { Gyro } from '../input/Gyro';
import { rand } from '../core/rng';
import { angleDiff, clamp, headingOf } from '../core/math';
import { WATER_Y } from '../world/constants';

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _ndc = new THREE.Vector3();

interface Projectile {
  kind: 'grenade' | 'molotov';
  body: RAPIER.RigidBody;
  mesh: THREE.Mesh;
  fuse: number;
  lastV: number;
  byPlayer: boolean;
}

interface FireZone {
  x: number;
  y: number;
  z: number;
  r: number;
  t: number;
  byPlayer: boolean;
}

export type Shooter = { kind: 'player' } | { kind: 'ped'; ped: Ped };

/** Player & NPC weapons: shooting, melee, throwables, explosions, ragdolls, aim assist. */
export class CombatSystem implements System {
  name = 'combat';
  readonly arsenal = new Arsenal();
  readonly ragdolls: RagdollSystem;
  readonly tracers: Tracers;
  readonly decals: Decals;
  readonly casings: Casings;
  readonly wheel: WeaponWheel;
  readonly gyro: Gyro;
  private projectiles: Projectile[] = [];
  private fires: FireZone[] = [];
  target: Ped | Vehicle | null = null;
  private targetScreen = new THREE.Vector2();
  private meleeQueue: { t: number; def: WeaponDef; combo: number }[] = [];
  private combo = 0;
  private comboT = 0;
  private lastCrimeT = -10;
  private throwQueue: { t: number; id: WeaponId }[] = [];
  private grenadeMesh: THREE.BufferGeometry;
  private molotovMesh: THREE.BufferGeometry;
  private projMat: THREE.Material;
  /** Called when the player kills / hurts things (wanted, stats, missions). */
  onPlayerKill: ((p: Ped) => void) | null = null;
  shotsFired = 0;
  kills = 0;
  private playerRagdollT = 0;
  playerRagdollFatal = false;
  /** Locked aim scale (settings.aimAssist) */
  private assistCone = 0.42;

  constructor(private game: Game) {
    this.ragdolls = new RagdollSystem(game.physics, game.chars, game.quality === 'low' ? 3 : 6);
    this.tracers = new Tracers(game.scene);
    this.decals = new Decals(game.scene, game.quality === 'low' ? 60 : 160);
    this.casings = new Casings(game.scene);
    this.wheel = new WeaponWheel(game.hud.root);
    this.gyro = new Gyro(game.input, game.settings);
    this.grenadeMesh = new THREE.SphereGeometry(0.08, 8, 6);
    this.molotovMesh = new THREE.CylinderGeometry(0.04, 0.05, 0.22, 6);
    this.projMat = new THREE.MeshStandardMaterial({ color: 0x4a5a3a, roughness: 0.6 });
    const peds = game.peds;
    if (peds) {
      peds.onPedDied = (p, byPlayer) => this.onPedDeath(p, byPlayer);
    }
    game.vehicles && (game.vehicles.onExplode = (v) => this.explosionDamage(v.position.x, v.position.y + 0.5, v.position.z, 8, 160, v.driver?.kind === 'player' || v.meta.lastHitByPlayer === true, v));
  }

  // ---------------------------------------------------------------------------
  private canAct(): boolean {
    const p = this.game.player;
    if (this.game.controlsLocked || this.game.theft?.busy) return false;
    if (p.mode === 'foot') return !p.swimming;
    if (p.mode === 'vehicle') {
      const v = this.game.vctrl?.vehicle;
      return !!v && (v.kind === 'car' || v.kind === 'bike' || v.kind === 'boat') && this.arsenal.def.driveBy;
    }
    return false;
  }

  get aiming(): boolean {
    return this.game.controller.aiming;
  }

  fixedUpdate(dt: number): void {
    const g = this.game;
    const inp = g.input;
    const p = g.player;
    const reloaded = this.arsenal.tick(dt);
    if (reloaded) g.haptic(10);
    if (this.comboT > 0) this.comboT -= dt;
    else this.combo = 0;

    // weapon selection
    if (!g.controlsLocked) {
      if (inp.pressed('nextWeapon')) this.switchWeapon(this.arsenal.cycle(1));
      if (inp.pressed('prevWeapon')) this.switchWeapon(this.arsenal.cycle(-1));
      if (inp.pressed('wheel') && !this.wheel.open && (p.mode === 'foot' || p.mode === 'vehicle')) {
        this.wheel.show(this.arsenal);
        g.timeScale = 0.3;
      }
      if (this.wheel.open && inp.released('wheel')) {
        const id = this.wheel.hide();
        g.timeScale = 1;
        if (id) this.switchWeapon(id, true);
      }
      if (inp.pressed('reload') && this.arsenal.startReload()) p.playAction('reload', this.arsenal.def.reload);
    }
    if (this.wheel.open) return;

    // firing
    if (this.canAct()) {
      const d = this.arsenal.def;
      const want = d.auto ? inp.down('attack') : inp.pressed('attack');
      if (want && !(p.mode === 'vehicle' && d.kind !== 'gun')) {
        if (d.kind === 'melee') this.startMelee(d);
        else if (d.kind === 'thrown') {
          if (this.arsenal.fire() === 'fired') {
            p.playAction('throw', 0.6);
            this.throwQueue.push({ t: 0.28, id: d.id });
          }
        } else {
          const r = this.arsenal.fire();
          if (r === 'fired') this.playerShoot(d);
          else if (r === 'reloading' && this.arsenal.reloading > 0 && p.anim.action !== 'reload') p.playAction('reload', d.reload);
          else if (r === 'empty' && inp.pressed('attack')) g.hud.toast('Out of ammo', 900);
        }
      }
    }
    // delayed melee hits / throws
    for (let i = this.meleeQueue.length - 1; i >= 0; i--) {
      const m = this.meleeQueue[i]!;
      m.t -= dt;
      if (m.t <= 0) {
        this.meleeHit(m.def, m.combo);
        this.meleeQueue.splice(i, 1);
      }
    }
    for (let i = this.throwQueue.length - 1; i >= 0; i--) {
      const th = this.throwQueue[i]!;
      th.t -= dt;
      if (th.t <= 0) {
        this.throwProjectile(th.id);
        this.throwQueue.splice(i, 1);
      }
    }
    this.stepProjectiles(dt);
    this.stepFires(dt);
    // NPC gunfire for armed hostile peds
    this.stepArmedPeds(dt);
    // player ragdoll recovery
    if (p.mode === 'ragdoll') {
      this.playerRagdollT -= dt;
      if (this.playerRagdollT <= 0 && !this.playerRagdollFatal && !p.vitals.dead) this.endPlayerRagdoll();
    }
  }

  switchWeapon(id: WeaponId, fromWheel = false): void {
    if (this.arsenal.select(id) || fromWheel) {
      const d = this.arsenal.def;
      this.game.hud.toast(`${d.icon} ${d.name}`, 900);
    }
  }

  // ---------------------------------------------------------------------------
  /** Player aim ray: from camera through screen centre, or toward the locked target. */
  private aimPoint(out: THREE.Vector3, d: WeaponDef): THREE.Vector3 {
    const g = this.game;
    const cam = g.renderer.camera;
    if (this.target && g.settings.data.aimAssist !== 'off') return this.targetPoint(this.target, out);
    cam.getWorldDirection(_d);
    const hit = g.physics.raycast(cam.position.x, cam.position.y, cam.position.z, _d.x, _d.y, _d.z, d.range, GROUPS.rayBullets, g.player.body, (c) => c.parent() !== this.game.vctrl?.vehicle?.body);
    if (hit) return out.set(hit.x, hit.y, hit.z);
    return out.copy(cam.position).addScaledVector(_d, d.range);
  }

  private targetPoint(t: Ped | Vehicle, out: THREE.Vector3): THREE.Vector3 {
    if (t instanceof Ped) {
      const head = this.game.chars.jointWorld(t.slot, Joint.Chest);
      if (head.lengthSq() > 0 && t.state !== 'driving') return out.copy(head);
      return out.set(t.pos.x, t.pos.y + 1.25, t.pos.z);
    }
    return out.copy(t.position).add(_v.set(0, t.info.center[1], 0));
  }

  private muzzle(out: THREE.Vector3): THREE.Vector3 {
    const g = this.game;
    const p = g.player;
    if (p.mode === 'vehicle' && g.vctrl?.vehicle) {
      const v = g.vctrl.vehicle;
      const seat = v.def.seats[0]!;
      return v.toWorld([seat[0] + 0.45, seat[1] + 0.55, seat[2] + 0.2], out);
    }
    const m = g.chars.jointWorld(p.slot, Joint.Muzzle);
    if (m.lengthSq() > 0) return out.copy(m);
    return out.set(p.pos.x, p.pos.y + 1.4, p.pos.z);
  }

  private playerShoot(d: WeaponDef): void {
    const g = this.game;
    const p = g.player;
    this.shotsFired++;
    this.muzzle(_o);
    this.aimPoint(_t, d);
    // face the aim point when hip-firing on foot
    if (p.mode === 'foot') p.yaw = headingOf(_t.x - p.pos.x, _t.z - p.pos.z);
    const spread = (this.aiming ? d.aimSpread : d.spread) * (p.sprinting ? 2 : 1) * (p.mode === 'vehicle' ? 1.6 : 1);
    for (let i = 0; i < d.pellets; i++) {
      _d.subVectors(_t, _o).normalize();
      _d.x += (rand.next() - 0.5) * spread * 2;
      _d.y += (rand.next() - 0.5) * spread * 2;
      _d.z += (rand.next() - 0.5) * spread * 2;
      _d.normalize();
      this.fireRay(_o, _d, d, { kind: 'player' });
    }
    // effects
    g.vehicles?.effects.muzzle(_o.x, _o.y, _o.z, d.slot === 'shotgun' || d.slot === 'sniper');
    if (d.slot !== 'shotgun') this.casings.eject(_o.x, _o.y - 0.05, _o.z, -Math.cos(p.yaw), Math.sin(p.yaw), p.pos.y);
    g.cam.pitch = clamp(g.cam.pitch - d.recoil * (this.aiming ? 0.6 : 1), -0.55, 1.25);
    g.cam.yaw += (rand.next() - 0.5) * d.recoil * 0.5;
    g.cam.addShake(d.recoil * 1.5);
    g.haptic(d.slot === 'sniper' || d.slot === 'shotgun' ? 35 : 12);
    g.events.emit('shot', { x: _o.x, y: _o.y, z: _o.z, weapon: d.id, byPlayer: true });
    g.events.emit('noise', { x: _o.x, z: _o.z, radius: d.loud, kind: 'gunshot' });
    if (g.time - this.lastCrimeT > 3) {
      this.lastCrimeT = g.time;
      const witnessed = g.peds?.witness('shooting', _o.x, _o.z, 50) ?? false;
      g.events.emit('crime', { type: 'shooting', x: _o.x, z: _o.z, witnessed, byCop: false });
    }
  }

  /** Hitscan ray shared by player & NPCs. Returns the hit (if any). */
  fireRay(origin: THREE.Vector3, dir: THREE.Vector3, d: WeaponDef, shooter: Shooter, damageMul = 1): RayHit | null {
    const g = this.game;
    const ph = g.physics;
    const excludeBody = shooter.kind === 'player' ? g.player.body : shooter.ped.body;
    const ownVehicle = shooter.kind === 'player' ? g.vctrl?.vehicle?.body : shooter.ped.vehicle?.body;
    const hit = ph.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, d.range, GROUPS.rayBullets, excludeBody, (c) => !ownVehicle || c.parent() !== ownVehicle);
    // water surface
    let end: THREE.Vector3;
    if (dir.y < 0 && origin.y > WATER_Y) {
      const tw = (WATER_Y - origin.y) / dir.y;
      if (tw > 0 && (!hit || tw < hit.distance)) {
        end = _v.copy(origin).addScaledVector(dir, tw);
        this.tracers.add(origin.x, origin.y, origin.z, end.x, end.y, end.z);
        g.vehicles?.effects.impact(end.x, end.y, end.z, 0, 1, 0, 'water');
        return null;
      }
    }
    if (!hit) {
      end = _v.copy(origin).addScaledVector(dir, d.range);
      if (rand.chance(0.6)) this.tracers.add(origin.x, origin.y, origin.z, end.x, end.y, end.z);
      return null;
    }
    if (rand.chance(d.pellets > 1 ? 0.3 : 0.75)) this.tracers.add(origin.x, origin.y, origin.z, hit.x, hit.y, hit.z);
    const byPlayer = shooter.kind === 'player';
    const o = hit.owner;
    const fx = g.vehicles?.effects;
    const dmg = d.damage * damageMul;
    if (o?.kind === 'ped') {
      const ped = o.ref as Ped;
      const head = hit.y > ped.pos.y + 1.48;
      fx?.impact(hit.x, hit.y, hit.z, -dir.x, -dir.y, -dir.z, 'flesh');
      this.damagePed(ped, dmg * (head ? 2.6 : 1), byPlayer, origin, dir, head ? 2 : 1);
      if (byPlayer) g.hud.hit(!ped.alive);
    } else if (o?.kind === 'ragdoll') {
      fx?.impact(hit.x, hit.y, hit.z, -dir.x, -dir.y, -dir.z, 'flesh');
      const rd = this.ragdolls.list.find((r) => r.owner === o.ref && !r.frozen);
      rd?.impulse(o.part ?? 1, dir.x * 25, dir.y * 25 + 5, dir.z * 25);
    } else if (o?.kind === 'player') {
      fx?.impact(hit.x, hit.y, hit.z, -dir.x, -dir.y, -dir.z, 'flesh');
      this.damagePlayer(dmg, origin.x, origin.z);
    } else if (o?.kind === 'vehicle') {
      const v = o.ref as Vehicle;
      fx?.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, 'metal');
      this.damageVehicle(v, dmg * d.vehicleMul, hit, dir, byPlayer);
      if (byPlayer) g.hud.hit(false);
    } else {
      const desert = hit.x > 300;
      fx?.impact(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, desert && hit.ny > 0.6 ? 'dirt' : 'concrete');
      this.decals.add(hit.x, hit.y, hit.z, hit.nx, hit.ny, hit.nz, d.slot === 'shotgun' ? 0.07 : 0.1);
    }
    return hit;
  }

  damagePed(ped: Ped, dmg: number, byPlayer: boolean, from: THREE.Vector3, dir: THREE.Vector3, part = 1): void {
    const peds = this.game.peds;
    if (!peds || !ped.alive) return;
    if (ped.state === 'driving' && ped.vehicle) {
      // shot through the window
      peds.damage(ped, dmg, byPlayer, from.x, from.z);
      if (!ped.alive) {
        const v = ped.vehicle;
        v.driver = null;
        v.role = 'parked';
        v.ai = null;
      }
      return;
    }
    peds.damage(ped, dmg, byPlayer, from.x, from.z);
    if (!ped.alive) {
      const rd = this.ragdolls.of(ped.slot);
      rd?.impulse(part, dir.x * 30, 10 + dir.y * 30, dir.z * 30);
    } else if (byPlayer) {
      peds.alarm(ped.pos.x, ped.pos.z, 25, 'shot');
      if (ped.archetype !== 'gang' && ped.archetype !== 'cop' && ped.archetype !== 'swat') ped.setState('flee');
    }
  }

  private onPedDeath(p: Ped, byPlayer: boolean): void {
    // spawn ragdoll from the current pose
    _v.copy(p.vel);
    _v.y = 0.5;
    if (p.state === 'dead' && !p.vehicle) {
      const rd = this.ragdolls.spawn(p.slot, _v, p);
      p.ragdoll = rd;
      p.setCollision(false);
    }
    if (byPlayer) {
      this.kills++;
      this.onPlayerKill?.(p);
      const cop = p.archetype === 'cop' || p.archetype === 'swat';
      const witnessed = this.game.peds?.witness(cop ? 'copMurder' : 'murder', p.pos.x, p.pos.z, 50) ?? false;
      this.game.events.emit('crime', { type: cop ? 'copMurder' : 'murder', x: p.pos.x, z: p.pos.z, witnessed, byCop: false });
      // drop cash pickup
      if (p.cash > 0) this.game.events.emit('pickup', { kind: 'dropcash', amount: p.cash });
    }
  }

  damageVehicle(v: Vehicle, dmg: number, hit: RayHit, dir: THREE.Vector3, byPlayer: boolean): void {
    v.health.apply(dmg);
    if (byPlayer) v.meta.lastHitByPlayer = true;
    // local hit point
    _v.set(hit.x, hit.y, hit.z).sub(v.position);
    _q.copy(v.curQuat).invert();
    _v.applyQuaternion(_q);
    // tyres
    for (let i = 0; i < v.info.physWheels.length; i++) {
      const w = v.info.physWheels[i]!;
      if (Math.abs(_v.x - w[0]) < 0.45 && Math.abs(_v.z - w[2]) < v.def.wheelRadius + 0.15 && _v.y < v.def.wheelRadius * 2 + 0.1) {
        v.popTire(i);
        this.game.vehicles?.effects.dust(hit.x, hit.y, hit.z, 0x9a9a9a, 0.6);
      }
    }
    // windows (upper half of the body)
    const top = v.info.center[1] + v.info.half[1];
    if (_v.y > top - v.info.half[1] * 0.75 && v.kind === 'car' && rand.chance(0.35)) v.u.uGlass.value = 1;
    // hitting the driver through the glass
    const drv = v.driver;
    if (drv?.kind === 'ped' && drv.ref instanceof Ped && _v.y > top - 0.9 && rand.chance(0.3)) {
      this.damagePed(drv.ref, dmg * 0.8, byPlayer, _o.copy(v.position), dir);
    }
    // traffic reacts
    if (v.ai && (v.ai as { kind?: string }).kind === 'traffic') (v.ai as { panic: number }).panic = 12;
    if (byPlayer && v.def.cls === 'police') {
      this.game.events.emit('crime', { type: 'copAssault', x: v.position.x, z: v.position.z, witnessed: true, byCop: true });
    }
  }

  damagePlayer(dmg: number, fromX: number, fromZ: number): void {
    const g = this.game;
    const p = g.player;
    if (p.vitals.invulnerable) return;
    if (p.mode === 'vehicle') {
      // occupants are partly shielded
      const v = g.vctrl?.vehicle;
      if (v && v.kind === 'car' && !v.def.armored) dmg *= 0.45;
      else if (v?.def.armored) dmg *= 0.1;
    }
    const lost = p.vitals.damage(dmg);
    g.hud.damageFlash(Math.min(1, 0.25 + dmg / 40));
    g.haptic(20);
    void lost;
    void fromX;
    void fromZ;
  }

  // ---------------------------------------------------------------------------
  private startMelee(d: WeaponDef): void {
    const p = this.game.player;
    if (this.arsenal.fire() !== 'fired' || p.mode !== 'foot') return;
    let anim: 'punch' | 'punch2' | 'kick' | 'swing' | 'stab' = 'punch';
    if (d.id === 'fists') {
      anim = this.combo === 0 ? 'punch' : this.combo === 1 ? 'punch2' : 'kick';
      this.combo = (this.combo + 1) % 3;
      this.comboT = 0.9;
    } else anim = d.id === 'bat' ? 'swing' : 'stab';
    const dur = d.id === 'bat' ? 0.65 : 0.42;
    p.playAction(anim, dur);
    // face lock-on target / camera
    if (this.target instanceof Ped) p.yaw = headingOf(this.target.pos.x - p.pos.x, this.target.pos.z - p.pos.z);
    else p.yaw = this.game.cam.yaw;
    this.meleeQueue.push({ t: dur * 0.45, def: d, combo: anim === 'kick' ? 2 : 1 });
  }

  private meleeHit(d: WeaponDef, power: number): void {
    const g = this.game;
    const p = g.player;
    const reach = d.reach ?? 1.4;
    const arc = d.arc ?? 1.2;
    let hitSomething = false;
    for (const ped of g.peds?.peds ?? []) {
      if (!ped.alive || ped.state === 'driving') continue;
      const dx = ped.pos.x - p.pos.x, dz = ped.pos.z - p.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > reach + 0.35 || Math.abs(ped.pos.y - p.pos.y) > 1.2) continue;
      if (Math.abs(angleDiff(p.yaw, headingOf(dx, dz))) > arc * 0.5) continue;
      hitSomething = true;
      const dmg = d.damage * (power === 2 ? 1.5 : 1);
      _d.set(dx, 0.2, dz).normalize();
      this.damagePed(ped, dmg, true, p.pos, _d);
      if (ped.alive) {
        ped.vel.set(_d.x * (d.id === 'bat' ? 6 : 3), 0, _d.z * (d.id === 'bat' ? 6 : 3));
        if (d.id === 'bat' || power === 2 || rand.chance(0.25)) {
          ped.setState('down');
          ped.play('fall', 1.4);
        }
        g.peds?.provoke(ped);
        if (ped.state !== 'down') ped.setState(ped.archetype === 'normal' ? 'flee' : 'fight');
      }
      g.vehicles?.effects.impact(ped.pos.x, ped.pos.y + 1.3, ped.pos.z, -_d.x, 0, -_d.z, 'flesh');
      g.hud.hit(!ped.alive);
      if (g.time - this.lastCrimeT > 2) {
        this.lastCrimeT = g.time;
        const cop = ped.archetype === 'cop' || ped.archetype === 'swat';
        const witnessed = g.peds?.witness(cop ? 'copAssault' : 'assault', ped.pos.x, ped.pos.z, 35) ?? false;
        g.events.emit('crime', { type: cop ? 'copAssault' : 'assault', x: ped.pos.x, z: ped.pos.z, witnessed: witnessed || cop, byCop: cop });
      }
      g.peds?.alarm(ped.pos.x, ped.pos.z, 18, 'melee');
    }
    // bat vs vehicles
    if (d.id === 'bat') {
      const v = g.vehicles?.nearestVehicle(p.pos.x + Math.sin(p.yaw) * 1.5, p.pos.z + Math.cos(p.yaw) * 1.5, 2.6);
      if (v) {
        hitSomething = true;
        v.health.apply(40);
        _v.set(p.pos.x - v.position.x, 0, p.pos.z - v.position.z).applyQuaternion(_q.copy(v.curQuat).invert());
        v.dent(_v, 0.3);
        if (rand.chance(0.4)) v.u.uGlass.value = 1;
        if (v.role === 'parked' && rand.chance(0.6)) v.alarm = 20;
      }
    }
    if (hitSomething) {
      g.cam.addShake(0.12);
      g.haptic(18);
    }
  }

  // ---------------------------------------------------------------------------
  private throwProjectile(id: WeaponId): void {
    const g = this.game;
    const p = g.player;
    const w = g.physics.world;
    const hand = g.chars.jointWorld(p.slot, Joint.RHand);
    const o = hand.lengthSq() > 0 ? _o.copy(hand) : _o.set(p.pos.x, p.pos.y + 1.6, p.pos.z);
    g.renderer.camera.getWorldDirection(_d);
    const pitchUp = this.aiming ? Math.max(0.1, _d.y + 0.35) : 0.38;
    const speed = this.aiming ? 17 : 12;
    const hx = Math.sin(p.yaw), hz = Math.cos(p.yaw);
    const fx = this.aiming ? _d.x : hx, fz = this.aiming ? _d.z : hz;
    const fl = Math.hypot(fx, fz) || 1;
    const body = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(o.x + hx * 0.4, o.y, o.z + hz * 0.4).setLinvel((fx / fl) * speed, pitchUp * speed, (fz / fl) * speed).setCcdEnabled(true).setAngularDamping(0.5));
    w.createCollider(RAPIER.ColliderDesc.ball(0.08).setDensity(800).setRestitution(id === 'grenade' ? 0.35 : 0).setFriction(0.8).setCollisionGroups(GROUPS.projectile), body);
    body.setAngvel({ x: rand.next() * 10, y: rand.next() * 10, z: rand.next() * 10 }, true);
    const mesh = new THREE.Mesh(id === 'grenade' ? this.grenadeMesh : this.molotovMesh, this.projMat);
    g.scene.add(mesh);
    this.projectiles.push({ kind: id === 'grenade' ? 'grenade' : 'molotov', body, mesh, fuse: id === 'grenade' ? 2.8 : 8, lastV: speed, byPlayer: true });
  }

  private stepProjectiles(dt: number): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const pr = this.projectiles[i]!;
      pr.fuse -= dt;
      const t = pr.body.translation(), r = pr.body.rotation();
      pr.mesh.position.set(t.x, t.y, t.z);
      pr.mesh.quaternion.set(r.x, r.y, r.z, r.w);
      const lv = pr.body.linvel();
      const sp = Math.hypot(lv.x, lv.y, lv.z);
      const impact = pr.lastV - sp > 3.5 || t.y < WATER_Y;
      pr.lastV = sp;
      if (pr.kind === 'molotov' && rand.chance(0.6)) this.game.vehicles?.effects.fire(t.x, t.y, t.z, 0.15);
      if ((pr.kind === 'molotov' && (impact || pr.fuse <= 0)) || (pr.kind === 'grenade' && pr.fuse <= 0)) {
        if (pr.kind === 'grenade') this.explosionDamage(t.x, t.y, t.z, 7, 180, pr.byPlayer);
        else this.igniteMolotov(t.x, t.y, t.z, pr.byPlayer);
        this.game.scene.remove(pr.mesh);
        this.game.physics.removeBody(pr.body);
        this.projectiles.splice(i, 1);
      }
    }
  }

  private igniteMolotov(x: number, y: number, z: number, byPlayer: boolean): void {
    const g = this.game;
    if (y < WATER_Y + 0.1) {
      g.vehicles?.effects.splash(x, WATER_Y, z, 1);
      return;
    }
    const gy = g.physics.groundY(x, z, y + 1.5);
    this.fires.push({ x, y: Number.isFinite(gy) ? gy : y, z, r: 3.6, t: 9, byPlayer });
    for (let i = 0; i < 20; i++) g.vehicles?.effects.fire(x + (rand.next() - 0.5) * 3, gy + 0.1, z + (rand.next() - 0.5) * 3, 0.8);
    g.events.emit('noise', { x, z, radius: 40, kind: 'explosion' });
    g.peds?.alarm(x, z, 40, 'explosion');
    if (byPlayer) g.events.emit('crime', { type: 'explosion', x, z, witnessed: g.peds?.witness('explosion', x, z, 50) ?? false, byCop: false });
  }

  private stepFires(dt: number): void {
    const g = this.game;
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i]!;
      f.t -= dt;
      if (rand.chance(0.7)) g.vehicles?.effects.fire(f.x + (rand.next() - 0.5) * f.r * 1.6, f.y + 0.05, f.z + (rand.next() - 0.5) * f.r * 1.6, 0.9);
      for (const ped of g.peds?.peds ?? []) {
        if (!ped.alive || ped.state === 'driving') continue;
        if (Math.hypot(ped.pos.x - f.x, ped.pos.z - f.z) < f.r) {
          g.peds!.damage(ped, 35 * dt, f.byPlayer, f.x, f.z);
          if (ped.alive && ped.state !== 'flee') ped.setState('flee');
          if (!ped.alive) this.ragdolls.of(ped.slot)?.impulse(1, 0, 3, 0);
        }
      }
      const p = g.player;
      if (p.mode === 'foot' && Math.hypot(p.pos.x - f.x, p.pos.z - f.z) < f.r && Math.abs(p.pos.y - f.y) < 1.5) this.damagePlayer(18 * dt, f.x, f.z);
      for (const v of g.vehicles?.vehicles ?? []) if (Math.hypot(v.position.x - f.x, v.position.z - f.z) < f.r + 1) v.health.apply(70 * dt);
      if (f.t <= 0) this.fires.splice(i, 1);
    }
  }

  /** Explosion: damage & impulses to everything nearby. */
  explosionDamage(x: number, y: number, z: number, radius: number, damage: number, byPlayer: boolean, source?: Vehicle): void {
    const g = this.game;
    if (!source) {
      g.vehicles?.effects.explosion(x, y, z, radius / 7);
      g.vehicles?.blast(x, y, z, radius * 1.2, 9000);
      g.events.emit('explosion', { x, y, z, radius, byPlayer });
      g.cam.addShake(Math.max(0, 1.4 - g.focus.distanceTo(_v.set(x, y, z)) / 35));
    }
    this.decals.add(x, (Number.isFinite(g.physics.groundY(x, z, y + 2)) ? g.physics.groundY(x, z, y + 2) : y) + 0.02, z, 0, 1, 0, 2.6);
    for (const ped of g.peds?.peds ?? []) {
      if (!ped.alive) continue;
      const d = Math.hypot(ped.pos.x - x, ped.pos.y - y, ped.pos.z - z);
      if (d > radius) continue;
      const k = 1 - d / radius;
      _d.set(ped.pos.x - x, 0.6, ped.pos.z - z).normalize();
      if (ped.state === 'driving' && ped.vehicle) continue;
      g.peds!.damage(ped, damage * k, byPlayer, x, z);
      const rd = this.ragdolls.of(ped.slot);
      if (rd) rd.impulse(1, _d.x * 60 * k, 40 * k + 10, _d.z * 60 * k);
      else if (ped.alive) {
        ped.vel.set(_d.x * 8 * k, 0, _d.z * 8 * k);
        ped.setState('down');
        ped.play('fall', 1.8);
      }
    }
    const p = g.player;
    const pd = Math.hypot(p.pos.x - x, p.pos.y + 1 - y, p.pos.z - z);
    if (pd < radius) {
      const k = 1 - pd / radius;
      this.damagePlayer(damage * 0.8 * k, x, z);
      if (p.mode === 'foot' && k > 0.35) this.ragdollPlayer(_d.set(p.pos.x - x, 0.8, p.pos.z - z).normalize().multiplyScalar(12 * k), 2.2);
    }
    if (byPlayer) g.events.emit('crime', { type: 'explosion', x, z, witnessed: g.peds?.witness('explosion', x, z, 60) ?? false, byCop: false });
  }

  // ---------------------------------------------------------------------------
  /** Knock the player into ragdoll (explosions, big car hits). */
  ragdollPlayer(vel: THREE.Vector3, seconds: number, fatal = false): void {
    const g = this.game;
    const p = g.player;
    if (p.mode === 'ragdoll' || p.mode === 'vehicle') return;
    _v.copy(p.vel).add(vel);
    this.ragdolls.spawn(p.slot, _v, p);
    p.mode = 'ragdoll';
    p.setCollisionEnabled(false);
    this.playerRagdollT = seconds;
    this.playerRagdollFatal = fatal;
  }

  endPlayerRagdoll(): void {
    const g = this.game;
    const p = g.player;
    const rd = this.ragdolls.of(p.slot);
    if (rd) {
      rd.position(_v);
      this.ragdolls.remove(p.slot);
      const gy = g.physics.groundY(_v.x, _v.z, _v.y + 1.5);
      p.teleport(_v.x, Number.isFinite(gy) ? gy + 0.05 : _v.y, _v.z, p.yaw);
    }
    p.mode = 'foot';
    p.setCollisionEnabled(true);
    p.playAction('getup', 0.8);
  }

  // ---------------------------------------------------------------------------
  /** NPC weapon fire (gang members, cops). */
  npcShoot(ped: Ped, tx: number, ty: number, tz: number, weapon: WeaponId, accuracy: number): void {
    const d = WEAPONS[weapon];
    const m = this.game.chars.jointWorld(ped.slot, Joint.Muzzle);
    if (m.lengthSq() > 0 && m.distanceTo(ped.pos) < 3) _o.copy(m);
    else _o.set(ped.pos.x, ped.pos.y + 1.4, ped.pos.z);
    for (let i = 0; i < d.pellets; i++) {
      _d.set(tx - _o.x, ty - _o.y, tz - _o.z).normalize();
      const s = d.spread * (2.2 - accuracy * 1.8);
      _d.x += (rand.next() - 0.5) * s * 2;
      _d.y += (rand.next() - 0.5) * s * 2;
      _d.z += (rand.next() - 0.5) * s * 2;
      _d.normalize();
      this.fireRay(_o, _d, d, { kind: 'ped', ped }, 0.55);
    }
    this.game.vehicles?.effects.muzzle(_o.x, _o.y, _o.z);
    this.game.events.emit('shot', { x: _o.x, y: _o.y, z: _o.z, weapon, byPlayer: false });
  }

  private stepArmedPeds(dt: number): void {
    const g = this.game;
    const p = g.player;
    if (p.mode === 'dead') return;
    for (const ped of g.peds?.peds ?? []) {
      if (!ped.alive || !ped.hostile || !ped.weapon || ped.archetype === 'cop' || ped.archetype === 'swat') continue;
      const driving = ped.state === 'driving' && !!ped.vehicle;
      if (ped.state !== 'fight' && ped.state !== 'chase' && !driving) continue;
      if (!driving) ped.held = WEAPONS[ped.weapon as WeaponId]?.held ?? 'pistol';
      if (driving) ped.pos.copy(ped.vehicle!.position).y += 1;
      const d = ped.pos.distanceTo(p.pos);
      if (d > (driving ? 40 : 38) || d < 2) continue;
      ped.attackCooldown -= dt * 0.5;
      if (ped.attackCooldown > 0) continue;
      if (!g.physics.lineOfSight(ped.pos.x, ped.pos.y + 1.5, ped.pos.z, p.pos.x, p.pos.y + 1.2, p.pos.z, !driving)) continue;
      ped.attackCooldown = (driving ? 1.1 : 0.6) + rand.next() * 0.8;
      if (!driving) ped.yaw = headingOf(p.pos.x - ped.pos.x, p.pos.z - ped.pos.z);
      this.npcShoot(ped, p.pos.x, p.pos.y + 1.2, p.pos.z, ped.weapon as WeaponId, 0.45);
    }
  }

  // ---------------------------------------------------------------------------
  /** Target selection for lock-on aim assist. */
  private updateTarget(): void {
    const g = this.game;
    const p = g.player;
    const mode = g.settings.data.aimAssist;
    const holdingAim = this.aiming || (p.mode === 'vehicle' && g.input.down('attack'));
    const wantLock = mode !== 'off' && (holdingAim || (mode === 'full' && g.input.down('attack')));
    if (!wantLock || !this.canAct()) {
      this.target = null;
      return;
    }
    const d = this.arsenal.def;
    const cam = g.renderer.camera;
    cam.getWorldDirection(_d);
    const cone = mode === 'full' ? this.assistCone : this.assistCone * 0.5;
    const range = d.kind === 'melee' ? 6 : Math.min(d.range, 70);
    const cands: { t: Ped; score: number; sx: number }[] = [];
    for (const ped of g.peds?.peds ?? []) {
      if (!ped.alive || ped.persistent && ped.archetype === 'story' && !ped.hostile) continue;
      _t.set(ped.pos.x, ped.pos.y + 1.2, ped.pos.z);
      const dist = _t.distanceTo(p.pos);
      if (dist > range || dist < 0.5) continue;
      _v.subVectors(_t, cam.position).normalize();
      const ang = Math.acos(clamp(_v.dot(_d), -1, 1));
      if (ang > cone) continue;
      if (!g.physics.lineOfSight(cam.position.x, cam.position.y, cam.position.z, _t.x, _t.y, _t.z, true)) continue;
      const pri = ped.hostile || ped.archetype === 'cop' || ped.archetype === 'swat' ? 0.6 : 1;
      _ndc.copy(_t).project(cam);
      cands.push({ t: ped, score: (ang * 2 + dist / range) * pri, sx: _ndc.x });
    }
    cands.sort((a, b) => a.score - b.score);
    const cur = this.target instanceof Ped ? cands.find((c) => c.t === this.target) : undefined;
    if (g.input.pressed('switchTarget') && cands.length > 1) {
      const sx = cur ? cur.sx : 0;
      const dir = g.input.swipeX !== 0 ? Math.sign(g.input.swipeX) : 1;
      const side = cands.filter((c) => c !== cur && (c.sx - sx) * dir > 0).sort((a, b) => Math.abs(a.sx - sx) - Math.abs(b.sx - sx));
      this.target = (side[0] ?? cands.find((c) => c !== cur) ?? cands[0]!).t;
      return;
    }
    if (cur) return; // sticky
    this.target = cands[0]?.t ?? null;
  }

  update(dt: number): void {
    const g = this.game;
    this.updateTarget();
    this.ragdolls.update(dt);
    this.tracers.update(dt);
    this.casings.update(dt);
    // held weapon visual
    const p = g.player;
    const d = this.arsenal.def;
    if (p.mode === 'foot' || p.mode === 'scripted') p.held = g.theft?.busy ? p.held : d.held;
    // HUD
    g.hud.weaponInfo(d.icon, d.name, this.arsenal.reloading > 0 ? 'reloading…' : this.arsenal.ammoText());
    const aimingNow = this.aiming && this.canAct();
    g.hud.crosshairVisible(aimingNow && d.kind !== 'melee', d.kind === 'thrown');
    g.cam.mode = g.cam.mode === 'aim' && d.scope && aimingNow ? 'scope' : g.cam.mode === 'scope' && !aimingNow ? 'foot' : g.cam.mode;
    this.gyro.active = aimingNow;
    const scoped = g.cam.mode === 'scope';
    g.hud.scope(scoped);
    g.touch.setContext('reload', d.kind === 'gun');
    g.touch.setContext('switchTarget', !!this.target);
    if (this.target) {
      this.targetPoint(this.target, _t);
      _ndc.copy(_t).project(g.renderer.camera);
      if (_ndc.z < 1) {
        this.targetScreen.set((_ndc.x * 0.5 + 0.5) * innerWidth, (-_ndc.y * 0.5 + 0.5) * innerHeight);
        g.hud.lockOn(this.targetScreen.x, this.targetScreen.y);
      } else g.hud.lockOn(null);
      // aim the camera gently toward the target
      if (p.mode === 'foot' && this.aiming) {
        const want = headingOf(_t.x - p.pos.x, _t.z - p.pos.z);
        g.cam.yaw += angleDiff(g.cam.yaw, want) * Math.min(1, dt * 6);
      }
    } else g.hud.lockOn(null);
    // wheel input (mouse / stick)
    if (this.wheel.open) {
      this.wheel.push(g.input.lookX * 40, g.input.lookY * 40, this.arsenal);
      this.wheel.stick(g.input.moveX, g.input.moveY, this.arsenal);
      g.input.lookX = g.input.lookY = 0;
    }
  }

  clearWorldFx(): void {
    for (const pr of this.projectiles) {
      this.game.scene.remove(pr.mesh);
      this.game.physics.removeBody(pr.body);
    }
    this.projectiles = [];
    this.fires = [];
  }
}
