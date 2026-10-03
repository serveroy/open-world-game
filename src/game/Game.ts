import * as THREE from 'three';
import { Settings, type QualityLevel } from '../core/Settings';
import { params } from '../core/params';
import { EventBus } from '../core/events';
import { Renderer, detectQuality } from '../render/Renderer';
import { setLowQualityMaterials } from '../render/materials';
import { Physics } from '../physics/Physics';
import { Input } from '../input/Input';
import { KeyboardMouse } from '../input/KeyboardMouse';
import { GamepadSource } from '../input/Gamepad';
import { TouchControls } from '../input/TouchControls';
import { Hud } from '../ui/Hud';
import type { RigData } from '../characters/rig/RigData';
import { CharacterRenderer } from '../characters/CharacterRenderer';
import { Lineup } from './Lineup';
import { CameraRig } from '../player/CameraRig';
import { Player } from '../player/Player';
import { PlayerController } from './PlayerController';
import { TestArea } from '../world/TestArea';
import type { GameEvents } from './events';
import { World } from '../world/World';
import { Environment } from '../world/Environment';
import { Water } from '../render/Water';
import { Minimap, renderBaseMap } from '../ui/Minimap';
import { SPAWNS } from '../world/MapData';
import type { WeatherKind } from '../world/TimeOfDay';
import { VehicleManager } from '../vehicles/VehicleManager';
import { VehicleController } from './VehicleController';
import { PedManager } from '../peds/PedManager';
import { TheftController } from './TheftController';
import { CombatSystem } from '../combat/CombatSystem';
import { Wallet } from '../economy/Wallet';
import { Respawn } from './Respawn';
import { PoliceManager } from '../police/PoliceManager';
import type { Blip } from '../ui/Minimap';
import { MissionManager } from '../missions/MissionManager';
import { UIStack } from '../ui/UIStack';
import { ShopUI } from '../ui/ShopUI';
import { Interactions } from './Interactions';
import { Estate } from '../economy/Estate';
import { PlayerStats } from './PlayerStats';
import { Shops } from './Shops';
import { Gps } from './Gps';
import { ActivityManager } from '../activities/ActivityManager';
import { StreetRace, RACES } from '../activities/Race';
import { TaxiJob, DeliveryJob } from '../activities/Jobs';
import { TheftContracts, Rampage } from '../activities/Crime';
import { StreetEvents } from '../activities/StreetEvents';
import { Collectibles } from '../activities/Collectibles';
import { Nightlife } from '../activities/Nightlife';
import { SaveManager } from './SaveManager';
import { Phone } from '../ui/Phone';
import { SettingsUI } from '../ui/SettingsUI';
import { Menus } from '../ui/Menus';
import { buildSigns } from '../world/Signs';
import { AudioSystem } from '../audio/AudioSystem';
import { PostFX } from '../render/PostFX';

/** A pluggable game system. All hooks optional. */
export interface System {
  name: string;
  fixedUpdate?(dt: number): void;
  /** After the physics step (capture transforms, resolve contacts). */
  postStep?(dt: number): void;
  update?(dt: number, alpha: number): void;
  lateUpdate?(dt: number): void;
}

const _head = new THREE.Vector3();

