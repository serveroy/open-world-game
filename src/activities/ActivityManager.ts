import * as THREE from 'three';
import type { Game, System } from '../game/Game';
import type { Blip } from '../ui/Minimap';
import { Markers } from '../ui/Markers';
import { perimeterLength, perimeterPoint, perimeterProject } from '../peds/PedManager';
import type { Block } from '../world/CityGen';
import type { Ped } from '../peds/Ped';
import type { Vehicle } from '../vehicles/Vehicle';
import { computePose, makeAnimState, makePose } from '../characters/Pose';
import { rand } from '../core/rng';

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Base class for side activities (races, jobs, rampages, events…). */
export abstract class Activity {
  abstract readonly id: string;
  abstract readonly title: string;
  active = false;
  /** Seconds since start. */
  elapsed = 0;
  constructor(protected readonly mgr: ActivityManager) {}
  protected get game(): Game {
    return this.mgr.game;
  }
  /** Called every frame regardless of state (start triggers, ambient spawning). */
  idle(_dt: number): void {}
  /** Called every frame while this activity is the active one. */
  update(_dt: number): void {}
  fixedUpdate(_dt: number): void {}
  blips(_out: Blip[]): void {}
  /** Release spawned entities / HUD. */
  cleanup(): void {}
  /** Player died / busted / quit. */
  abort(reason: string): void {
    this.mgr.end(this, false, reason);
  }
}

/** Runs one side activity at a time and shares helpers (markers, sidewalk points, passengers). */
export class ActivityManager implements System {
  name = 'activities';
  readonly list: Activity[] = [];
  current: Activity | null = null;
  /** Persistent per-activity progress (best times, completion counts). */
  readonly record: Record<string, number> = {};
  readonly markers: Markers;
  private passengers = new Map<Ped, Vehicle>();
  private pose = makePose();
  private anim = makeAnimState();
  /** Leftover entities to remove once the player is far away. */
  private litter: { v?: Vehicle; p?: Ped }[] = [];
  private litterT = 0;

  constructor(readonly game: Game) {
    this.markers = new Markers(game.scene);
    game.blipProviders.push((out) => {
      if (game.missions?.active) return;
      for (const a of this.list) if (!this.current || a === this.current) a.blips(out);
    });
    game.events.on('playerDied', () => this.current?.abort('You were wasted'));
    game.events.on('playerBusted', () => this.current?.abort('You were busted'));
  }

  add<T extends Activity>(a: T): T {
    this.list.push(a);
    return a;
  }

  get<T extends Activity>(id: string): T | null {
    return (this.list.find((a) => a.id === id) as T | undefined) ?? null;
  }

  /** Can a new activity start right now? */
  canStart(): boolean {
    const g = this.game;
    return !this.current && !(g.missions?.active ?? false) && !g.respawn.active && !g.ui.open;
  }

  begin(a: Activity): boolean {
    if (!this.canStart()) return false;
    this.current = a;
    a.active = true;
    a.elapsed = 0;
    this.game.hud.showHelp(null);
    return true;
  }

  /** Finish the current activity, award cash, show the banner. */
  end(a: Activity, passed: boolean, sub = '', reward = 0, banner?: string): void {
    if (this.current !== a) return;
    const g = this.game;
    a.active = false;
    this.current = null;
    a.cleanup();
    for (const [p] of this.passengers) this.unseat(p);
    g.hud.objectiveText(null);
    g.hud.timerText(null);
    g.hud.counterText(null);
    g.gps.objective = null;
    if (g.minimap) g.minimap.route = null;
    if (reward > 0) g.wallet.add(reward, a.title);
    const title = banner ?? (passed ? `${a.title.toUpperCase()} COMPLETE` : `${a.title.toUpperCase()} FAILED`);
    if (banner !== ' ') g.hud.big(title, passed ? 'passed' : 'failed', [sub, reward > 0 ? `+$${reward.toLocaleString()}` : ''].filter(Boolean).join(' · '), 3.5);
    if (passed) g.haptic([20, 30, 40]);
    g.events.emit('saveRequested', { reason: 'activity' });
  }

  bump(key: string, n = 1): number {
    this.record[key] = (this.record[key] ?? 0) + n;
    return this.record[key]!;
  }

  best(key: string, value: number, lowerIsBetter = true): boolean {
    const cur = this.record[key];
    if (cur === undefined || (lowerIsBetter ? value < cur : value > cur)) {
      this.record[key] = value;
      return true;
    }
    return false;
  }

  /** Random sidewalk point between minD and maxD from (x,z); city blocks only. */
  sidewalkPoint(x: number, z: number, minD: number, maxD: number, filter?: (b: Block) => boolean): { x: number; z: number; y: number; yaw: number } | null {
    const blocks = this.game.world?.data.blocks ?? [];
    const out = { x: 0, z: 0, dx: 0, dz: 0 };
    for (let i = 0; i < 60; i++) {
      const b = blocks[Math.floor(rand.next() * blocks.length)];
      if (!b || (filter && !filter(b))) continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const d = Math.hypot(cx - x, cz - z);
      if (d < minD || d > maxD) continue;
      perimeterPoint(b, rand.next() * perimeterLength(b), out);
      // face the road (outward normal of the loop: rotate tangent clockwise)
      const yaw = Math.atan2(out.dz, -out.dx);
      return { x: out.x, z: out.z, y: b.y, yaw };
    }
    return null;
  }

