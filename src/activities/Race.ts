import { Activity, type ActivityManager } from './ActivityManager';
import { checkpoints, densify, racePrize, standings, type RacerProgress } from './logic';
import { RouteDriver } from '../missions/RouteDriver';
import type { Vehicle } from '../vehicles/Vehicle';
import type { Blip } from '../ui/Minimap';
import { headingOf } from '../core/math';
import { DESERT_ROADS } from '../world/MapData';

export interface RaceDef {
  id: string;
  name: string;
  /** Anchor points; the course follows the road graph between them. */
  anchors: [number, number][];
  /** Use the anchors verbatim (desert highways) instead of graph routing. */
  direct?: boolean;
  rivals: string[];
  prize: number;
  /** Rival pace as fraction of their top speed. */
  pace: number;
}

const mesa = DESERT_ROADS.find((r) => r.name === 'Mesa Loop')!.points;

export const RACES: RaceDef[] = [
  { id: 'race_harbor', name: 'Harbor Sprint', anchors: [[-220, -600], [-220, -250], [-40, -250], [-40, 200], [160, 200], [160, -340], [270, -340], [270, -620]], rivals: ['meridian', 'bruiser', 'stiletto'], prize: 1500, pace: 0.78 },
  { id: 'race_coast', name: 'Coastline Dash', anchors: [[-690, 880], [-690, 420], [-690, -60], [-590, -340], [-590, -690], [-400, -760]], rivals: ['stiletto', 'bruiser', 'ranger'], prize: 2500, pace: 0.82 },
  { id: 'race_mesa', name: 'Mesa Loop', anchors: mesa.map(([x, z]) => [x, z] as [number, number]), direct: true, rivals: ['stiletto', 'aurelia', 'bruiser'], prize: 4000, pace: 0.86 },
];

interface Rival {
  v: Vehicle;
  drv: RouteDriver;
  prog: RacerProgress;
}

/** Street race vs three AI rivals through road checkpoints. */
export class StreetRace extends Activity {
  readonly id: string;
  readonly title: string;
  private route: [number, number][] = [];
  private cps: [number, number][] = [];
  private rivals: Rival[] = [];
  private me: RacerProgress = { id: 'player', cp: 0, dist: 0, finished: 0 };
  private countdown = 0;
  private finishedCount = 0;
  private outOfCar = 0;
  private lastPlace = 0;

  constructor(mgr: ActivityManager, readonly def: RaceDef) {
    super(mgr);
    this.id = def.id;
    this.title = def.name;
    const g = mgr.game;
    const [sx, sz] = def.anchors[0]!;
    g.interactions.add({
      id: def.id, x: sx, z: sz, r: 7, onFoot: false, inVehicle: true, color: 0xff4d8a, button: 'RACE',
      label: () => `Street race: ${def.name} — 1st pays $${def.prize.toLocaleString()}${this.bestText()}`,
      enabled: () => !this.active && mgr.canStart() && (g.police?.wanted.stars ?? 0) === 0,
      action: () => this.start(),
    });
  }

  private bestText(): string {
    const b = this.mgr.record[`${this.id}_best`];
    return b ? ` · best ${fmtTime(b)}` : '';
  }

  override blips(out: Blip[]): void {
    if (!this.active) {
      const [x, z] = this.def.anchors[0]!;
      out.push({ x, z, color: '#ff4d8a', shape: 'icon', size: 5.5, label: '🏁' });
      return;
    }
    const c = this.cps[this.me.cp];
    if (c) out.push({ x: c[0], z: c[1], color: '#ffd250', shape: 'ring', size: 5, pin: true });
    for (const r of this.rivals) if (!r.v.destroyed) out.push({ x: r.v.position.x, z: r.v.position.z, color: '#ff8a4d', shape: 'triangle', size: 4 });
  }

