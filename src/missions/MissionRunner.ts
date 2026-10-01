/**
 * Data-driven mission runner (pure logic). All world interaction goes through MissionHost
 * so the runner is unit-testable with a fake host.
 */
import type { Line, MissionDef, Shot, Step } from './schema';

export interface Vec {
  x: number;
  y: number;
  z: number;
}

export interface PlayerVehicleInfo {
  tag: string | null;
  kind: 'car' | 'bike' | 'boat' | 'heli';
  hot: boolean;
  police: boolean;
}

export interface MissionHost {
  now(): number;
  spawn(step: Extract<Step, { type: 'spawnVehicle' | 'spawnPed' | 'spawnGroup' }>): void;
  spawnWave(w: { tag: string; count: number; x: number; z: number; r?: number; app: string; weapon?: string; vehicle?: string }): void;
  despawn(tag: string): void;
  cleanup(): void;
  playerPos(): Vec;
  playerVehicle(): PlayerVehicleInfo | null;
  aliveCount(tag: string): number;
  totalCount(tag: string): number;
  destroyed(tag: string): boolean;
  tagPos(tag: string): Vec | null;
  vehicleHealth(tag: string): number;
  objective(text: string | null): void;
  help(text: string | null, seconds?: number): void;
  startDialogue(lines: Line[], shots?: Shot[], letterbox?: boolean): void;
  dialogueDone(): boolean;
  marker(p: { x: number; z: number; y?: number; radius: number } | null): void;
  routeTo(p: { x: number; z: number } | null): void;
  targetTag(tag: string | null): void;
  setWanted(stars: number, lock: boolean): void;
  wantedStars(): number;
  timerText(text: string | null): void;
  counterText(text: string | null): void;
  give(weapon: string, ammo: number): void;
  cash(amount: number): void;
  armor(amount: number): void;
  teleport(x: number, z: number, yaw?: number, y?: number, vehicle?: string): void;
  setHour(h: number): void;
  setWeather(k: string): void;
  drive(tag: string, route: [number, number][], speed: number, opts: { loop?: boolean; aggressive?: boolean; flee?: boolean }): void;
  routeDone(tag: string): boolean;
  pedAction(tag: string, action: string): void;
  fade(out: boolean, time: number): void;
  spawnCollectibles(tag: string, items: [number, number][], atTag?: string): void;
  collectRemaining(tag: string): number;
  guardsSeePlayer(tag: string, range: number): boolean;
  showChoice(text: string, options: { label: string; value: string }[]): void;
  choiceResult(): string | null;
  setFlag(flag: string, value: string): void;
  getFlag(flag: string): string | undefined;
  unlock(what: string, id: string): void;
  onPassed(m: MissionDef): void;
  onFailed(m: MissionDef, reason: string): void;
  onBranch(missionId: string): void;
  stopTarget(tag: string): void;
}

export type RunnerState = 'idle' | 'running' | 'failed' | 'passed';

export class MissionRunner {
  state: RunnerState = 'idle';
  mission: MissionDef | null = null;
  index = 0;
  private stepT = 0;
  private stepStarted = false;
  private checkpoint = -1;
  private timerLeft = -1;
  private spottedT = 0;
  private closeT = 0;
  private waveDone = new Set<number>();
  failReason = '';
  private collectTotal = 1;
  /** Total elapsed mission time (stats). */
  elapsed = 0;

  constructor(private host: MissionHost) {}

  get step(): Step | null {
    return this.mission?.steps[this.index] ?? null;
  }

  start(m: MissionDef): void {
    this.mission = m;
    this.state = 'running';
    this.index = 0;
    this.checkpoint = -1;
    this.timerLeft = -1;
    this.stepStarted = false;
    this.elapsed = 0;
    this.failReason = '';
    if (m.hour !== undefined) this.host.setHour(m.hour);
    if (m.weather) this.host.setWeather(m.weather);
  }

