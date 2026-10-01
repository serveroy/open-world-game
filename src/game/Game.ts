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

/** A pluggable game system. All hooks optional. */
export interface System {
  name: string;
  fixedUpdate?(dt: number): void;
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
    this.controller.fixedUpdate(dt);
    for (const s of this.systems) s.fixedUpdate?.(dt);
    this.physics.step();
  }

  private update(dt: number, alpha: number): void {
    const inp = this.input;
    if (!this.inputLocked) {
      const aimScale = this.controller.aiming ? this.settings.data.aimSensitivity : 1;
      this.cam.look(inp.lookX * aimScale, inp.lookY * aimScale);
    }
    inp.lookX = inp.lookY = 0;
    this.controller.update();
    for (const s of this.systems) s.update?.(dt, alpha);
    const p = this.player;
    const aimStyle = this.controller.aiming ? (p.held === 'none' ? 'melee' : p.held === 'pistol' ? 'pistol' : p.held === 'grenade' || p.held === 'molotov' ? 'throw' : p.held === 'bat' || p.held === 'knife' ? 'melee' : 'rifle') : 'none';
    p.updateVisual(dt, alpha, this.cam.pitch * -0.9 + 0.15, aimStyle);
    if (p.mode === 'foot' || p.mode === 'vault' || p.mode === 'dead' || p.mode === 'ragdoll' || p.mode === 'scripted') {
      _head.copy(p.renderPos);
      _head.y += p.swimming ? 0.9 : p.anim.crouch > 0.5 ? 1.15 : 1.6;
      this.cam.update(dt, _head, p.yaw, Math.hypot(p.vel.x, p.vel.z), { excludeBody: p.body });
    }
    for (const s of this.systems) s.lateUpdate?.(dt);
    this.test?.update(p.renderPos);
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
      `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}  ${this.player.mode}${this.player.swimming ? ' swim' : ''}${this.player.grounded ? ' gnd' : ''}`;
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
    };
  }
}
