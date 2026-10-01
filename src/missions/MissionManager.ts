import * as THREE from 'three';
import type { Game, System } from '../game/Game';
import { MissionRunner, type MissionHost, type PlayerVehicleInfo, type Vec } from './MissionRunner';
import type { Line, MissionDef, Shot, Step, AppearanceKey } from './schema';
import { MISSIONS, MISSION_BY_ID } from './index';
import { RouteDriver } from './RouteDriver';
import { Markers } from '../ui/Markers';
import { Ped } from '../peds/Ped';
import type { Vehicle } from '../vehicles/Vehicle';
import { CHARACTERS } from '../data/characters';
import { policeAppearance, randomAppearance, type Appearance } from '../characters/Appearance';
import { Rng, rand } from '../core/rng';
import { angleDiff, headingOf } from '../core/math';
import { GROUPS } from '../physics/groups';
import type { WeaponId } from '../combat/Weapons';
import type { Blip } from '../ui/Minimap';
import type { WeatherKind } from '../world/TimeOfDay';
import { computePose, makeAnimState, makePose } from '../characters/Pose';

export interface StoryState {
  completed: string[];
  flags: Record<string, string>;
  unlocked: string[];
}

interface Tagged {
  peds: Ped[];
  vehicles: Vehicle[];
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();

/** Story progression + the live MissionHost implementation. */
export class MissionManager implements System, MissionHost {
  name = 'missions';
  readonly story: StoryState = { completed: [], flags: {}, unlocked: [] };
  readonly runner: MissionRunner;
  readonly markers: Markers;
  private tags = new Map<string, Tagged>();
  private drivers = new Map<Vehicle, RouteDriver>();
  private rng = new Rng(99);
  // UI state
  private dialogueLines: Line[] = [];
  private dialogueShots: Shot[] = [];
  private lineT = 0;
  private lineI = 0;
  private shotI = 0;
  private shotT = 0;
  private dialogueActive = false;
  private cutscene = false;
  private markerPos: { x: number; z: number; y?: number; radius: number } | null = null;
  private routeTarget: { x: number; z: number } | null = null;
  private routeT = 0;
  private target: string | null = null;
  private choiceEl: HTMLDivElement;
  private choiceValue: string | null = null;
  private failEl: HTMLDivElement;
  private creditsEl: HTMLDivElement;
  private pendingBranch: string | null = null;
  private startCooldown = 2;
  private escorts = new Set<Ped>();
  private passengers = new Map<Ped, Vehicle>();
  private pose = makePose();
  private anim = makeAnimState();
  onStoryChanged: (() => void) | null = null;
  /** Unlock hook (properties, shops, contacts) — economy listens. */
  onUnlock: ((what: string, id: string) => void) | null = null;

  constructor(private game: Game) {
    this.runner = new MissionRunner(this);
    this.markers = new Markers(game.scene);
    const root = game.hud.root;
    this.choiceEl = document.createElement('div');
    this.choiceEl.className = 'dialog-choice interactive';
    this.choiceEl.style.flexDirection = 'column';
    root.appendChild(this.choiceEl);
    this.failEl = document.createElement('div');
    this.failEl.className = 'dialog-choice interactive';
    this.failEl.innerHTML = `<button class="btn primary" data-a="retry">↻ RETRY</button><button class="btn" data-a="quit">✕ QUIT MISSION</button>`;
    this.failEl.addEventListener('pointerdown', (e) => {
      const a = (e.target as HTMLElement).closest('button')?.dataset.a;
      e.stopPropagation();
      if (a === 'retry') this.retry();
      if (a === 'quit') this.quit();
    });
    root.appendChild(this.failEl);
    this.creditsEl = document.createElement('div');
    this.creditsEl.className = 'panel';
    this.creditsEl.style.zIndex = '90';
    game.container.appendChild(this.creditsEl);
    game.blipProviders.push((out) => this.blips(out));
    game.events.on('playerDied', () => {
      if (this.runner.state === 'running') this.runner.fail('You were wasted');
    });
    game.events.on('playerBusted', () => {
      if (this.runner.state === 'running') this.runner.fail('You were busted');
    });
    // touch: tap screen to advance dialogue
    game.renderer.gl.domElement.addEventListener('pointerdown', () => {
      if (this.cutscene) this.skipLine();
    });
  }

  // ---------------------------------------------------------------------------
  // story progression
  available(): MissionDef[] {
    const done = new Set(this.story.completed);
    return MISSIONS.filter((m) => {
      if (done.has(m.id)) return false;
      if (m.ending && done.has('m22a_cleangetaway') || m.ending && done.has('m22b_kingofthecoast')) return false;
      if (!m.requires.every((r) => done.has(r))) return false;
      if (m.requiresFlag && this.story.flags[m.requiresFlag.flag] !== m.requiresFlag.value) return false;
      return true;
    });
  }

  get active(): boolean {
    return this.runner.state === 'running' || this.runner.state === 'failed';
  }