  private buildRoute(): [number, number][] {
    const g = this.game;
    const a = this.def.anchors;
    if (this.def.direct || !g.world) return densify(a, 30);
    const out: [number, number][] = [[a[0]![0], a[0]![1]]];
    for (let i = 1; i < a.length; i++) {
      const seg = g.world.data.graph.route(a[i - 1]![0], a[i - 1]![1], a[i]![0], a[i]![1]);
      for (const p of seg) {
        const l = out[out.length - 1]!;
        if (Math.hypot(p[0] - l[0], p[1] - l[1]) > 3) out.push([p[0], p[1]]);
      }
      const l = out[out.length - 1]!;
      if (Math.hypot(a[i]![0] - l[0], a[i]![1] - l[1]) > 3) out.push([a[i]![0], a[i]![1]]);
    }
    return densify(out, 30);
  }

  start(): void {
    const g = this.game;
    const v = g.vctrl?.vehicle;
    if (!v || (v.kind !== 'car' && v.kind !== 'bike')) {
      g.hud.toast('You need a car or bike to race', 2000);
      return;
    }
    if (!this.mgr.begin(this)) return;
    this.route = this.buildRoute();
    this.cps = checkpoints(this.route, 110);
    this.me = { id: 'player', cp: 0, dist: 0, finished: 0 };
    this.finishedCount = 0;
    this.outOfCar = 0;
    this.lastPlace = 0;
    // grid: 2×2 behind the start line, facing the course
    const [x0, z0] = this.route[0]!;
    const [x1, z1] = this.route[Math.min(2, this.route.length - 1)]!;
    const h = headingOf(x1 - x0, z1 - z0);
    const fx = Math.sin(h), fz = Math.cos(h), rx = Math.cos(h), rz = -Math.sin(h);
    const slot = (i: number): [number, number] => {
      const row = Math.floor(i / 2), side = i % 2 ? -1 : 1;
      return [x0 - fx * (8 + row * 9) + rx * side * 2.6, z0 - fz * (8 + row * 9) + rz * side * 2.6];
    };
    g.world?.loadAround(x0, z0);
    const vm = g.vehicles!;
    // clear the grid
    for (const o of [...vm.vehicles]) {
      if (o === v || o.persistent || o.driver?.kind === 'player') continue;
      if (Math.hypot(o.position.x - x0, o.position.z - z0) < 40) vm.despawn(o);
    }
    const [px, pz] = slot(0);
    g.teleport(px, pz, h);
    this.rivals = [];
    this.def.rivals.forEach((id, i) => {
      const [sx, sz] = slot(i + 1);
      const rv = vm.spawn(id, sx, sz, h, { role: 'mission' });
      rv.persistent = true;
      g.peds?.spawnDriver(rv);
      rv.engineOn = true;
      const drv = new RouteDriver(rv, this.route, rv.def.maxSpeed * this.def.pace, { aggressive: true });
      drv.i = 1;
      this.rivals.push({ v: rv, drv, prog: { id: `r${i}`, cp: 0, dist: 0, finished: 0 } });
    });
    this.countdown = 3.99;
    g.inputLocked = true;
    g.hud.big('3', 'passed', this.def.name.toUpperCase(), 1);
  }

  override fixedUpdate(dt: number): void {
    if (this.countdown > 0) {
      for (const r of this.rivals) {
        r.v.throttle = 0;
        r.v.brake = 1;
      }
      return;
    }
    const g = this.game;
    const pp = g.vctrl?.vehicle?.position ?? g.player.pos;
    const myIdx = this.me.cp;
    for (const r of this.rivals) {
      if (r.v.destroyed || r.prog.finished) {
        if (r.prog.finished) {
          r.v.throttle = 0;
          r.v.brake = 1;
        }
        continue;
      }
      // light rubber-banding keeps the pack close
      const gap = r.prog.cp - myIdx;
      const base = r.v.def.maxSpeed * this.def.pace;
      r.drv.speed = base * (gap > 1 ? 0.88 : gap < -1 ? 1.12 : 1);
      if (!r.v.driver) continue;
      r.drv.step(dt, pp);
    }
  }