  /** Closest sidewalk-loop point to (x,z) (stable: used for fixed activity spots). */
  nearestSidewalk(x: number, z: number): { x: number; z: number; y: number; yaw: number } {
    const blocks = this.game.world?.data.blocks ?? [];
    const out = { x: 0, z: 0, dx: 0, dz: 0 };
    let best = { x, z, y: 0.16, yaw: 0 }, bd = Infinity;
    for (const b of blocks) {
      const cx = Math.min(b.x1, Math.max(b.x0, x)), cz = Math.min(b.z1, Math.max(b.z0, z));
      if (Math.hypot(cx - x, cz - z) > bd + 30) continue;
      perimeterPoint(b, perimeterProject(b, x, z), out);
      const d = Math.hypot(out.x - x, out.z - z);
      if (d < bd) {
        bd = d;
        best = { x: out.x, z: out.z, y: b.y, yaw: Math.atan2(out.dz, -out.dx) };
      }
    }
    return best;
  }

  /** Point on the road next to a sidewalk point (for pull-over markers). */
  curbside(p: { x: number; z: number; yaw: number }, off = 4.2): { x: number; z: number } {
    return { x: p.x + Math.sin(p.yaw) * off, z: p.z + Math.cos(p.yaw) * off };
  }

  /** Seat a ped as a passenger of `v` (rendered seated each frame). */
  seat(p: Ped, v: Vehicle): void {
    this.passengers.set(p, v);
    p.setState('scripted');
    p.setCollision(false);
    v.passengers.push({ kind: 'ped', ref: p });
  }

  unseat(p: Ped): void {
    const v = this.passengers.get(p);
    if (!v) return;
    this.passengers.delete(p);
    v.passengers = v.passengers.filter((o) => o.ref !== p);
    v.toWorld(v.info.door2, _v);
    const gy = this.game.world ? Math.max(this.game.world.groundY(_v.x, _v.z), 0) : 0;
    p.pos.set(_v.x, gy, _v.z);
    p.prevPos.copy(p.pos);
    p.setCollision(true);
    p.sync();
  }

  isSeated(p: Ped): boolean {
    return this.passengers.has(p);
  }

  /** Mark entities for removal once out of sight. */
  discard(e: { v?: Vehicle; p?: Ped }): void {
    if (e.p) e.p.persistent = false;
    if (e.v) {
      e.v.persistent = false;
      this.litter.push(e);
    } else if (e.p) this.litter.push(e);
  }

  fixedUpdate(dt: number): void {
    this.current?.fixedUpdate(dt);
    for (const [p, v] of this.passengers) {
      p.pos.copy(v.position);
      p.prevPos.copy(p.pos);
      if (v.destroyed) this.unseat(p);
    }
  }

  update(dt: number): void {
    const g = this.game;
    this.markers.begin();
    const missionOn = g.missions?.active ?? false;
    if (!missionOn) for (const a of this.list) a.idle(dt);
    const c = this.current;
    if (c) {
      c.elapsed += dt;
      c.update(dt);
    }
    this.markers.end(dt);
    // render seated passengers
    for (const [p, v] of this.passengers) {
      const seat = v.def.seats[1] ?? v.def.seats[0]!;
      _v.set(seat[0], seat[1] - 0.55, seat[2]).applyQuaternion(v.renderQuat).add(v.renderPos);
      _f.set(0, 0, 1).applyQuaternion(v.renderQuat);
      this.anim.driving = true;
      this.anim.steer = 0;
      this.anim.time += dt;
      computePose(this.pose, this.anim);
      g.chars.update(p.slot, _v.x, _v.y, _v.z, Math.atan2(_f.x, _f.z), this.pose, 'none', this.anim);
    }
    // litter collection
    this.litterT -= dt;
    if (this.litterT <= 0 && this.litter.length) {
      this.litterT = 2;
      const f = g.focus;
      this.litter = this.litter.filter((e) => {
        const pos = e.v ? e.v.position : e.p!.pos;
        if (Math.hypot(pos.x - f.x, pos.z - f.z) < 90 && !(e.v?.destroyed)) return true;
        if (e.v) {
          if (e.v.driver?.kind === 'player') return false;
          const d = e.v.driver?.kind === 'ped' ? (e.v.driver.ref as Ped) : null;
          if (d && g.peds?.peds.includes(d)) g.peds.despawn(d);
          g.vehicles?.despawn(e.v);
        } else if (e.p && g.peds?.peds.includes(e.p)) g.peds.despawn(e.p);
        return false;
      });
    }
  }

  save(): Record<string, number> {
    return { ...this.record };
  }

  load(r: Record<string, number>): void {
    for (const k of Object.keys(this.record)) delete this.record[k];
    Object.assign(this.record, r ?? {});
  }
}
