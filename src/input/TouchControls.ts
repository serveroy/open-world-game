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
  // on foot (right-thumb cluster, measured from the bottom-right corner)
  B({ id: 'sprint', action: 'sprint', label: '»', right: 22, bottom: 22, size: 70, modes: ['foot'] }),
  B({ id: 'attack', action: 'attack', label: '✊', right: 22, bottom: 108, size: 74, modes: ['foot'] }),
  B({ id: 'jump', action: 'jump', label: '⤒', right: 106, bottom: 22, size: 60, modes: ['foot'] }),
  B({ id: 'cover', action: 'cover', label: '▣', right: 180, bottom: 24, size: 50, modes: ['foot'] }),
  B({ id: 'aim', action: 'aim', label: '◎', right: 106, bottom: 100, size: 58, modes: ['foot'] }),
  B({ id: 'enter', action: 'enter', label: 'ENTER', right: 178, bottom: 86, size: 62, modes: ['foot'], contextual: true }),
  B({ id: 'interact', action: 'interact', label: 'USE', right: 250, bottom: 92, size: 58, modes: ['foot'], contextual: true }),
  B({ id: 'reload', action: 'reload', label: '⟳', right: 112, bottom: 168, size: 46, modes: ['foot'], contextual: true }),
  B({ id: 'switchTarget', action: 'switchTarget', label: '⇆', right: 170, bottom: 160, size: 44, modes: ['foot'], contextual: true }),
  B({ id: 'wheel', action: 'wheel', label: '⊕', right: 22, bottom: 192, size: 50, modes: ['foot'] }),
  // vehicles
  B({ id: 'gas', action: 'gas', label: '▲', right: 22, bottom: 20, size: 86, modes: ['vehicle', 'boat'] }),
  B({ id: 'brake', action: 'brake', label: '▼', right: 118, bottom: 20, size: 70, modes: ['vehicle', 'boat'] }),
  B({ id: 'handbrake', action: 'handbrake', label: 'HB', right: 198, bottom: 24, size: 56, modes: ['vehicle'] }),
  B({ id: 'vattack', action: 'attack', label: '✊', right: 22, bottom: 118, size: 60, modes: ['vehicle', 'boat', 'heli'] }),
  B({ id: 'exit', action: 'enter', label: 'EXIT', right: 96, bottom: 104, size: 56, modes: ['vehicle', 'boat', 'heli'] }),
  B({ id: 'horn', action: 'horn', label: '📯', right: 166, bottom: 96, size: 46, modes: ['vehicle', 'boat'] }),
  B({ id: 'vinteract', action: 'interact', label: 'USE', right: 156, bottom: 156, size: 50, modes: ['vehicle', 'boat', 'heli'], contextual: true }),
  B({ id: 'vaim', action: 'aim', label: '◎', right: 90, bottom: 172, size: 44, modes: ['vehicle'] }),
  B({ id: 'vwheel', action: 'wheel', label: '⊕', right: 22, bottom: 190, size: 44, modes: ['vehicle'] }),
  B({ id: 'ascend', action: 'ascend', label: '⇧', right: 22, bottom: 24, size: 80, modes: ['heli'] }),
  B({ id: 'descend', action: 'descend', label: '⇩', right: 112, bottom: 22, size: 66, modes: ['heli'] }),
  // top-left utility row (anchored to the top edge)
  B({ id: 'phone', action: 'phone', label: '📱', right: 12, bottom: 8, size: 40, modes: ['foot', 'vehicle', 'boat', 'heli'], left: true, top: true }),
  B({ id: 'pause', action: 'pause', label: 'II', right: 58, bottom: 8, size: 40, modes: ['foot', 'vehicle', 'boat', 'heli'], left: true, top: true }),
  B({ id: 'camera', action: 'camera', label: '🎥', right: 104, bottom: 8, size: 40, modes: ['vehicle', 'boat', 'heli', 'foot'], left: true, top: true }),
  B({ id: 'radio', action: 'radio', label: '📻', right: 150, bottom: 8, size: 40, modes: ['vehicle', 'boat'], left: true, top: true }),
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
  /** Bottom edge (px) of HUD elements the right cluster must stay under (cash, bars…). */
  topReserve: () => number = () => 110;
  /** Effective scale of the last layout (for the HUD to match). */
  scale = 1;

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
    addEventListener('resize', () => setTimeout(() => this.applyLayout(), 50));
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
    this.root.parentElement?.classList.toggle('touch-on', on);
    if (on) requestAnimationFrame(() => this.applyLayout());
    if (!on) this.releaseAll();
  }

  setMode(mode: TouchMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.releaseAll();
    this.applyLayout();
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

  /** Size factor for the current viewport (designed at 844×390 CSS px landscape). */
  static autoScale(): number {
    return Math.min(1.15, Math.max(0.6, Math.min(innerWidth / 844, innerHeight / 390)));
  }

  applyLayout(): void {
    const hud = this.settings.data.hud;
    // shrink the right cluster further if it would run into the HUD at the top
    let extent = 0;
    for (const def of TOUCH_BUTTONS) {
      if (def.top || !def.modes.includes(this.mode)) continue;
      extent = Math.max(extent, def.bottom + def.size);
    }
    const avail = innerHeight - this.topReserve() - 6;
    const fit = extent > 0 ? avail / extent : 1;
    const s = Math.max(0.45, Math.min(hud.buttonScale * TouchControls.autoScale(), fit));
    this.scale = s;
    for (const def of TOUCH_BUTTONS) {
      const el = this.buttons.get(def.id)!;
      const off = hud.offsets[def.id] ?? [0, 0];
      const leftSide = hud.leftHanded ? !def.left : !!def.left;
      // top utility row keeps a touch-friendly minimum size
      const size = def.top ? Math.max(34, def.size * Math.min(1, s * 1.1)) : def.size * s;
      const step = def.top ? Math.max(34, def.size * Math.min(1, s * 1.1)) / def.size : s;
      el.style.width = el.style.height = `${size}px`;
      el.style.fontSize = `${Math.max(11, size * (def.label.length > 2 ? 0.24 : 0.42))}px`;
      el.style.left = el.style.right = el.style.top = el.style.bottom = '';
      const h = `calc(${def.right * step + off[0]}px + var(${leftSide ? '--sal' : '--sar'}))`;
      const v = `calc(${def.bottom * (def.top ? 1 : s) + off[1]}px + var(${def.top ? '--sat' : '--sab'}))`;
      if (leftSide) el.style.left = h;
      else el.style.right = h;
      if (def.top) el.style.top = v;
      else el.style.bottom = v;
      el.style.opacity = String(hud.opacity);
    }
    document.documentElement.style.setProperty('--tscale', s.toFixed(3));
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
      const r = 56 * Math.max(0.75, this.scale);
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