  startMission(m: MissionDef): void {
    const g = this.game;
    this.cleanup();
    this.failEl.classList.remove('open');
    g.hud.big(m.title.toUpperCase(), 'passed', `ACT ${'I'.repeat(m.act)}`, 3);
    g.hud.toast(m.summary, 5000);
    this.runner.start(m);
    g.events.emit('missionStarted', { id: m.id });
  }

  private retry(): void {
    this.failEl.classList.remove('open');
    this.game.inputLocked = false;
    this.runner.retry();
  }

  private quit(): void {
    this.failEl.classList.remove('open');
    this.game.inputLocked = false;
    this.runner.abort();
    this.startCooldown = 6;
  }

  // ---------------------------------------------------------------------------
  // MissionHost implementation
  now(): number {
    return this.game.time;
  }

  appearance(key: AppearanceKey | string): Appearance {
    if (key.startsWith('story:')) {
      const c = CHARACTERS[key.slice(6)];
      if (c) return { ...c.app };
    }
    if (key === 'cop') return policeAppearance(this.rng, false);
    if (key === 'swat') return policeAppearance(this.rng, true);
    const a = randomAppearance(this.rng, {});
    if (key === 'gang') {
      a.shirt = this.rng.pick([0x8a1a1a, 0x1a1a1a, 0x2a2a6a]);
      a.hat = this.rng.chance(0.4) ? 'beanie' : 'cap';
      a.hatColor = 0x101010;
      a.top = this.rng.pick(['tank', 'tee'] as const);
      a.tattoo = 'sleeve';
      a.female = false;
    } else if (key === 'thug') {
      a.top = 'jacket';
      a.jacket = this.rng.pick([0x1a1a1a, 0x2a2a2a, 0x3a2a24]);
      a.pants = 0x1a1a1a;
      a.build = 1.12;
      a.female = false;
      a.hairStyle = this.rng.pick(['none', 'short'] as const);
    } else if (key === 'worker') {
      a.top = 'vest';
      a.shirt = 0xe0a020;
      a.hat = 'cap';
      a.hatColor = 0xe0c020;
    } else if (key === 'biker') {
      a.top = 'jacket';
      a.jacket = 0x101010;
      a.hat = 'helmet';
      a.hatColor = 0x202020;
    }
    return a;
  }

  private tagged(tag: string): Tagged {
    let t = this.tags.get(tag);
    if (!t) this.tags.set(tag, (t = { peds: [], vehicles: [] }));
    return t;
  }

  /** Find a standable ground point near (x,z): not inside buildings. */
  private standPoint(x: number, z: number, r: number): { x: number; y: number; z: number } {
    const ph = this.game.physics;
    for (let i = 0; i < 12; i++) {
      const a = rand.next() * Math.PI * 2, d = i === 0 ? 0 : rand.next() * r;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const hit = ph.raycast(px, 120, pz, 0, -1, 0, 200, GROUPS.rayWorld);
      if (!hit) continue;
      const own = hit.owner?.ref;
      if (own === 'building' || own === 'wall') {
        // allow rooftops only when explicitly asked for (r === 0)
        if (r > 0) continue;
      }
      return { x: px, y: hit.y, z: pz };
    }
    const gy = this.game.world?.groundY(x, z) ?? 0;
    return { x, y: Math.max(gy, 0), z };
  }

  private makePed(tag: string, x: number, z: number, yaw: number, app: string, opts: { weapon?: string; hostile?: boolean; health?: number; armor?: number; state?: string; exact?: boolean; y?: number }): Ped | null {
    const g = this.game;
    const peds = g.peds;
    if (!peds) return null;
    const sp = opts.exact ? this.standPoint(x, z, 0) : this.standPoint(x, z, 3);
    const p = peds.spawn(this.appearance(app), sp.x, opts.y ?? sp.y, sp.z, 'scripted', app.startsWith('story:') ? 'story' : opts.hostile ? 'gang' : 'normal');
    if (!p) return null;
    p.persistent = true;
    p.tag = tag;
    p.yaw = yaw;
    p.groundY = sp.y;
    if (opts.health) p.health = p.maxHealth = opts.health;
    if (opts.armor) p.armor = opts.armor;
    if (opts.weapon) {
      p.weapon = opts.weapon;
      p.held = 'none';
    }
    p.ai.mstate = opts.state ?? 'idle';
    p.ai.home = { x: sp.x, z: sp.z };
    p.ai.homeYaw = yaw;
    if (opts.hostile) this.makeHostile(p);
    this.tagged(tag).peds.push(p);
    return p;
  }

  makeHostile(p: Ped): void {
    p.hostile = true;
    p.archetype = p.archetype === 'story' ? 'story' : 'gang';
    if (!p.weapon) p.weapon = null;
    p.held = p.weapon ? ((p.weapon === 'pistol' ? 'pistol' : p.weapon === 'smg' ? 'smg' : p.weapon === 'shotgun' ? 'shotgun' : 'rifle') as Ped['held']) : 'none';
    p.ai.mstate = 'hostile';
    if (p.state !== 'driving') p.setState('fight');
  }

