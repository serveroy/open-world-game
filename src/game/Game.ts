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
import { CharacterRenderer } from '../characters/CharacterRenderer';
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
  baseMap: HTMLCanvasElement | null = null;
  /** Streaming / simulation focus (player or cutscene camera). */
  readonly focus = new THREE.Vector3();
  ready = false;
  paused = false;
  /** When true gameplay ignores player input (cutscenes, menus, mini-games). */
  inputLocked = false;
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

  constructor(container: HTMLElement) {
    this.container = container;
    const q = params.quality ?? (this.settings.data.quality === 'auto' ? detectQuality() : this.settings.data.quality);
    this.quality = q;
    setLowQualityMaterials(q === 'low');
    this.renderer = new Renderer(container, this.settings, q);
    this.scene = this.renderer.scene;
    this.physics = new Physics();
    this.hud = new Hud(container);
    this.kbm = new KeyboardMouse(this.input, this.renderer.gl.domElement, this.settings);
    this.gamepad = new GamepadSource(this.input, this.settings);
    this.touch = new TouchControls(this.input, this.settings, container);
    container.classList.toggle('touch-on', this.touch.isEnabled);
    this.chars = new CharacterRenderer(this.scene, 72, this.renderer.preset.shadows);
    this.cam = new CameraRig(this.renderer.camera, this.physics);
    this.cam.shakeScale = this.settings.data.screenShake;
    this.player = new Player(this.physics, this.chars, 0, 0.2, 0);
    this.controller = new PlayerController(this);
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
      p.playAction('fall', 1.0);
      this.hud.damageFlash(Math.min(1, speed / 15));
      this.cam.addShake(0.6);
      this.haptic(60);
    };
    this.peds = new PedManager(this);
    this.addSystem(this.peds);
    this.theft = new TheftController(this, this.peds);
    this.addSystem({ name: 'theft', fixedUpdate: (dt) => this.theft!.fixedUpdate(dt), update: () => this.theft!.update() });
    this.vctrl.onTryEnter = (v) => this.theft!.tryEnter(v);
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
    if (!this.paused) {
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

  /** Debug: spawn a vehicle in front of the player. */
  debugSpawn(id: string, enter = false): unknown {
    if (!this.vehicles) return null;
    const p = this.player;
    const v = this.vehicles.spawn(id, p.pos.x + Math.sin(p.yaw) * 6, p.pos.z + Math.cos(p.yaw) * 6, p.yaw, { role: 'parked' });
    if (enter) this.vctrl?.enter(v, true);
    return v.def.name;
  }

  private update(dt: number, alpha: number): void {
    const inp = this.input;
    if (!this.inputLocked) {
      const aimScale = this.controller.aiming ? this.settings.data.aimSensitivity : 1;
      this.cam.look(inp.lookX * aimScale, inp.lookY * aimScale);
    }
    inp.lookX = inp.lookY = 0;
    this.controller.update();
    this.vctrl?.update(dt);
    if (!this.vctrl?.inVehicle) this.hud.speedometer(false);
    for (const s of this.systems) s.update?.(dt, alpha);
    const p = this.player;
    const aimStyle = this.controller.aiming ? (p.held === 'none' ? 'melee' : p.held === 'pistol' ? 'pistol' : p.held === 'grenade' || p.held === 'molotov' ? 'throw' : p.held === 'bat' || p.held === 'knife' ? 'melee' : 'rifle') : 'none';
    if (!(this.vctrl && this.vctrl.inVehicle)) p.updateVisual(dt, alpha, this.cam.pitch * -0.9 + 0.15, aimStyle);
    if (p.mode === 'foot' || p.mode === 'vault' || p.mode === 'dead' || p.mode === 'ragdoll' || p.mode === 'scripted') {
      _head.copy(p.renderPos);
      _head.y += p.swimming ? 0.9 : p.anim.crouch > 0.5 ? 1.15 : 1.6;
      this.cam.update(dt, _head, p.yaw, Math.hypot(p.vel.x, p.vel.z), { excludeBody: p.body });
    }
    for (const s of this.systems) s.lateUpdate?.(dt);
    this.test?.update(p.renderPos);
    if (this.world && this.env) {
      if (p.mode !== 'scripted' || this.cam.mode !== 'cutscene') this.focus.copy(p.renderPos);
      this.world.update(dt, this.focus, this.env.night);
      this.env.update(dt, this.focus, this.renderer.gl);
      this.water?.update(this.renderer.camera, this.time);
      this.minimap?.draw(dt, p.renderPos.x, p.renderPos.z, this.cam.yaw, p.yaw, Math.hypot(p.vel.x, p.vel.z));
      this.hud.clockText(this.env.clock.text());
    }
    this.chars.commit();
    this.hud.vitals(p.vitals.health, p.vitals.maxHealth, p.vitals.armor, p.vitals.stamina, p.swimming ? p.vitals.breath : null);
    this.hud.setUnderwater(this.cam.underwater);
    this.hud.update(dt);
    this.touch.setMode(p.mode === 'vehicle' ? this.touchVehicleMode : 'foot');
    if (params.debug || this.settings.data.showFps) this.hud.debug(this.debugText());
    else this.hud.debug(null);
  }
  touchVehicleMode: 'vehicle' | 'boat' | 'heli' = 'vehicle';

  private updatePaused(dt: number): void {
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

  stats(): Record<string, number | string> {
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