export class Game {
  readonly settings = new Settings();
  readonly events = new EventBus<GameEvents>();
  readonly renderer: Renderer;
  readonly physics: Physics;
  readonly input = new Input();
  readonly kbm: KeyboardMouse;
  readonly gamepad: GamepadSource;
  readonly touch: TouchControls;
  readonly hud: Hud;
  readonly chars: CharacterRenderer;
  readonly cam: CameraRig;
  readonly player: Player;
  readonly controller: PlayerController;
  readonly systems: System[] = [];
  readonly scene: THREE.Scene;
  quality: QualityLevel;
  test: TestArea | null = null;
  world: World | null = null;
  env: Environment | null = null;
  water: Water | null = null;
  minimap: Minimap | null = null;
  vehicles: VehicleManager | null = null;
  vctrl: VehicleController | null = null;
  peds: PedManager | null = null;
  theft: TheftController | null = null;
  combat: CombatSystem | null = null;
  police: PoliceManager | null = null;
  missions: MissionManager | null = null;
  /** Extra minimap blip providers (missions, activities). */
  readonly blipProviders: ((out: Blip[]) => void)[] = [];
  private blipList: Blip[] = [];
  readonly wallet = new Wallet(0);
  readonly respawn: Respawn;
  readonly ui = new UIStack();
  readonly shopUI: ShopUI;
  readonly estate = new Estate();
  readonly stats = new PlayerStats();
  readonly interactions: Interactions;
  readonly gps: Gps;
  readonly saves: SaveManager;
  readonly phone: Phone;
  readonly settingsUI: SettingsUI;
  readonly menus: Menus;
  readonly audio: AudioSystem;
  postfx: PostFX | null = null;
  shops: Shops | null = null;
  activities: ActivityManager | null = null;
  collectibles: Collectibles | null = null;
  nightlife: Nightlife | null = null;
  baseMap: HTMLCanvasElement | null = null;
  /** Streaming / simulation focus (player or cutscene camera). */
  readonly focus = new THREE.Vector3();
  ready = false;
  paused = false;
  /** When true gameplay ignores player input (cutscenes, menus, mini-games). */
  inputLocked = false;
  /** Gameplay input is ignored (scripted lock or any UI screen open). */
  get controlsLocked(): boolean {
    return this.inputLocked || this.ui.open;
  }
  /** Seconds of real play time. */
  time = 0;
  timeScale = 1;
  private acc = 0;
  private last = 0;
  private frameCount = 0;
  private fpsT = 0;
  fps = 60;
  alpha = 0;
  readonly container: HTMLElement;