  spawn(s: Extract<Step, { type: 'spawnVehicle' | 'spawnPed' | 'spawnGroup' }>): void {
    const g = this.game;
    if (s.type === 'spawnPed') {
      this.makePed(s.tag, s.x, s.z, s.yaw ?? 0, s.app, { weapon: s.weapon, hostile: s.hostile, health: s.health, armor: s.armor, state: s.state, exact: true });
      return;
    }
    if (s.type === 'spawnGroup') {
      for (let i = 0; i < s.count; i++) {
        const a = (i / s.count) * Math.PI * 2 + rand.next();
        const r = (s.r ?? 8) * (0.4 + rand.next() * 0.6);
        this.makePed(s.tag, s.x + Math.cos(a) * r, s.z + Math.sin(a) * r, rand.next() * 6.28, s.app, { weapon: s.weapon, hostile: s.hostile, health: s.health, armor: s.armor, state: s.state });
      }
      return;
    }
    const vm = g.vehicles;
    if (!vm) return;
    g.world?.loadAround(s.x, s.z);
    // clear anything parked on the spot
    for (const o of [...vm.vehicles]) if (o.position.distanceTo(_v.set(s.x, o.position.y, s.z)) < 5 && !o.persistent && o.driver?.kind !== 'player') vm.despawn(o);
    const v = vm.spawn(s.def, s.x, s.z, s.yaw ?? 0, { y: s.y, paint: s.paint, role: 'mission', locked: s.locked });
    v.persistent = true;
    v.tag = s.tag;
    if (s.health) v.health.health = v.health.max * s.health;
    if (s.driver) {
      const p = this.makePed(s.driverTag ?? s.tag, s.x, s.z, s.yaw ?? 0, s.driver, { exact: true });
      if (p) {
        p.state = 'driving';
        p.vehicle = v;
        p.setCollision(false);
        v.driver = { kind: 'ped', ref: p };
        v.engineOn = true;
        v.role = 'mission';
      }
    } else {
      v.role = 'mission';
      v.handbrake = true;
    }
    this.tagged(s.tag).vehicles.push(v);
  }

  spawnWave(w: { tag: string; count: number; x: number; z: number; r?: number; app: string; weapon?: string; vehicle?: string }): void {
    const g = this.game;
    if (w.vehicle && g.vehicles) {
      g.world?.loadAround(w.x, w.z);
      const v = g.vehicles.spawn(w.vehicle, w.x, w.z, headingOf(g.player.pos.x - w.x, g.player.pos.z - w.z), { role: 'mission' });
      v.persistent = true;
      v.siren = v.def.siren === true;
      v.lights = true;
      this.tagged(w.tag + '_veh').vehicles.push(v);
    }
    for (let i = 0; i < w.count; i++) {
      const a = (i / w.count) * Math.PI * 2;
      const r = (w.r ?? 6) * (0.3 + rand.next() * 0.7);
      this.makePed(w.tag, w.x + Math.cos(a) * r, w.z + Math.sin(a) * r, 0, w.app, { weapon: w.weapon ?? 'pistol', hostile: true });
    }
  }

  despawn(tag: string): void {
    const t = this.tags.get(tag);
    if (!t) return;
    const g = this.game;
    for (const p of t.peds) {
      this.escorts.delete(p);
      this.passengers.delete(p);
      if (g.peds?.peds.includes(p)) g.peds.despawn(p);
    }
    for (const v of t.vehicles) {
      this.drivers.delete(v);
      if (v.driver?.kind === 'player') {
        v.persistent = false;
        continue;
      }
      if (v.driver?.kind === 'ped' && v.driver.ref instanceof Ped && g.peds?.peds.includes(v.driver.ref)) g.peds.despawn(v.driver.ref);
      g.vehicles?.despawn(v);
    }
    this.tags.delete(tag);
  }

  cleanup(): void {
    for (const tag of Array.from(this.tags.keys())) this.despawn(tag);
    this.drivers.clear();
    this.escorts.clear();
    this.passengers.clear();
    this.markers.clearPickups();
    this.markerPos = null;
    this.routeTarget = null;
    this.target = null;
    this.endDialogue();
    const pol = this.game.police;
    if (pol) {
      pol.wanted.minStars = 0;
      pol.wanted.locked = false;
    }
    this.game.minimap && (this.game.minimap.route = null);
  }

  playerPos(): Vec {
    const p = this.game.player;
    const v = this.game.vctrl?.vehicle;
    const src = v ? v.position : p.pos;
    return { x: src.x, y: src.y, z: src.z };
  }

  playerVehicle(): PlayerVehicleInfo | null {
    const v = this.game.vctrl?.vehicle;
    if (!v) return null;
    return { tag: v.tag, kind: v.def.kind, hot: v.hot, police: v.def.cls === 'police' || v.def.cls === 'swat' };
  }

  aliveCount(tag: string): number {
    const t = this.tags.get(tag);
    if (!t) return 0;
    let n = 0;
    for (const p of t.peds) if (p.alive) n++;
    for (const v of t.vehicles) if (!v.destroyed && t.peds.length === 0) n++;
    return n;
  }