  /** Retry from the last checkpoint (or the start). */
  retry(): void {
    const m = this.mission;
    if (!m) return;
    this.host.cleanup();
    this.state = 'running';
    this.timerLeft = -1;
    this.stepStarted = false;
    if (this.checkpoint >= 0) {
      const cp = m.steps[this.checkpoint] as Extract<Step, { type: 'checkpoint' }>;
      this.host.teleport(cp.x, cp.z, cp.yaw, cp.y, cp.vehicle);
      this.index = this.checkpoint + 1;
    } else {
      this.index = 0;
      this.host.teleport(m.start.x, m.start.z);
    }
  }

  abort(): void {
    if (!this.mission) return;
    this.host.cleanup();
    this.clearUi();
    this.state = 'idle';
    this.mission = null;
  }

  fail(reason: string): void {
    if (this.state !== 'running' || !this.mission) return;
    this.state = 'failed';
    this.failReason = reason;
    this.clearUi();
    this.host.onFailed(this.mission, reason);
  }

  private clearUi(): void {
    const h = this.host;
    h.objective(null);
    h.marker(null);
    h.routeTo(null);
    h.targetTag(null);
    h.timerText(null);
    h.counterText(null);
  }

  private pass(): void {
    const m = this.mission!;
    this.state = 'passed';
    this.clearUi();
    this.host.onPassed(m);
  }

  private next(): void {
    this.index++;
    this.stepStarted = false;
    this.stepT = 0;
    this.host.marker(null);
    this.host.routeTo(null);
    this.host.targetTag(null);
    this.host.counterText(null);
  }

  private dist2(a: Vec, x: number, z: number): number {
    return Math.hypot(a.x - x, a.z - z);
  }

  update(dt: number): void {
    if (this.state !== 'running' || !this.mission) return;
    this.elapsed += dt;
    const h = this.host;
    // timer
    if (this.timerLeft >= 0) {
      this.timerLeft -= dt;
      const t = Math.max(0, this.timerLeft);
      h.timerText(`${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`);
      if (this.timerLeft <= 0) {
        this.fail('Out of time');
        return;
      }
    }
    // fail rules
    for (const f of this.mission.fail ?? []) {
      if (f.type === 'dead' && f.tag && h.totalCount(f.tag) > 0 && h.aliveCount(f.tag) === 0) return this.fail(f.text ?? `${f.tag} died`);
      if (f.type === 'destroyed' && f.tag && h.destroyed(f.tag)) return this.fail(f.text ?? `The ${f.tag} was destroyed`);
      if (f.type === 'arrives' && f.tag && h.routeDone(f.tag)) return this.fail(f.text ?? `${f.tag} got there first`);
      if (f.type === 'far' && f.tag) {
        const p = h.tagPos(f.tag);
        if (p && this.dist2(h.playerPos(), p.x, p.z) > (f.dist ?? 300)) return this.fail(f.text ?? `You abandoned ${f.tag}`);
      }
    }
    // run steps (instant ones chain)
    for (let guard = 0; guard < 64; guard++) {
      if (this.index >= this.mission.steps.length) {
        this.pass();
        return;
      }
      const s = this.mission.steps[this.index]!;
      const first = !this.stepStarted;
      if (first) {
        this.stepStarted = true;
        this.stepT = 0;
      } else this.stepT += dt;
      const done = this.run(s, first, first ? 0 : dt);
      if (this.state !== 'running') return;
      if (!done) return;
      this.next();
      // after a branch the mission may have changed
      if (!this.mission) return;
    }
  }

