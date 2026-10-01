import { describe, expect, it } from 'vitest';
import { MISSIONS } from '../src/missions/index';
import { validateMission, type MissionDef, type Step } from '../src/missions/schema';
import { MissionRunner, type MissionHost } from '../src/missions/MissionRunner';
import { VEHICLES } from '../src/vehicles/VehicleData';
import { WEAPONS } from '../src/combat/Weapons';
import { CHARACTERS } from '../src/data/characters';
import { isSea } from '../src/world/MapData';

const known = {
  vehicles: new Set(VEHICLES.map((v) => v.id)),
  weapons: new Set(Object.keys(WEAPONS)),
  missions: new Set(MISSIONS.map((m) => m.id)),
};

describe('mission data', () => {
  it('has a full story: 20+ missions, 3 acts, 2 endings', () => {
    expect(MISSIONS.length).toBeGreaterThanOrEqual(22);
    expect(new Set(MISSIONS.map((m) => m.act)).size).toBe(3);
    expect(MISSIONS.filter((m) => m.ending).map((m) => m.ending).sort()).toEqual(['A', 'B']);
  });
  it('validates against the schema', () => {
    const errs = MISSIONS.flatMap((m) => validateMission(m, known));
    expect(errs).toEqual([]);
  });
  it('unique ids and acyclic prerequisites in order', () => {
    const seen = new Set<string>();
    for (const m of MISSIONS) {
      expect(seen.has(m.id)).toBe(false);
      for (const r of m.requires) expect(seen.has(r), `${m.id} requires later mission ${r}`).toBe(true);
      seen.add(m.id);
    }
  });
  it('story characters referenced exist', () => {
    for (const m of MISSIONS) for (const s of m.steps) {
      const app = (s as { app?: string }).app ?? (s as { driver?: string }).driver;
      if (app && app.startsWith('story:')) expect(CHARACTERS[app.slice(6)], `${m.id} ${app}`).toBeDefined();
    }
  });
  it('places land objectives on land and boat objectives on water', () => {
    for (const m of MISSIONS) {
      expect(isSea(m.start.x, m.start.z), `${m.id} start in sea`).toBe(false);
      for (const s of m.steps) {
        if (s.type === 'goto' && s.kind !== 'boat') expect(isSea(s.x, s.z), `${m.id} goto ${s.text}`).toBe(false);
        if (s.type === 'goto' && s.kind === 'boat') expect(isSea(s.x, s.z), `${m.id} boat goto ${s.text}`).toBe(true);
        if (s.type === 'spawnVehicle') {
          const boat = s.def === 'marlin' || s.def === 'skiff';
          expect(isSea(s.x, s.z), `${m.id} spawn ${s.tag} ${s.def}`).toBe(boat);
        }
        if (s.type === 'spawnPed' || s.type === 'spawnGroup') expect(isSea(s.x, s.z), `${m.id} ped ${s.tag}`).toBe(false);
      }
    }
  });
});