  totalCount(tag: string): number {
    const t = this.tags.get(tag);
    if (!t) return 0;
    return t.peds.length || t.vehicles.length;
  }

  destroyed(tag: string): boolean {
    const t = this.tags.get(tag);
    if (!t || t.vehicles.length === 0) return false;
    return t.vehicles.every((v) => v.destroyed || v.health.state === 'burning' || v.submerged > 2);
  }

  tagPos(tag: string): Vec | null {
    const t = this.tags.get(tag);
    if (!t) return null;
    const v = t.vehicles.find((x) => !x.destroyed) ?? t.vehicles[0];
    if (v) return { x: v.position.x, y: v.position.y, z: v.position.z };
    const p = t.peds.find((x) => x.alive) ?? t.peds[0];
    if (p) {
      const veh = this.passengers.get(p);
      const src = veh ? veh.position : p.pos;
      return { x: src.x, y: src.y, z: src.z };
    }
    return null;
  }

  vehicleHealth(tag: string): number {
    const v = this.tags.get(tag)?.vehicles[0];
    return v ? v.health.fraction : 0;
  }

  objective(text: string | null): void {
    this.game.hud.objectiveText(text);
  }

  help(text: string | null, seconds = 6): void {
    if (text && this.game.touch.isEnabled) text = text.replace(/\(<b>[^)]*<\/b>\)/g, '').replace(/\s\s+/g, ' ');
    this.game.hud.showHelp(text, seconds);
  }

  startDialogue(lines: Line[], shots?: Shot[], letterbox?: boolean): void {
    this.dialogueLines = lines;
    this.dialogueShots = shots ?? [];
    this.lineI = 0;
    this.lineT = 0;
    this.shotI = 0;
    this.shotT = 0;
    this.dialogueActive = true;
    this.cutscene = (letterbox ?? false) || this.dialogueShots.length > 0;
    const g = this.game;
    if (this.cutscene) {
      g.inputLocked = true;
      g.hud.letterbox(true);
      g.cam.mode = 'cutscene';
      g.player.vitals.invulnerable = true;
      this.applyShot();
      g.cam.pos.copy(g.cam.cutPos ?? g.cam.pos);
    }
    this.showLine();
  }

  private showLine(): void {
    const l = this.dialogueLines[this.lineI];
    if (!l) return;
    const secs = (l.dur ?? 1.2 + l.text.length * 0.055) + 0.3;
    if (this.game.settings.data.subtitles || this.cutscene) this.game.hud.subtitleText(l.who, l.text, secs);
    else this.game.audio.say(l.who, l.text, secs);
  }

  private skipLine(): void {
    if (!this.dialogueActive) return;
    this.lineT = 99;
  }

  private applyShot(): void {
    const s = this.dialogueShots[this.shotI];
    const g = this.game;
    if (!s) return;
    if (s.pos && s.look) {
      g.cam.cutPos = new THREE.Vector3(...s.pos);
      g.cam.cutLook = new THREE.Vector3(...s.look);
    } else {
      const c = s.orbit === 'player' || !s.orbit ? this.playerPos() : this.tagPos(s.orbit) ?? this.playerPos();
      let yaw = 0;
      const t = s.orbit && s.orbit !== 'player' ? this.tags.get(s.orbit) : null;
      if (t?.peds[0]) yaw = t.peds[0].yaw;
      else if (t?.vehicles[0]) yaw = t.vehicles[0].yaw;
      else yaw = g.player.yaw;
      const a = yaw + (s.angle ?? 0.6);
      const dist = s.dist ?? 4;
      const h = s.height ?? 1.7;
      g.cam.cutPos = new THREE.Vector3(c.x + Math.sin(a) * dist, c.y + h, c.z + Math.cos(a) * dist);
      g.cam.cutLook = new THREE.Vector3(c.x, c.y + 1.45, c.z);
    }
    g.cam.cutFov = s.fov ?? 50;
  }

  private endDialogue(): void {
    const g = this.game;
    if (this.cutscene) {
      g.inputLocked = false;
      g.hud.letterbox(false);
      g.cam.mode = g.vctrl?.inVehicle ? 'vehicle' : 'foot';
      g.player.vitals.invulnerable = false;
    }
    this.dialogueActive = false;
    this.cutscene = false;
    g.hud.subtitleText(null, null);
  }

  dialogueDone(): boolean {
    return !this.dialogueActive;
  }

  marker(p: { x: number; z: number; y?: number; radius: number } | null): void {
    this.markerPos = p;
  }

  routeTo(p: { x: number; z: number } | null): void {
    this.routeTarget = p;
    this.routeT = 0;
    if (!p && this.game.minimap) this.game.minimap.route = null;
  }

  targetTag(tag: string | null): void {
    this.target = tag;
  }

  setWanted(stars: number, lock: boolean): void {
    const w = this.game.police?.wanted;
    if (!w) return;
    if (stars === 0) {
      w.minStars = 0;
      w.clear();
      w.locked = lock; // e.g. tutorial: crimes don't count
      return;
    }
    w.locked = false;
    w.set(stars);
    w.minStars = lock ? stars : 0;
  }

