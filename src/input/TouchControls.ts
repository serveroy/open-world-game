import { Input, SOURCE_TOUCH, type Action } from './Input';
import type { Settings } from '../core/Settings';

export type TouchMode = 'foot' | 'vehicle' | 'heli' | 'boat' | 'hidden';

interface ButtonDef {
  id: string;
  action: Action;
  label: string;
  /** Anchor from bottom-right (or bottom-left when `left`), in px at scale 1. */
  right: number;
  bottom: number;
  size: number;
  modes: TouchMode[];
  left?: boolean;
  top?: boolean;
  /** Contextual buttons start hidden; game toggles via `setContext`. */
  contextual?: boolean;
  toggle?: boolean;
}

const B = (d: ButtonDef): ButtonDef => d;
export const TOUCH_BUTTONS: ButtonDef[] = [
  // on foot
  B({ id: 'attack', action: 'attack', label: '✊', right: 30, bottom: 120, size: 78, modes: ['foot', 'vehicle', 'boat', 'heli'] }),
  B({ id: 'aim', action: 'aim', label: '◎', right: 120, bottom: 190, size: 62, modes: ['foot', 'vehicle'], toggle: false }),
  B({ id: 'jump', action: 'jump', label: '⤒', right: 126, bottom: 36, size: 64, modes: ['foot'] }),
  B({ id: 'sprint', action: 'sprint', label: '»', right: 30, bottom: 30, size: 72, modes: ['foot'] }),
  B({ id: 'enter', action: 'enter', label: 'ENTER', right: 210, bottom: 120, size: 66, modes: ['foot'], contextual: true }),
  B({ id: 'exit', action: 'enter', label: 'EXIT', right: 30, bottom: 130, size: 52, modes: ['vehicle', 'boat', 'heli'], top: true }),
  B({ id: 'reload', action: 'reload', label: '⟳', right: 200, bottom: 210, size: 50, modes: ['foot'], contextual: true }),
  B({ id: 'cover', action: 'cover', label: '▣', right: 210, bottom: 40, size: 54, modes: ['foot'] }),
  B({ id: 'interact', action: 'interact', label: 'USE', right: 290, bottom: 110, size: 62, modes: ['foot', 'vehicle'], contextual: true }),
  B({ id: 'wheel', action: 'wheel', label: '⊕', right: 30, bottom: 210, size: 54, modes: ['foot', 'vehicle'] }),
  B({ id: 'switchTarget', action: 'switchTarget', label: '⇆', right: 104, bottom: 270, size: 46, modes: ['foot'], contextual: true }),
  // vehicles
  B({ id: 'gas', action: 'gas', label: '▲', right: 30, bottom: 26, size: 92, modes: ['vehicle', 'boat'] }),
  B({ id: 'brake', action: 'brake', label: '▼', right: 140, bottom: 26, size: 76, modes: ['vehicle', 'boat'] }),
  B({ id: 'handbrake', action: 'handbrake', label: 'HB', right: 236, bottom: 30, size: 60, modes: ['vehicle'] }),
  B({ id: 'horn', action: 'horn', label: '📯', right: 236, bottom: 110, size: 50, modes: ['vehicle', 'boat'] }),
  B({ id: 'camera', action: 'camera', label: '🎥', right: 138, bottom: 30, size: 44, modes: ['vehicle', 'boat', 'heli', 'foot'], left: true, top: true }),
  B({ id: 'radio', action: 'radio', label: '📻', right: 192, bottom: 30, size: 44, modes: ['vehicle', 'boat', 'heli'], left: true, top: true }),
  B({ id: 'ascend', action: 'ascend', label: '⇧', right: 30, bottom: 40, size: 84, modes: ['heli'] }),
  B({ id: 'descend', action: 'descend', label: '⇩', right: 130, bottom: 30, size: 70, modes: ['heli'] }),
  // always
  B({ id: 'phone', action: 'phone', label: '📱', right: 30, bottom: 30, size: 44, modes: ['foot', 'vehicle', 'boat', 'heli'], left: true, top: true }),
  B({ id: 'pause', action: 'pause', label: 'II', right: 84, bottom: 30, size: 44, modes: ['foot', 'vehicle', 'boat', 'heli'], left: true, top: true }),
];