/** Fake host: every objective completes on the next tick; tracks spawned tags. */
class FakeHost implements MissionHost {
  t = 0;
  tags = new Map<string, number>();
  killed = new Set<string>();
  flags = new Map<string, string>();
  passed: string[] = [];
  failed: string[] = [];
  branch: string | null = null;
  inVeh: string | null = null;
  pos = { x: 0, y: 0, z: 0 };
  stepFn: () => Step | null = () => null;
  constructor(private choice = 'A') {}
  now(): number { return this.t; }
  spawn(s: Extract<Step, { type: 'spawnVehicle' | 'spawnPed' | 'spawnGroup' }>): void {
    this.tags.set(s.tag, (this.tags.get(s.tag) ?? 0) + (s.type === 'spawnGroup' ? s.count : 1));
  }
  spawnWave(w: { tag: string; count: number }): void { this.tags.set(w.tag, (this.tags.get(w.tag) ?? 0) + w.count); }
  despawn(tag: string): void { this.tags.delete(tag); }
  cleanup(): void { this.tags.clear(); }
  playerPos() { return this.pos; }
  playerVehicle() {
    const s = this.stepFn();
    if (s && s.type === 'goto' && s.onFoot) return null;
    const kind = s && (s.type === 'goto' || s.type === 'enterAny') && s.kind ? s.kind : 'car';
    const tag = s && 'tag' in s ? (s as { tag?: string }).tag ?? null : null;
    return { tag, kind, hot: false, police: true };
  }
  aliveCount(tag: string): number { return this.killed.has(tag) ? 0 : this.tags.get(tag) ?? 0; }
  totalCount(tag: string): number { return this.tags.get(tag) ?? 0; }
  destroyed(tag: string): boolean { return this.killed.has(tag); }
  tagPos() { return { ...this.pos }; }
  vehicleHealth(): number { return 1; }
  objective(): void {}
  help(): void {}
  startDialogue(): void {}
  dialogueDone(): boolean { return true; }
  marker(p: { x: number; z: number; y?: number } | null): void { if (p) { this.pos = { x: p.x, y: p.y ?? 0, z: p.z }; } }
  routeTo(): void {}
  targetTag(tag: string | null): void { if (tag) { this.inVeh = tag; this.killed.add(tag); } }
  setWanted(): void {}
  wantedStars(): number { return 0; }
  timerText(): void {}
  counterText(): void {}
  give(): void {}
  cash(): void {}
  armor(): void {}
  teleport(x: number, z: number): void { this.pos = { x, y: 0, z }; }
  setHour(): void {}
  setWeather(): void {}
  drive(): void {}
  routeDone(): boolean { return true; }
  pedAction(): void {}
  fade(): void {}
  spawnCollectibles(): void {}
  collectRemaining(): number { return 0; }
  guardsSeePlayer(): boolean { return false; }
  showChoice(): void {}
  choiceResult(): string | null { return this.choice; }
  setFlag(f: string, v: string): void { this.flags.set(f, v); }
  getFlag(f: string): string | undefined { return this.flags.get(f); }
  unlock(): void {}
  onPassed(m: MissionDef): void { this.passed.push(m.id); }
  onFailed(m: MissionDef, r: string): void { this.failed.push(`${m.id}: ${r}`); }
  onBranch(id: string): void { this.branch = id; }
  stopTarget(): void {}
}

describe('MissionRunner', () => {
  it('plays every mission to completion with a cooperative host', () => {
    for (const m of MISSIONS) {
      // goto/deliver/escort need the player at the target: the fake host teleports on marker()
      const host = new FakeHost();
      const r = new MissionRunner(host);
      host.stepFn = () => r.step;
      // arrival-type fail rules ('arrives') would trigger immediately with routeDone() = true
      const mm: MissionDef = { ...m, fail: (m.fail ?? []).filter((f) => f.type !== 'arrives' && f.type !== 'dead' && f.type !== 'destroyed') };
      r.start(mm);
      for (let i = 0; i < 2000 && r.state === 'running'; i++) {
        host.t += 0.25;
        // chase steps: put the player near the target
        r.update(0.25);
      }
      expect(host.failed, m.id).toEqual([]);
      expect(r.state, m.id).toBe('passed');
    }
  });
  it('branches to the chosen ending', () => {
    for (const choice of ['A', 'B']) {
      const host = new FakeHost(choice);
      const r = new MissionRunner(host);
      host.stepFn = () => r.step;
      r.start(MISSIONS.find((m) => m.id === 'm21_thechoice')!);
      for (let i = 0; i < 400 && r.state === 'running'; i++) r.update(0.25);
      expect(host.branch).toBe(choice === 'A' ? 'm22a_cleangetaway' : 'm22b_kingofthecoast');
    }
  });
  it('fails on timer expiry and retries from checkpoint', () => {
    const host = new FakeHost();
    host.marker = () => undefined; // player never arrives
    const r = new MissionRunner(host);
    const m: MissionDef = {
      id: 't', act: 1, title: 't', giver: 'x', start: { x: 0, z: 0 }, requires: [], reward: 0, summary: '',
      steps: [{ type: 'checkpoint', x: 5, z: 5 }, { type: 'timer', time: 2 }, { type: 'goto', x: 100, z: 100, text: 'go' }],
    };
    r.start(m);
    for (let i = 0; i < 20; i++) r.update(0.25);
    expect(r.state).toBe('failed');
    expect(host.failed[0]).toContain('Out of time');
    r.retry();
    expect(r.state).toBe('running');
    expect(host.pos.x).toBe(5);
    expect(r.index).toBe(1);
  });
});