  wantedStars(): number {
    return this.game.police?.wanted.stars ?? 0;
  }

  timerText(text: string | null): void {
    this.game.hud.timerText(text);
  }

  counterText(text: string | null): void {
    this.game.hud.counterText(text);
  }

  give(weapon: string, ammo: number): void {
    const a = this.game.combat?.arsenal;
    if (!a) return;
    a.give(weapon as WeaponId, ammo);
    this.game.hud.toast(`Received: ${weapon}`, 1800);
  }

  cash(amount: number): void {
    this.game.wallet.add(amount, 'mission');
  }

  armor(amount: number): void {
    this.game.player.vitals.addArmor(amount);
  }

  teleport(x: number, z: number, yaw?: number, y?: number, vehicle?: string): void {
    const g = this.game;
    if (g.vctrl?.inVehicle) g.vctrl.exit(true);
    g.teleport(x, z, yaw ?? g.player.yaw, y);
    if (vehicle && g.vehicles) {
      const v = g.vehicles.spawn(vehicle, x + 4, z, yaw ?? 0, { role: 'mission' });
      v.persistent = true;
      g.vctrl?.enter(v, true);
    }
  }

  setHour(h: number): void {
    this.game.env?.clock.setHour(h);
  }

  setWeather(k: string): void {
    this.game.env?.setWeather(k as WeatherKind, true);
  }

  drive(tag: string, route: [number, number][], speed: number, opts: { loop?: boolean; aggressive?: boolean; flee?: boolean }): void {
    const t = this.tags.get(tag);
    if (!t) return;
    t.vehicles.forEach((v, i) => {
      // convoy: later vehicles follow the same route a little slower
      this.drivers.set(v, new RouteDriver(v, route, speed * (1 - i * 0.03), opts));
      v.engineOn = true;
      v.handbrake = false;
    });
  }

  routeDone(tag: string): boolean {
    const t = this.tags.get(tag);
    if (!t || t.vehicles.length === 0) return false;
    return t.vehicles.some((v) => this.drivers.get(v)?.done === true);
  }

  stopTarget(tag: string): void {
    const t = this.tags.get(tag);
    if (!t) return;
    for (const v of t.vehicles) {
      this.drivers.delete(v);
      v.throttle = 0;
      v.brake = 1;
    }
  }

  pedAction(tag: string, action: string): void {
    const t = this.tags.get(tag);
    if (!t) return;
    const peds = [...t.peds];
    for (const v of t.vehicles) if (v.driver?.kind === 'ped' && v.driver.ref instanceof Ped && !peds.includes(v.driver.ref)) peds.push(v.driver.ref);
    for (const p of peds) {
      switch (action) {
        case 'follow':
        case 'enterPlayerVehicle':
          this.escorts.add(p);
          p.ai.mstate = 'follow';
          break;
        case 'hostile':
        case 'fight':
          if (!p.weapon && p.archetype !== 'story') p.weapon = 'pistol';
          this.makeHostile(p);
          if (p.vehicle) {
            const v = p.vehicle;
            this.drivers.set(v, new RouteDriver(v, [[v.position.x, v.position.z]], v.def.maxSpeed * 0.75, { pursue: true }));
          }
          break;
        case 'flee':
          p.ai.mstate = 'flee';
          p.threat.copy(this.game.player.pos);
          break;
        case 'cower':
        case 'handsup':
        case 'dance':
        case 'idle':
          p.ai.mstate = action;
          break;
        case 'leaveVehicle':
          this.passengers.delete(p);
          break;
      }
    }
  }

  fade(out: boolean, time: number): void {
    this.game.hud.fade(out ? 1 : 0, time * 1000);
  }

  spawnCollectibles(tag: string, items: [number, number][], atTag?: string): void {
    const pts: { x: number; z: number }[] = items.map(([x, z]) => ({ x, z }));
    if (atTag) {
      const t = this.tags.get(atTag);
      if (t) for (const v of t.vehicles) pts.push({ x: v.position.x + 2.5, z: v.position.z + 1 });
    }
    for (const p of pts) {
      const sp = this.standPoint(p.x, p.z, 0);
      this.markers.addPickup(tag, sp.x, sp.y, sp.z);
    }
  }

  collectRemaining(tag: string): number {
    return this.markers.remaining(tag);
  }

  guardsSeePlayer(tag: string, range: number): boolean {
    const t = this.tags.get(tag);
    if (!t) return false;
    const pp = this.game.player.pos;
    const crouch = this.game.player.crouching ? 0.6 : 1;
    for (const p of t.peds) {
      if (!p.alive) continue;
      const d = Math.hypot(pp.x - p.pos.x, pp.z - p.pos.z);
      if (d > range * crouch) continue;
      if (Math.abs(angleDiff(p.yaw, headingOf(pp.x - p.pos.x, pp.z - p.pos.z))) > 1.1 && d > 2.5) continue;
      if (this.game.physics.lineOfSight(p.pos.x, p.pos.y + 1.6, p.pos.z, pp.x, pp.y + 1.2, pp.z, true)) return true;
    }
    return false;
  }