  constructor(container: HTMLElement, rig: RigData) {
    this.container = container;
    const q = params.quality ?? (this.settings.data.quality === 'auto' ? detectQuality() : this.settings.data.quality);
    this.quality = q;
    setLowQualityMaterials(q === 'low');
    this.renderer = new Renderer(container, this.settings, q);
    this.scene = this.renderer.scene;
    this.physics = new Physics();
    this.hud = new Hud(container);
    const setU = (): void => document.documentElement.style.setProperty('--u', TouchControls.autoScale().toFixed(3));
    setU();
    addEventListener('resize', setU);
    this.kbm = new KeyboardMouse(this.input, this.renderer.gl.domElement, this.settings);
    this.gamepad = new GamepadSource(this.input, this.settings);
    this.touch = new TouchControls(this.input, this.settings, container);
    if (window.self !== window.top || params.framed) document.documentElement.classList.add('framed');
    container.classList.toggle('touch-on', this.touch.isEnabled);
    this.touch.topReserve = () => this.hud.topRightBottom();
    requestAnimationFrame(() => this.touch.applyLayout());
    this.chars = new CharacterRenderer(this.scene, 72, this.renderer.preset.shadows, rig, this.renderer.camera);
    this.cam = new CameraRig(this.renderer.camera, this.physics);
    this.cam.shakeScale = this.settings.data.screenShake;
    this.player = new Player(this.physics, this.chars, 0, 0.2, 0);
    this.controller = new PlayerController(this);
    this.respawn = new Respawn(this);
    this.shopUI = new ShopUI(container, this.ui, () => this.wallet.cash, (m) => this.hud.toast(m, 2200));
    this.interactions = new Interactions(this);
    this.gps = new Gps(this);
    this.saves = new SaveManager(this);
    this.phone = new Phone(this);
    this.settingsUI = new SettingsUI(this);
    this.menus = new Menus(this);
    this.audio = new AudioSystem(this);
    if (this.renderer.preset.bloom) {
      try {
        this.postfx = new PostFX(this.renderer, this.settings);
      } catch {
        this.postfx = null; // no float render targets: plain rendering
      }
    }
    this.ui.onChange = (open) => {
      if (open) this.input.reset();
      this.hud.showHelp(null);
    };
    installColorblindFilters();
    const applyVisual = (s: { colorblind: string; subtitleSize: number }): void => {
      for (const c of ['cb-protanopia', 'cb-deuteranopia', 'cb-tritanopia']) container.classList.toggle(c, c === `cb-${s.colorblind}`);
      document.documentElement.style.setProperty('--sub-scale', String(s.subtitleSize));
    };
    applyVisual(this.settings.data);
    this.settings.onChange(applyVisual);
    this.wallet.onChange = (cash, delta) => {
      this.hud.setCash(cash);
      if (delta !== 0) this.events.emit('cashChanged', { amount: cash, delta });
    };
    this.player.onLanded = (h) => {
      if (h > 4.5) {
        const dmg = (h - 4.5) * 12;
        this.player.vitals.damage(dmg, true);
        this.hud.damageFlash(Math.min(1, dmg / 30));
        this.cam.addShake(Math.min(1, h / 10));
        this.haptic(40);
      }
    };
    this.settings.onChange((s) => {
      this.cam.shakeScale = s.screenShake;
      document.documentElement.style.setProperty('--sub-scale', String(s.subtitleSize));
    });
    addEventListener('blur', () => this.input.reset());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.events.emit('appHidden', {});
    });
  }

  haptic(ms: number | number[]): void {
    if (this.settings.data.haptics && this.input.lastDevice === 'touch') navigator.vibrate?.(ms);
    if (this.input.lastDevice === 'gamepad') this.gamepad.rumble(0.6, typeof ms === 'number' ? ms : 120);
  }

  /** Build the M1 sandbox. */
  setupTestArea(): void {
    this.test = new TestArea(this.scene, this.physics, this.renderer.preset.shadows);
    this.player.teleport(0, 0.05, 0, 0);
    this.cam.snapBehind(0);
  }

  /** Build the full open world (called during the loading screen). */
  async setupWorld(progress: (p: number, msg: string) => Promise<void>): Promise<void> {
    const pr = this.renderer.preset;
    const low = this.quality === 'low';
    let last = 0;
    const tick = (p: number, msg: string): void => {
      // world construction is synchronous; we only update the bar text when it moves a lot
      if (p - last > 0.05) {
        last = p;
        void progress(0.3 + p * 0.55, msg);
      }
    };
    await progress(0.32, 'Shaping terrain');
    this.world = new World(this.scene, this.physics, params.seed, { radius: pr.viewRadiusChunks, low, shadows: pr.shadows && this.settings.data.shadows }, tick);
    await progress(0.86, 'Filling the sea');
    const signs = buildSigns(this.world.data);
    if (signs) this.scene.add(signs);
    this.water = new Water(this.scene, (x, z) => this.world!.terrain.sample(x, z));
    this.env = new Environment(this.scene, this.renderer.camera, pr.shadows && this.settings.data.shadows, pr.shadowMapSize, !low, this.water, this.settings.data.dayLengthMinutes);
    if (params.time !== null) this.env.clock.setHour(params.time);
    if (params.weather) this.env.setWeather(params.weather as WeatherKind, true);
    await progress(0.9, 'Drawing maps');
    this.baseMap = renderBaseMap(this.world.data);
    this.minimap = new Minimap(this.hud.minimapWrap, this.baseMap);
    this.world.onDistrict = (_id, name) => this.hud.zone(name);
    const sp = SPAWNS.start;
    const y = this.world.groundY(sp.x, sp.z);
    this.player.teleport(sp.x, Math.max(y, 0.2) + 0.1, sp.z, sp.yaw);
    this.cam.snapBehind(sp.yaw);
    await progress(0.93, 'Streaming Port Solano');
    this.world.loadAround(sp.x, sp.z);
    this.vehicles = new VehicleManager(this);
    this.vctrl = new VehicleController(this, this.vehicles);
    this.addSystem(this.vehicles);
    this.vehicles.humans = () => {
      const p = this.player;
      return p.mode === 'foot' || p.mode === 'scripted' || p.mode === 'vault' ? [{ x: p.pos.x, y: p.pos.y + 0.9, z: p.pos.z, radius: 0.35, ref: p }] : [];
    };
    this.vehicles.onHitHuman = (v, h, speed) => {
      if (h.ref !== this.player) return;
      const p = this.player;
      if (p.vitals.invulnerable || this.hitCooldown > 0) return;
      this.hitCooldown = 0.8;
      const lv = v.body.linvel();
      p.vel.set(lv.x * 0.8 + (p.pos.x - v.position.x) * 2, 3 + speed * 0.15, lv.z * 0.8 + (p.pos.z - v.position.z) * 2);
      p.grounded = false;
      p.vitals.damage(speed * 2.6);
      if (speed > 7 && this.combat) this.combat.ragdollPlayer(new THREE.Vector3(lv.x * 0.6, 2 + speed * 0.2, lv.z * 0.6), 2.4);
      else p.playAction('fall', 1.0);
      this.hud.damageFlash(Math.min(1, speed / 15));
      this.cam.addShake(0.6);
      this.haptic(60);
    };
    this.peds = new PedManager(this);
    this.addSystem(this.peds);
    this.theft = new TheftController(this, this.peds);
    this.addSystem({ name: 'theft', fixedUpdate: (dt) => this.theft!.fixedUpdate(dt), update: () => this.theft!.update() });
    this.vctrl.onTryEnter = (v) => this.theft!.tryEnter(v);
    this.combat = new CombatSystem(this);
    this.addSystem(this.combat);
    this.peds.onPedDespawn = (pd) => this.combat?.ragdolls.remove(pd.slot);
    this.police = new PoliceManager(this);
    this.addSystem(this.police);
    this.respawn.onRespawn = () => this.police?.reset();
    this.missions = new MissionManager(this);
    this.addSystem(this.missions);
    this.missions.onUnlock = (what, id) => {
      if (what === 'property') {
        const granted = this.estate.unlock(id, (this.env?.clock.totalHours ?? 0) / 24);
        if (granted) this.hud.toast(`New safehouse: ${id.replace('safehouse_', '').replace(/^./, (c) => c.toUpperCase())} — sleep there to save`, 3500);
        else this.hud.toast('A new property is on the market', 2500);
      } else if (what === 'contact') this.hud.toast(`New contact added to your phone`, 2500);
      else if (what === 'shop') this.hud.toast('A new shop is open for business', 2500);
    };
    // economy, side activities, saves
    this.addSystem(this.interactions);
    this.addSystem(this.gps);
    this.shops = new Shops(this);
    const acts = new ActivityManager(this);
    this.activities = acts;
    for (const r of RACES) acts.add(new StreetRace(acts, r));
    acts.add(new TaxiJob(acts));
    acts.add(new DeliveryJob(acts));
    acts.add(new TheftContracts(acts));
    acts.add(new Rampage(acts));
    acts.add(new StreetEvents(acts));
    this.addSystem(acts);
    this.collectibles = new Collectibles(this);
    this.addSystem(this.collectibles);
    this.nightlife = new Nightlife(this);
    this.addSystem({ name: 'nightlife', update: (dt) => this.nightlife!.update(dt) });
    this.addSystem(this.saves);
    this.audio.attach();
    this.events.on('pedKilled', (e) => {
      if (!e.byPlayer) return;
      this.stats.inc('kills');
      if (e.cop) this.stats.inc('copKills');
    });
    this.events.on('vehicleEntered', (e) => e.stolen && this.stats.inc('carsStolen'));
    this.events.on('vehicleDestroyed', (e) => e.byPlayer && this.stats.inc('carsDestroyed'));
    this.events.on('shot', (e) => e.byPlayer && this.stats.inc('shots'));
    this.events.on('playerBusted', () => this.stats.inc('busted'));
    this.events.on('playerDied', () => this.stats.inc('wasted'));
    this.events.on('missionPassed', () => this.stats.inc('missions'));
    if (params.mission) this.missions.debugStart(params.mission);
    this.peds.onPedAttack = (ped) => {
      const p = this.player;
      if (p.mode !== 'foot' || p.pos.distanceTo(ped.pos) > 1.7) return;
      p.vitals.damage(5 + Math.random() * 4);
      this.hud.damageFlash(0.35);
      this.cam.addShake(0.15);
      this.haptic(25);
    };
    this.settings.onChange((s) => {
      if (this.env) this.env.clock.dayLengthMinutes = s.dayLengthMinutes;
    });
  }

  /** Teleport player and stream the destination synchronously. */
  teleport(x: number, z: number, yaw = this.player.yaw, y?: number): void {
    this.world?.loadAround(x, z);
    const gy = y ?? Math.max(this.world ? this.world.groundY(x, z) : 0, 0) + 0.3;
    const v = this.vctrl?.vehicle;
    if (v) {
      v.teleport(x, gy + 0.3, z, yaw);
      this.cam.snapBehind(yaw);
      return;
    }
    this.player.teleport(x, gy, z, yaw);
    this.cam.snapBehind(yaw);
  }

  /** Debug: a row of animated characters in front of the player (visual QA). */
  lineup(seed = 7): Lineup {
    const l = new Lineup(this, seed);
    this.addSystem(l);
    return l;
  }

  addSystem(s: System): void {
    this.systems.push(s);
  }

  start(): void {
    this.ready = true;
    this.last = performance.now();
    this.renderer.gl.setAnimationLoop((t) => this.frame(t));
  }

  private frame(t: number): void {
    let dt = (t - this.last) / 1000;
    this.last = t;
    if (!(dt > 0)) dt = 1 / 60;
    if (this.settings.data.fpsCap === 30 && dt < 1 / 32 && this.acc + dt < 1 / 30) {
      // frame skipping for 30fps cap: accumulate without rendering
      this.acc += dt;
      return;
    }
    dt = Math.min(dt, 0.1);
    this.renderer.trackFrame(dt * 1000);
    this.frameCount++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frameCount / this.fpsT;
      this.frameCount = 0;
      this.fpsT = 0;
    }
    this.kbm.poll();
    this.gamepad.poll(dt);
    const sdt = dt * this.timeScale;
    if (!this.paused && !this.ui.pausing) {
      const fixed = this.physics.fixedDt;
      this.acc += sdt;
      let steps = 0;
      while (this.acc >= fixed && steps < 4) {
        this.fixedUpdate(fixed);
        this.acc -= fixed;
        steps++;
        this.input.markConsumed();
      }
      if (steps === 4) this.acc = 0;
      this.alpha = this.acc / fixed;
      this.time += sdt;
      this.update(sdt, this.alpha);
    } else {
      this.input.markConsumed();
      this.updatePaused(dt);
    }
    this.renderer.render(dt);
    this.input.endFrame();
  }

  private fixedUpdate(dt: number): void {
    if (this.hitCooldown > 0) this.hitCooldown -= dt;
    this.controller.fixedUpdate(dt);
    this.vctrl?.fixedUpdate(dt);
    for (const s of this.systems) s.fixedUpdate?.(dt);
    this.physics.step();
    for (const s of this.systems) s.postStep?.(dt);
  }
  hitCooldown = 0;

  /** Debug: set wanted level. */
  debugWanted(stars: number): void {
    this.police?.wanted.set(stars);
  }

  /** Debug: give every weapon with ammo. */
  debugArm(): void {
    const a = this.combat?.arsenal;
    if (!a) return;
    for (const id of ['bat', 'knife', 'pistol', 'smg', 'shotgun', 'rifle', 'sniper', 'grenade', 'molotov'] as const) a.give(id, 999);
  }

  /** Debug: spawn a vehicle in front of the player. */
  debugSpawn(id: string, enter = false): unknown {
    if (!this.vehicles) return null;
    const p = this.player;
    const v = this.vehicles.spawn(id, p.pos.x + Math.sin(p.yaw) * 6, p.pos.z + Math.cos(p.yaw) * 6, p.yaw, { role: 'parked' });
    if (enter) this.vctrl?.enter(v, true);
    return v.def.name;
  }

  /** Menus / phone / pause input (runs paused or not). */
  private updateUI(dt: number): void {
    if (this.ui.open) {
      this.phone.update();
      this.ui.poll(this.input, dt);
    } else {
      this.menus.update();
      if (!this.ui.open) this.phone.update();
    }
  }

  private update(dt: number, alpha: number): void {
    const inp = this.input;
    this.chars.beginFrame(dt);
    inp.inVehicle = !!this.vctrl?.inVehicle;
    this.updateUI(dt);
    const wheelOpen = this.combat?.wheel.open ?? false;
    if (!this.controlsLocked && !wheelOpen) {
      const aimScale = this.controller.aiming ? this.settings.data.aimSensitivity : 1;
      this.cam.look(inp.lookX * aimScale, inp.lookY * aimScale);
      inp.lookX = inp.lookY = 0;
    }
    this.controller.update();
    this.vctrl?.update(dt);
    if (!this.vctrl?.inVehicle) this.hud.speedometer(false);
    for (const s of this.systems) s.update?.(dt, alpha);
    const p = this.player;
    const aimStyle = this.controller.aiming ? (p.held === 'none' ? 'melee' : p.held === 'pistol' ? 'pistol' : p.held === 'grenade' || p.held === 'molotov' ? 'throw' : p.held === 'bat' || p.held === 'knife' ? 'melee' : 'rifle') : 'none';
    if (!(this.vctrl && this.vctrl.inVehicle)) p.updateVisual(dt, alpha, this.cam.pitch * -0.9 + 0.15, aimStyle);
    if (this.cam.mode === 'scope') this.chars.hide(p.slot);
    if (p.mode === 'ragdoll' || p.mode === 'dead') {
      const rd = this.combat?.ragdolls.of(p.slot);
      if (rd) {
        rd.position(p.renderPos);
        p.pos.copy(p.renderPos);
        p.prevPos.copy(p.pos);
      }
    }
    if (p.mode === 'foot' || p.mode === 'vault' || p.mode === 'dead' || p.mode === 'ragdoll' || p.mode === 'scripted') {
      _head.copy(p.renderPos);
      _head.y += p.swimming ? 0.9 : p.anim.crouch > 0.5 ? 1.15 : 1.6;
      this.cam.update(dt, _head, p.yaw, Math.hypot(p.vel.x, p.vel.z), { excludeBody: p.body });
    }
    inp.lookX = inp.lookY = 0;
    for (const s of this.systems) s.lateUpdate?.(dt);
    // death check
    if (p.vitals.dead && !this.respawn.active) this.respawn.wasted();
    this.respawn.update(dt);
    this.test?.update(p.renderPos);
    if (this.world && this.env) {
      if (p.mode !== 'scripted' || this.cam.mode !== 'cutscene') this.focus.copy(p.renderPos);
      this.world.update(dt, this.focus, this.env.night);
      this.env.update(dt, this.focus, this.renderer.gl);
      this.water?.update(this.renderer.camera, this.time);
      if (this.minimap) {
        const bl = this.blipList;
        bl.length = 0;
        this.police?.blips(bl);
        for (const f of this.blipProviders) f(bl);
        this.minimap.blips = bl;
        const sp = this.vctrl?.vehicle ? Math.abs(this.vctrl.vehicle.speed) : Math.hypot(p.vel.x, p.vel.z);
        this.minimap.draw(dt, p.renderPos.x, p.renderPos.z, this.cam.yaw, p.yaw, sp);
      }
      this.hud.clockText(this.env.clock.text());
    }
    this.chars.commit();
    this.hud.vitals(p.vitals.health, p.vitals.maxHealth, p.vitals.armor, p.vitals.stamina, p.swimming ? p.vitals.breath : null);
    this.hud.setUnderwater(this.cam.underwater);
    this.audio.update(dt);
    if (this.postfx && this.env) {
      this.postfx.setNight(this.env.night);
      this.postfx.setHurt(p.vitals.health < 30 && p.mode !== 'dead' ? (1 - p.vitals.health / 30) * (0.6 + 0.4 * Math.sin(this.time * 6)) : 0);
    }
    this.hud.update(dt);
    this.touch.setMode(this.ui.open && !this.touch.editMode ? 'hidden' : p.mode === 'vehicle' ? this.touchVehicleMode : 'foot');
    if (p.mode === 'foot' && !this.ui.open) this.stats.inc('distanceFoot', Math.hypot(p.vel.x, p.vel.z) * dt);
    else if (this.vctrl?.vehicle) this.stats.inc('distanceDriven', Math.abs(this.vctrl.vehicle.speed) * dt);
    if (params.debug || this.settings.data.showFps) this.hud.debug(this.debugText());
    else this.hud.debug(null);
  }
  touchVehicleMode: 'vehicle' | 'boat' | 'heli' = 'vehicle';

  private updatePaused(dt: number): void {
    this.chars.beginFrame(0);
    this.updateUI(dt);
    this.menus.updateTitle(dt);
    // keep sky / lighting / water alive behind menus
    if (this.world && this.env) {
      this.focus.copy(this.player.renderPos);
      this.env.update(0, this.focus, this.renderer.gl);
      this.water?.update(this.renderer.camera, this.time);
    }
    this.touch.setMode(this.ui.open && !this.touch.editMode ? 'hidden' : 'foot');
    this.chars.commit();
    this.audio.update(dt);
    this.hud.update(dt);
  }

  debugText(): string {
    const info = this.renderer.gl.info;
    const p = this.player.pos;
    return `FPS ${this.fps.toFixed(0)}  ${this.quality.toUpperCase()}  res×${this.renderer.resolutionScale.toFixed(2)} pr ${this.renderer.pixelRatio.toFixed(2)}\n` +
      `draws ${info.render.calls}  tris ${(info.render.triangles / 1000).toFixed(0)}k  geo ${info.memory.geometries} tex ${info.memory.textures}\n` +
      `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  ${this.player.mode}${this.player.swimming ? ' swim' : ''}${this.player.grounded ? ' gnd' : ''}\n` +
      `chunks ${this.world?.chunkCount ?? 0}  ${this.env ? this.env.clock.text() + ' ' + this.env.weather.target : ''}`;
  }

  perf(): Record<string, number | string> {
    const info = this.renderer.gl.info;
    return {
      fps: Math.round(this.fps),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      quality: this.quality,
      x: +this.player.pos.x.toFixed(1),
      y: +this.player.pos.y.toFixed(1),
      z: +this.player.pos.z.toFixed(1),
      mode: this.player.mode,
      chunks: this.world?.chunkCount ?? 0,
      time: this.env?.clock.text() ?? '',
    };
  }
}

/** SVG colour-matrix filters used by the colour-blind CSS modes (daltonisation approximations). */
function installColorblindFilters(): void {
  if (document.getElementById('cb-filters')) return;
  // Assistive matrices: push confusable hues apart so red/green (or blue/yellow) stay distinct.
  const assist: Record<string, string> = {
    protanopia: '1 0 0 0 0  0.7 0.3 0 0 0  0.7 0 0.3 0 0  0 0 0 1 0',
    deuteranopia: '0.8 0.2 0 0 0  0 1 0 0 0  0 0.7 0.3 0 0  0 0 0 1 0',
    tritanopia: '1 0 0 0 0  0 0.8 0.2 0 0  0 0 1 0 0  0 0 0 1 0',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = 'cb-filters';
  svg.setAttribute('width', '0');
  svg.setAttribute('height', '0');
  svg.style.position = 'absolute';
  svg.innerHTML = Object.entries(assist).map(([k, v]) => `<filter id="cb-${k}" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${v}"/></filter>`).join('');
  document.body.appendChild(svg);
}