  override update(dt: number): void {
    const g = this.game;
    if (this.countdown > 0) {
      const before = Math.ceil(this.countdown);
      this.countdown -= dt;
      const now = Math.ceil(this.countdown);
      if (now !== before) {
        if (now > 0) g.hud.big(String(now), 'passed', '', 0.9);
        else {
          g.hud.big('GO!', 'passed', '', 1);
          g.inputLocked = false;
          g.haptic(60);
        }
      }
      this.drawCheckpoint();
      return;
    }
    const v = g.vctrl?.vehicle;
    // out of the car / wrecked
    if (!v || v.destroyed) {
      this.outOfCar += dt;
      g.hud.objectiveText(`Get back in a vehicle! <b>${Math.max(0, 10 - this.outOfCar).toFixed(0)}</b>`);
      if (this.outOfCar > 10) this.mgr.end(this, false, 'You left the race');
      return;
    }
    this.outOfCar = 0;
    // progress
    const step = (p: RacerProgress, x: number, z: number, reach: number): void => {
      if (p.finished) return;
      const c = this.cps[p.cp];
      if (!c) return;
      p.dist = Math.hypot(c[0] - x, c[1] - z);
      if (p.dist < reach) {
        p.cp++;
        if (p.cp >= this.cps.length) p.finished = ++this.finishedCount;
      }
    };
    const pp = v.position;
    const before = this.me.cp;
    step(this.me, pp.x, pp.z, 14);
    if (this.me.cp !== before) g.haptic(15);
    for (const r of this.rivals) step(r.prog, r.v.position.x, r.v.position.z, 18);
    const table = standings([this.me, ...this.rivals.filter((r) => !r.v.destroyed).map((r) => r.prog)]);
    const place = table.indexOf(this.me) + 1;
    if (place !== this.lastPlace) this.lastPlace = place;
    g.hud.counterText(`POS ${place}/${table.length}   CP ${Math.min(this.me.cp, this.cps.length)}/${this.cps.length}`);
    g.hud.timerText(fmtTime(this.elapsed));
    g.hud.objectiveText(this.me.cp === this.cps.length - 1 ? 'Final stretch — reach the <b>finish</b>!' : 'Race through the <b>checkpoints</b>');
    const c = this.cps[this.me.cp];
    g.gps.objective = c ? { x: c[0], z: c[1] } : null;
    this.drawCheckpoint();
    if (this.me.finished) {
      const t = this.elapsed;
      const rec = this.mgr.best(`${this.id}_best`, t);
      const prize = racePrize(this.def.prize, this.me.finished);
      if (this.me.finished === 1) {
        g.stats.inc('racesWon');
        this.mgr.bump(`${this.id}_wins`);
      }
      const ord = ['1st', '2nd', '3rd', '4th'][this.me.finished - 1] ?? `${this.me.finished}th`;
      this.mgr.end(this, this.me.finished <= 3, `${ord} · ${fmtTime(t)}${rec ? ' · NEW RECORD' : ''}`, prize, this.me.finished === 1 ? 'YOU WIN!' : `FINISHED ${ord.toUpperCase()}`);
      return;
    }
    // wandering way off course
    if (c && Math.hypot(c[0] - pp.x, c[1] - pp.z) > 700) this.mgr.end(this, false, 'You left the course');
  }

  private drawCheckpoint(): void {
    const g = this.game;
    const c = this.cps[this.me.cp];
    if (!c) return;
    const y = g.world ? Math.max(g.world.groundY(c[0], c[1]), 0) : 0;
    const last = this.me.cp === this.cps.length - 1;
    this.mgr.markers.beacon(c[0], y, c[1], 6, last ? 0xffffff : 0xffd250, 18);
    const n = this.cps[this.me.cp + 1];
    if (n) this.mgr.markers.beacon(n[0], g.world ? Math.max(g.world.groundY(n[0], n[1]), 0) : 0, n[1], 4, 0xff8a4d, 8);
  }

  override cleanup(): void {
    const g = this.game;
    g.inputLocked = false;
    this.countdown = 0;
    for (const r of this.rivals) {
      r.v.throttle = 0;
      r.v.brake = 1;
      this.mgr.discard({ v: r.v });
    }
    this.rivals = [];
    void g;
  }
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}