  showChoice(text: string, options: { label: string; value: string }[]): void {
    this.choiceValue = null;
    const g = this.game;
    g.inputLocked = true;
    this.choiceEl.innerHTML = `<div class="toast" style="border-left-color:var(--accent2)">${text}</div>` + options.map((o) => `<button class="btn primary" data-v="${o.value}">${o.label}</button>`).join('');
    this.choiceEl.classList.add('open');
    this.choiceEl.onpointerdown = (e): void => {
      const v = (e.target as HTMLElement).closest('button')?.dataset.v;
      e.stopPropagation();
      if (v) {
        this.choiceValue = v;
        this.choiceEl.classList.remove('open');
        g.inputLocked = false;
      }
    };
  }

  choiceResult(): string | null {
    return this.choiceValue;
  }

  setFlag(flag: string, value: string): void {
    this.story.flags[flag] = value;
  }

  getFlag(flag: string): string | undefined {
    return this.story.flags[flag];
  }

  unlock(what: string, id: string): void {
    const key = `${what}:${id}`;
    if (!this.story.unlocked.includes(key)) this.story.unlocked.push(key);
    this.onUnlock?.(what, id);
  }

  onPassed(m: MissionDef): void {
    const g = this.game;
    if (!this.story.completed.includes(m.id)) this.story.completed.push(m.id);
    if (m.reward > 0) g.wallet.add(m.reward, `Mission: ${m.title}`);
    g.hud.big('MISSION PASSED', 'passed', m.reward > 0 ? `+$${m.reward.toLocaleString()}` : '', 4);
    g.haptic([30, 40, 60]);
    g.events.emit('missionPassed', { id: m.id, reward: m.reward });
    this.cleanupSoon(m);
    this.onStoryChanged?.();
    g.events.emit('saveRequested', { reason: 'mission' });
    if (m.ending) setTimeout(() => this.rollCredits(m.ending!), 2500);
    this.startCooldown = 4;
  }

  private cleanupSoon(m: MissionDef): void {
    // keep mission vehicles the player is using; despawn the rest after a moment
    setTimeout(() => {
      if (this.runner.mission === m && this.runner.state !== 'running') {
        for (const [tag, t] of this.tags) {
          if (t.vehicles.some((v) => v.driver?.kind === 'player')) {
            for (const v of t.vehicles) {
              v.persistent = false;
              v.tag = null;
            }
            this.tags.delete(tag);
            continue;
          }
        }
        this.cleanup();
      }
    }, 2500);
  }

  onFailed(m: MissionDef, reason: string): void {
    const g = this.game;
    g.hud.big('MISSION FAILED', 'failed', reason, 4);
    g.events.emit('missionFailed', { id: m.id, reason });
    this.endDialogue();
    setTimeout(() => {
      if (this.runner.state === 'failed') this.failEl.classList.add('open');
    }, g.respawn.active ? 4200 : 2200);
  }

  onBranch(id: string): void {
    this.pendingBranch = id;
  }

  private rollCredits(ending: 'A' | 'B'): void {
    const el = this.creditsEl;
    const title = ending === 'A' ? 'CLEAN GETAWAY' : 'KING OF THE COAST';
    const epilogue = ending === 'A'
      ? 'Captain Harlan Price was convicted on 214 counts. Nico and Lena Reyes were never seen in Port Solano again.<br>Somewhere past the state line, a garage opened. It does excellent paint jobs.'
      : 'Port Solano has a new owner. The docks run on time, the police look the other way, and Lena Reyes no longer answers her phone.<br>Nico Reyes sleeps in Price\'s villa. He does not sleep well.';
    el.innerHTML = `<div class="box" style="text-align:center;max-width:620px"><h2 style="font-size:34px">${title}</h2><p>${epilogue}</p><h3>CRIMSON COAST</h3><p class="muted">Design, code, art and audio: procedurally generated for this project.<br>Built with three.js, Rapier, miniplex, Howler.js.</p><p class="muted">Thanks for playing. Port Solano is still yours to explore.</p><button class="btn primary" data-a="close">CONTINUE</button></div>`;
    el.classList.add('open');
    el.onpointerdown = (e): void => {
      if ((e.target as HTMLElement).closest('button')) {
        el.classList.remove('open');
        this.game.hud.fade(0, 800);
      }
    };
  }

  // ---------------------------------------------------------------------------
  fixedUpdate(dt: number): void {
    const pp = this.playerPos();
    for (const [v, d] of this.drivers) {
      if (v.destroyed) {
        this.drivers.delete(v);
        continue;
      }
      d.step(dt, pp);
    }
    // mission peds behaviour
    for (const t of this.tags.values()) for (const p of t.peds) this.stepPed(p, dt);
  }