/**
 * On-screen touch controls: floating joystick (left), look-drag (right), contextual buttons.
 * Uses Pointer Events so it also works with a mouse in desktop browsers for testing.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  private stickBase: HTMLDivElement;
  private stickKnob: HTMLDivElement;
  private buttons = new Map<string, HTMLDivElement>();
  private stickId: number | null = null;
  private stickOrigin = { x: 0, y: 0 };
  private lookIds = new Map<number, { x: number; y: number; t: number; sx: number }>();
  private mode: TouchMode = 'foot';
  private context = new Set<string>();
  private enabled = false;
  editMode = false;

  constructor(private input: Input, private settings: Settings, parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'touch-root';
    parent.appendChild(this.root);
    const zone = document.createElement('div');
    zone.className = 'touch-zone';
    this.root.appendChild(zone);
    this.stickBase = document.createElement('div');
    this.stickBase.className = 'stick-base';
    this.stickKnob = document.createElement('div');
    this.stickKnob.className = 'stick-knob';
    this.stickBase.appendChild(this.stickKnob);
    this.root.appendChild(this.stickBase);
    zone.addEventListener('pointerdown', this.onZoneDown);
    addEventListener('pointermove', this.onMove, { passive: false });
    addEventListener('pointerup', this.onUp);
    addEventListener('pointercancel', this.onUp);
    for (const def of TOUCH_BUTTONS) this.makeButton(def);
    this.applyLayout();
    settings.onChange(() => this.applyLayout());
    const coarse = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    this.setEnabled(coarse);
    addEventListener('touchstart', () => {
      if (!this.enabled) this.setEnabled(true);
      this.input.lastDevice = 'touch';
    }, { passive: true });
    addEventListener('keydown', () => {
      if (this.enabled && !matchMedia('(pointer: coarse)').matches) this.setEnabled(false);
    });
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.root.style.display = on ? '' : 'none';
    if (!on) this.releaseAll();
  }

  setMode(mode: TouchMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.releaseAll();
    this.refreshVisibility();
  }

  /** Show/hide a contextual button (e.g. 'enter' when near a car). */
  setContext(id: string, visible: boolean, label?: string): void {
    const had = this.context.has(id);
    if (visible) this.context.add(id);
    else this.context.delete(id);
    const el = this.buttons.get(id);
    if (el && label !== undefined && el.dataset.label !== label) {
      el.dataset.label = label;
      el.textContent = label;
    }
    if (had !== visible) this.refreshVisibility();
  }

  setLabel(id: string, label: string): void {
    const el = this.buttons.get(id);
    if (el && el.dataset.label !== label) {
      el.dataset.label = label;
      el.textContent = label;
    }
  }

  private refreshVisibility(): void {
    for (const def of TOUCH_BUTTONS) {
      const el = this.buttons.get(def.id)!;
      const show = def.modes.includes(this.mode) && (!def.contextual || this.context.has(def.id) || this.editMode);
      el.style.display = show ? '' : 'none';
    }
  }

  private makeButton(def: ButtonDef): void {
    const el = document.createElement('div');
    el.className = 'tbtn';
    el.dataset.id = def.id;
    el.dataset.label = def.label;
    el.textContent = def.label;
    let pid: number | null = null;
    let drag: { x: number; y: number; ox: number; oy: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (this.editMode) {
        const off = this.settings.data.hud.offsets[def.id] ?? [0, 0];
        drag = { x: e.clientX, y: e.clientY, ox: off[0], oy: off[1] };
        el.setPointerCapture(e.pointerId);
        return;
      }
      pid = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add('down');
      this.input.setAction(def.action, true, SOURCE_TOUCH);
      this.input.lastDevice = 'touch';
      if (this.settings.data.haptics) navigator.vibrate?.(8);
    });
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        const leftSide = this.settings.data.hud.leftHanded ? !def.left : !!def.left;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        this.settings.data.hud.offsets[def.id] = [drag.ox + (leftSide ? dx : -dx), drag.oy + (def.top ? dy : -dy)];
        this.applyLayout();
      }
    });
    const up = (e: PointerEvent): void => {
      if (drag) {
        drag = null;
        this.settings.save();
        return;
      }
      if (pid !== e.pointerId) return;
      pid = null;
      el.classList.remove('down');
      this.input.setAction(def.action, false, SOURCE_TOUCH);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.root.appendChild(el);
    this.buttons.set(def.id, el);
  }

  applyLayout(): void {
    const hud = this.settings.data.hud;
    const s = hud.buttonScale;
    for (const def of TOUCH_BUTTONS) {
      const el = this.buttons.get(def.id)!;
      const off = hud.offsets[def.id] ?? [0, 0];
      const leftSide = hud.leftHanded ? !def.left : !!def.left;
      const size = def.size * s;
      el.style.width = el.style.height = `${size}px`;
      el.style.fontSize = `${Math.max(11, size * (def.label.length > 2 ? 0.22 : 0.42))}px`;
      el.style.left = el.style.right = el.style.top = el.style.bottom = '';
      const h = `calc(${def.right * s + off[0]}px + env(safe-area-inset-${leftSide ? 'left' : 'right'}))`;
      const v = `calc(${def.bottom * s + off[1]}px + env(safe-area-inset-${def.top ? 'top' : 'bottom'}))`;
      if (leftSide) el.style.left = h;
      else el.style.right = h;
      if (def.top) el.style.top = v;
      else el.style.bottom = v;
      el.style.opacity = String(hud.opacity);
    }
    this.refreshVisibility();
  }

  private onZoneDown = (e: PointerEvent): void => {
    if (this.editMode) return;
    e.preventDefault();
    const leftHalf = this.settings.data.hud.leftHanded ? e.clientX > innerWidth * 0.55 : e.clientX < innerWidth * 0.45;
    this.input.lastDevice = 'touch';
    if (leftHalf && this.stickId === null && this.mode !== 'hidden') {
      this.stickId = e.pointerId;
      this.stickOrigin = { x: e.clientX, y: e.clientY };
      this.stickBase.style.left = `${e.clientX}px`;
      this.stickBase.style.top = `${e.clientY}px`;
      this.stickBase.classList.add('active');
      this.stickKnob.style.transform = 'translate(-50%, -50%)';
    } else {
      this.lookIds.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now(), sx: e.clientX });
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      const r = 56 * this.settings.data.hud.buttonScale;
      let dx = e.clientX - this.stickOrigin.x;
      let dy = e.clientY - this.stickOrigin.y;
      const len = Math.hypot(dx, dy);
      if (len > r) {
        // drag the base along so the stick never "sticks"
        this.stickOrigin.x += (dx / len) * (len - r);
        this.stickOrigin.y += (dy / len) * (len - r);
        this.stickBase.style.left = `${this.stickOrigin.x}px`;
        this.stickBase.style.top = `${this.stickOrigin.y}px`;
        dx = e.clientX - this.stickOrigin.x;
        dy = e.clientY - this.stickOrigin.y;
      }
      this.stickKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const nx = dx / r, ny = dy / r;
      const m = Math.hypot(nx, ny);
      const dead = 0.12;
      const k = m < dead ? 0 : Math.min(1, (m - dead) / (1 - dead)) / (m || 1);
      this.input.moveX = nx * k;
      this.input.moveY = -ny * k;
      // pushing the stick far forward on foot = sprint
      this.input.setAction('sprint', this.mode === 'foot' && m > 1.0 && -ny > 0.85, 16);
      return;
    }
    const l = this.lookIds.get(e.pointerId);
    if (l) {
      const sens = 0.0055 * this.settings.data.lookSensitivity;
      this.input.lookX += (e.clientX - l.x) * sens;
      this.input.lookY += (e.clientY - l.y) * sens * (this.settings.data.invertY ? -1 : 1);
      l.x = e.clientX;
      l.y = e.clientY;
    }
  };

  private onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      this.stickId = null;
      this.stickBase.classList.remove('active');
      this.input.moveX = this.input.moveY = 0;
      this.input.setAction('sprint', false, 16);
    }
    const l = this.lookIds.get(e.pointerId);
    if (l) {
      const dt = performance.now() - l.t;
      const dx = e.clientX - l.sx;
      if (dt < 260 && Math.abs(dx) > 50) {
        this.input.swipeX = dx;
        this.input.tap('switchTarget');
      }
      this.lookIds.delete(e.pointerId);
    }
  };

  releaseAll(): void {
    for (const def of TOUCH_BUTTONS) {
      this.input.setAction(def.action, false, SOURCE_TOUCH);
      this.buttons.get(def.id)?.classList.remove('down');
    }
    this.stickId = null;
    this.stickBase.classList.remove('active');
    this.lookIds.clear();
    if (this.input.lastDevice === 'touch') this.input.moveX = this.input.moveY = 0;
  }
}