  /** Execute/poll one step. Returns true when complete. */
  private run(s: Step, first: boolean, dt: number): boolean {
    const h = this.host;
    const pp = h.playerPos();
    switch (s.type) {
      case 'dialogue':
        if (first) h.startDialogue(s.lines, s.shots, s.letterbox);
        return h.dialogueDone();
      case 'cutscene':
        if (first) h.startDialogue(s.lines ?? [], s.shots, true);
        return h.dialogueDone();
      case 'goto': {
        const r = s.radius ?? 5;
        if (first) {
          h.objective(s.text);
          if (s.help) h.help(s.help, 8);
          if (s.marker !== false) h.marker({ x: s.x, z: s.z, y: s.y, radius: r });
          h.routeTo({ x: s.x, z: s.z });
        }
        const pv = h.playerVehicle();
        if (s.vehicle && !pv) return false;
        if (s.onFoot && pv) return false;
        if (s.kind && (!pv || pv.kind !== s.kind)) return false;
        if (s.tag && (!pv || pv.tag !== s.tag)) return false;
        const d = this.dist2(pp, s.x, s.z);
        if (s.y !== undefined && Math.abs(pp.y - s.y) > Math.max(6, r)) return false;
        return d < r;
      }
      case 'enterVehicle': {
        if (first) {
          h.objective(s.text);
          h.targetTag(s.tag);
          if (s.help) h.help(s.help, 8);
        }
        return h.playerVehicle()?.tag === s.tag;
      }
      case 'enterAny': {
        if (first) {
          h.objective(s.text);
          if (s.help) h.help(s.help, 8);
        }
        const pv = h.playerVehicle();
        if (!pv) return false;
        if (s.kind && pv.kind !== s.kind) return false;
        if (s.police && !pv.police) return false;
        return true;
      }
      case 'spawnVehicle':
      case 'spawnPed':
      case 'spawnGroup':
        h.spawn(s);
        return true;
      case 'kill': {
        const total = h.totalCount(s.tag);
        const alive = h.aliveCount(s.tag);
        const need = s.count ?? total;
        if (first) {
          h.objective(s.text);
          h.targetTag(s.tag);
          if (s.help) h.help(s.help, 8);
        }
        const killed = total - alive;
        if (total > 1) h.counterText(`${Math.min(killed, need)} / ${need}`);
        return killed >= need;
      }
      case 'destroy':
        if (first) {
          h.objective(s.text);
          h.targetTag(s.tag);
        }
        return h.destroyed(s.tag);
      case 'deliver': {
        const r = s.radius ?? 6;
        if (first) {
          h.objective(s.text);
          h.marker({ x: s.x, z: s.z, radius: r });
          h.routeTo({ x: s.x, z: s.z });
        }
        const p = h.tagPos(s.tag);
        if (!p) return false;
        if (s.minHealth !== undefined && h.vehicleHealth(s.tag) < s.minHealth) {
          this.fail('The vehicle is too damaged');
          return false;
        }
        return this.dist2(p, s.x, s.z) < r && h.playerVehicle()?.tag === s.tag;
      }
      case 'follow': {
        if (first) {
          h.objective(s.text);
          h.targetTag(s.tag);
          h.drive(s.tag, s.route, s.speed ?? 12, {});
          this.spottedT = 0;
        }
        const p = h.tagPos(s.tag);
        if (!p) return false;
        const d = this.dist2(pp, p.x, p.z);
        if (d > (s.maxDist ?? 120)) this.fail('You lost the target');
        if (d < (s.minDist ?? 0)) {
          this.spottedT += dt;
          if (this.spottedT > 3) this.fail('You were spotted — keep your distance');
        } else this.spottedT = Math.max(0, this.spottedT - dt);
        return h.routeDone(s.tag);
      }
      case 'chase': {
        if (first) {
          h.objective(s.text);
          h.targetTag(s.tag);
          h.drive(s.tag, s.route, s.speed ?? 16, { aggressive: true, flee: true });
          this.closeT = 0;
        }
        const p = h.tagPos(s.tag);
        if (!p) return true;
        const d = this.dist2(pp, p.x, p.z);
        if (d > (s.maxDist ?? 220)) {
          if (s.escape) return true;
          this.fail('They got away');
          return false;
        }
        if (!s.escape && d < (s.catchDist ?? 7)) {
          this.closeT += dt;
          if (this.closeT > 1) {
            h.stopTarget(s.tag);
            return true;
          }
        }
        if (h.aliveCount(s.tag) === 0 || h.destroyed(s.tag)) return true;
        return h.routeDone(s.tag);
      }
      case 'escort': {
        const r = s.radius ?? 8;
        if (first) {
          h.objective(s.text);
          h.pedAction(s.tag, 'follow');
          h.marker({ x: s.x, z: s.z, radius: r });
          h.routeTo({ x: s.x, z: s.z });
        }
        const p = h.tagPos(s.tag);
        if (!p) return false;
        return this.dist2(p, s.x, s.z) < r && this.dist2(pp, s.x, s.z) < r + 4;
      }
      case 'survive': {
        if (first) {
          h.objective(s.text);
          this.waveDone.clear();
        }
        (s.waves ?? []).forEach((w, i) => {
          if (!this.waveDone.has(i) && this.stepT >= w.at) {
            this.waveDone.add(i);
            h.spawnWave(w);
          }
        });
        const left = Math.max(0, s.time - this.stepT);
        h.counterText(`Hold out: ${Math.ceil(left)}s`);
        return this.stepT >= s.time;
      }
      case 'wanted':
        h.setWanted(s.stars, s.lock ?? false);
        if (s.text) h.objective(s.text);
        return true;
      case 'loseWanted':
        if (first) h.objective(s.text);
        return h.wantedStars() === 0;
      case 'timer':
        this.timerLeft = s.time;
        return true;
      case 'clearTimer':
        this.timerLeft = -1;
        h.timerText(null);
        return true;
      case 'collect': {
        const tag = s.tag ?? 'collect';
        if (first) {
          h.objective(s.text);
          h.spawnCollectibles(tag, s.items, s.atTag);
          h.targetTag(tag);
          this.collectTotal = Math.max(1, h.collectRemaining(tag));
        }
        const left = h.collectRemaining(tag);
        h.counterText(`${this.collectTotal - left} / ${this.collectTotal}`);
        return left === 0;
      }
      case 'stealth': {
        const r = s.radius ?? 4;
        if (first) {
          h.objective(s.text);
          h.marker({ x: s.x, z: s.z, radius: r });
          this.spottedT = 0;
        }
        if (h.guardsSeePlayer(s.guards, s.detect ?? 12)) {
          this.spottedT += dt;
          if (this.spottedT > 1.5) this.fail('You were spotted');
        } else this.spottedT = Math.max(0, this.spottedT - dt * 0.5);
        return this.dist2(pp, s.x, s.z) < r;
      }
      case 'wait':
        return this.stepT >= s.time;
      case 'checkpoint':
        this.checkpoint = this.index;
        return true;
      case 'choice':
        if (first) h.showChoice(s.text, s.options.map((o) => ({ label: o.label, value: o.value })));
        {
          const r = h.choiceResult();
          if (r === null) return false;
          const opt = s.options.find((o) => o.value === r) ?? s.options[0]!;
          h.setFlag(opt.flag, opt.value);
          return true;
        }
      case 'branch':
        if (h.getFlag(s.flag) === s.value) {
          const m = this.mission!;
          this.state = 'passed';
          this.clearUi();
          h.onPassed(m);
          h.onBranch(s.mission);
          return false;
        }
        return true;
      case 'setFlag':
        h.setFlag(s.flag, s.value);
        return true;
      case 'give':
        h.give(s.weapon, s.ammo ?? 0);
        return true;
      case 'cash':
        h.cash(s.amount);
        return true;
      case 'armor':
        h.armor(s.amount);
        return true;
      case 'teleport':
        h.teleport(s.x, s.z, s.yaw, s.y, s.vehicle);
        return true;
      case 'time':
        h.setHour(s.hour);
        return true;
      case 'weather':
        h.setWeather(s.kind);
        return true;
      case 'despawn':
        h.despawn(s.tag);
        return true;
      case 'drive':
        h.drive(s.tag, s.route, s.speed ?? 14, { loop: s.loop, aggressive: s.aggressive });
        return true;
      case 'pedAction':
        h.pedAction(s.tag, s.action);
        return true;
      case 'fadeOut':
        if (first) h.fade(true, s.time ?? 0.8);
        return this.stepT >= (s.time ?? 0.8);
      case 'fadeIn':
        h.fade(false, s.time ?? 0.8);
        return true;
      case 'help':
        h.help(s.text, s.time ?? 6);
        return true;
      case 'hint':
        h.objective(s.text);
        return true;
      case 'unlock':
        h.unlock(s.what, s.id);
        return true;
    }
    return true;
  }
}