  private stepPed(p: Ped, dt: number): void {
    const g = this.game;
    const peds = g.peds;
    if (!peds || !p.alive) return;
    if (p.state === 'driving' || p.state === 'dead' || p.state === 'down') return;
    if (p.ai.mstate === 'hostile') {
      if (p.state !== 'fight' && p.state !== 'chase') p.setState('fight');
      return; // PedManager + CombatSystem drive hostile peds
    }
    const veh = this.passengers.get(p);
    if (veh) {
      p.pos.copy(veh.position);
      p.sync();
      // get out when the player leaves the vehicle
      if (g.vctrl?.vehicle !== veh && veh.position.distanceTo(g.player.pos) < 8) {
        this.passengers.delete(p);
        veh.toWorld(veh.info.door2, _v);
        p.pos.set(_v.x, g.player.pos.y, _v.z);
        p.prevPos.copy(p.pos);
        p.setCollision(true);
        p.setState('scripted');
      }
      return;
    }
    if (p.state !== 'scripted') {
      if (p.state === 'flee' || p.state === 'walk' || p.state === 'wander' || p.state === 'cower' || p.state === 'hide') p.setState('scripted');
      else return;
    }
    p.prevPos.copy(p.pos);
    const ms = p.ai.mstate as string;
    const pl = g.player;
    if (ms === 'follow') {
      const pv = g.vctrl?.vehicle;
      if (pv && pv.position.distanceTo(p.pos) < 9 && Math.abs(pv.speed) < 3) {
        // board the player's vehicle as passenger
        this.passengers.set(p, pv);
        p.setCollision(false);
        return;
      }
      const tgt = pv ? pv.position : pl.pos;
      const d = Math.hypot(tgt.x - p.pos.x, tgt.z - p.pos.z);
      if (d > 2.4) peds.moveToward(p, tgt.x, tgt.z, d > 8 ? 5.2 : 2.2, dt, true);
      else {
        p.vel.multiplyScalar(0.7);
        p.yaw = headingOf(tgt.x - p.pos.x, tgt.z - p.pos.z);
      }
    } else if (ms === 'patrol') {
      const home = p.ai.home as { x: number; z: number };
      const hy = p.ai.homeYaw as number;
      const k = Math.sin(g.time * 0.25 + p.id) * 7;
      const tx = home.x + Math.sin(hy + Math.PI / 2) * k, tz = home.z + Math.cos(hy + Math.PI / 2) * k;
      peds.moveToward(p, tx, tz, 1.2, dt, true);
    } else if (ms === 'flee') {
      const dx = p.pos.x - p.threat.x, dz = p.pos.z - p.threat.z;
      const d = Math.hypot(dx, dz) || 1;
      peds.moveToward(p, p.pos.x + (dx / d) * 10, p.pos.z + (dz / d) * 10, 5, dt, true);
    } else {
      p.vel.multiplyScalar(0.6);
      const want = ms === 'dance' ? 'dance' : ms === 'talk' ? 'talk' : ms === 'sit' ? 'sit' : ms === 'cower' ? 'cower' : ms === 'handsup' ? 'handsup' : 'none';
      if (want !== 'none' && p.anim.action !== want) p.play(want, 9999);
      if (ms === 'guard' || ms === 'idle') p.yaw = p.ai.homeYaw as number;
      // guards turn to face noises / the player when close
      if ((ms === 'guard' || ms === 'idle') && p.weapon) {
        const d = Math.hypot(pl.pos.x - p.pos.x, pl.pos.z - p.pos.z);
        if (d < 5) p.yaw = headingOf(pl.pos.x - p.pos.x, pl.pos.z - p.pos.z);
      }
    }
    peds.settleGround(p, dt);
    p.sync();
  }

  update(dt: number): void {
    const g = this.game;
    // dialogue progression
    if (this.dialogueActive) {
      this.lineT += dt;
      const l = this.dialogueLines[this.lineI];
      const dur = l ? (l.dur ?? 1.2 + l.text.length * 0.055) : 0;
      if (g.input.pressed('skip') || (this.cutscene && g.input.pressed('attack'))) this.lineT = 99;
      // let a spoken line finish (up to 2.5× its subtitle time) before moving on
      const talking = !!l && g.audio.speaking && this.lineT < dur * 2.5 && this.lineT < 99;
      if (talking) g.hud.extendSubtitle(0.4);
      if (!l || (this.lineT >= dur && !talking)) {
        this.lineI++;
        this.lineT = 0;
        if (this.lineI >= this.dialogueLines.length) this.endDialogue();
        else this.showLine();
      }
      if (this.cutscene && this.dialogueShots.length) {
        this.shotT += dt;
        const s = this.dialogueShots[this.shotI];
        if (s && this.shotT >= s.dur && this.shotI < this.dialogueShots.length - 1) {
          this.shotI++;
          this.shotT = 0;
          this.applyShot();
        }
      }
    }
    // runner
    if (this.runner.state === 'running') this.runner.update(dt);
    if (this.pendingBranch) {
      const id = this.pendingBranch;
      this.pendingBranch = null;
      const m = MISSION_BY_ID[id];
      if (m) setTimeout(() => this.startMission(m), 1500);
    }
    // pickups
    const pp = this.playerPos();
    this.markers.collect(pp.x, pp.y, pp.z, g.vctrl?.inVehicle ? 3.5 : 1.8, () => {
      g.haptic(15);
      g.hud.toast('Picked up', 900);
    });
    // GPS route refresh
    if (this.routeTarget && g.world && g.minimap) {
      this.routeT -= dt;
      if (this.routeT <= 0) {
        this.routeT = 1.5;
        g.minimap.route = g.world.data.graph.route(pp.x, pp.z, this.routeTarget.x, this.routeTarget.z);
      }
    }
    // mission start markers
    this.markers.begin();
    if (this.markerPos) {
      const m = this.markerPos;
      const y = m.y ?? (g.world ? Math.max(g.world.groundY(m.x, m.z), 0) + 0.05 : 0);
      this.markers.beacon(m.x, y, m.z, Math.max(1.5, m.radius * 0.6), 0xffd250);
    }
    if (!this.active && !g.activities?.current && !g.ui.open) {
      this.startCooldown -= dt;
      for (const m of this.available()) {
        const d = Math.hypot(pp.x - m.start.x, pp.z - m.start.z);
        if (d > 160) continue;
        const y = g.world ? Math.max(g.world.groundY(m.start.x, m.start.z), 0.16) : 0;
        this.markers.beacon(m.start.x, y, m.start.z, m.start.radius ?? 3, 0xff4d8a, 6);
        if (d < (m.start.radius ?? 3) && this.startCooldown <= 0 && !g.respawn.active) {
          if ((g.police?.wanted.stars ?? 0) > 0) {
            if (Math.floor(g.time) % 4 === 0) g.hud.toast('Lose the cops before starting a mission', 1200);
            continue;
          }
          const v = g.vctrl?.vehicle;
          if (v && Math.abs(v.speed) > 2) continue;
          this.startMission(m);
          break;
        }
      }
    }
    this.markers.end(dt);
    // render passengers seated
    for (const [p, v] of this.passengers) {
      const seat = v.def.seats[1] ?? v.def.seats[0]!;
      _v.set(seat[0], seat[1] - 0.55, seat[2]).applyQuaternion(v.renderQuat).add(v.renderPos);
      _v2.set(0, 0, 1).applyQuaternion(v.renderQuat);
      this.anim.driving = true;
      this.anim.steer = 0;
      this.anim.time += dt;
      computePose(this.pose, this.anim);
      g.chars.update(p.slot, _v.x, _v.y, _v.z, Math.atan2(_v2.x, _v2.z), this.pose, 'none');
    }
  }

  /** Minimap blips: mission starts, objective, targets, pickups. */
  blips(out: Blip[]): void {
    if (!this.active && !this.game.activities?.current) {
      for (const m of this.available()) {
        const giver = CHARACTERS[m.giver];
        out.push({ x: m.start.x, z: m.start.z, color: '#ff4d8a', shape: 'icon', size: 6, label: (giver?.name ?? m.giver)[0]!.toUpperCase(), pin: m === this.available()[0] });
      }
    }
    if (this.markerPos) out.push({ x: this.markerPos.x, z: this.markerPos.z, color: '#ffd250', shape: 'ring', size: 5, pin: true });
    if (this.target) {
      const t = this.tags.get(this.target);
      if (t) {
        for (const v of t.vehicles) if (!v.destroyed) out.push({ x: v.position.x, z: v.position.z, color: '#ff4d4d', shape: 'triangle', size: 5, pin: true });
        for (const p of t.peds) if (p.alive) out.push({ x: p.pos.x, z: p.pos.z, color: p.hostile ? '#ff4d4d' : '#4dc3ff', shape: 'dot', size: 4, pin: t.peds.length < 3 });
      }
      for (const pk of this.markers.pickupPositions(this.target)) out.push({ x: pk.x, z: pk.z, color: '#7dffa1', shape: 'diamond', size: 4, pin: true });
    }
    // hostile mission peds always visible
    for (const [tag, t] of this.tags) {
      if (tag === this.target) continue;
      for (const p of t.peds) if (p.alive && p.hostile) out.push({ x: p.pos.x, z: p.pos.z, color: '#ff4d4d', shape: 'dot', size: 3.5 });
      for (const p of t.peds) if (p.alive && this.escorts.has(p)) out.push({ x: p.pos.x, z: p.pos.z, color: '#4dc3ff', shape: 'dot', size: 4.5, pin: true });
    }
  }

  /** Save/restore story progress. */
  save(): StoryState {
    return { completed: [...this.story.completed], flags: { ...this.story.flags }, unlocked: [...this.story.unlocked] };
  }
  load(s: StoryState): void {
    this.story.completed = [...(s.completed ?? [])];
    this.story.flags = { ...(s.flags ?? {}) };
    this.story.unlocked = [...(s.unlocked ?? [])];
  }

  /** Debug: jump straight into a mission (`?mission=id`). */
  debugStart(id: string): void {
    const m = MISSION_BY_ID[id];
    if (!m) return;
    const idx = MISSIONS.indexOf(m);
    this.story.completed = MISSIONS.slice(0, idx).map((x) => x.id);
    this.game.teleport(m.start.x, m.start.z, 0);
  }
}
