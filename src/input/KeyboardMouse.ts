import { Input, SOURCE_KEYBOARD, SOURCE_MOUSE, type Action } from './Input';
import type { Settings } from '../core/Settings';

const KEYMAP: Record<string, Action> = {
  Space: 'jump', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyF: 'enter', KeyE: 'interact',
  KeyR: 'reload', Tab: 'wheel', KeyQ: 'cover', KeyC: 'camera', KeyH: 'horn', KeyM: 'phone',
  Escape: 'pause', KeyP: 'pause', Digit1: 'prevWeapon', Digit2: 'nextWeapon', KeyX: 'lookBack',
  ControlLeft: 'crouch', KeyT: 'switchTarget', KeyN: 'radio', KeyL: 'lights', Enter: 'skip',
  KeyZ: 'descend', KeyV: 'ascend',
};

/** Keyboard + mouse (pointer lock) input source. */
export class KeyboardMouse {
  private keys = new Set<string>();
  private locked = false;
  constructor(private input: Input, private canvas: HTMLElement, private settings: Settings) {
    addEventListener('keydown', this.onKey, { passive: false });
    addEventListener('keyup', this.onKey, { passive: false });
    addEventListener('blur', () => {
      this.keys.clear();
      this.input.reset();
    });
    canvas.addEventListener('mousedown', this.onMouse);
    addEventListener('mouseup', this.onMouse);
    addEventListener('mousemove', this.onMove);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('wheel', (e) => {
      this.input.tap(e.deltaY > 0 ? 'nextWeapon' : 'prevWeapon');
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
    });
  }
  get pointerLocked(): boolean {
    return this.locked;
  }
  requestLock(): void {
    if (!this.locked && this.canvas.requestPointerLock) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        p?.catch?.(() => undefined);
      } catch {
        /* ignore: not allowed */
      }
    }
  }
  private onKey = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
    const down = e.type === 'keydown';
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (e.code.startsWith('Alt')) e.preventDefault(); // walk modifier, not the browser menu
    const a = KEYMAP[e.code];
    if (a) {
      if (e.code === 'Tab' || e.code === 'Space') e.preventDefault();
      if (!(down && e.repeat)) this.input.setAction(a, down, SOURCE_KEYBOARD);
    }
    // driving keys
    if (e.code === 'KeyW' || e.code === 'ArrowUp') this.input.setAction('gas', down, SOURCE_KEYBOARD);
    if (e.code === 'KeyS' || e.code === 'ArrowDown') this.input.setAction('brake', down, SOURCE_KEYBOARD);
    if (e.code === 'Space') this.input.setAction('handbrake', down, SOURCE_KEYBOARD);
    if (e.code === 'ShiftLeft') this.input.setAction('ascend', down, SOURCE_KEYBOARD);
    if (e.code === 'ControlLeft') this.input.setAction('descend', down, SOURCE_KEYBOARD);
    this.input.lastDevice = 'keyboard';
  };
  private onMouse = (e: MouseEvent): void => {
    const down = e.type === 'mousedown';
    if (down && e.target === this.canvas) this.requestLock();
    if (!this.locked && down) return;
    if (e.button === 0) this.input.setAction('attack', down, SOURCE_MOUSE);
    if (e.button === 2) this.input.setAction('aim', down, SOURCE_MOUSE);
    if (e.button === 1) this.input.setAction('switchTarget', down, SOURCE_MOUSE);
    this.input.lastDevice = 'keyboard';
  };
  private onMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = 0.0025 * this.settings.data.lookSensitivity;
    this.input.lookX += e.movementX * s;
    this.input.lookY += e.movementY * s * (this.settings.data.invertY ? -1 : 1);
  };
  /** Called each frame to derive movement axes from held keys. */
  poll(): void {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (x !== 0 || y !== 0 || this.input.lastDevice === 'keyboard') {
      // hold Alt to walk (half deflection = the walk gait on foot)
      const len = (Math.hypot(x, y) || 1) * (k.has('AltLeft') || k.has('AltRight') ? 2 : 1);
      this.input.moveX = x / len;
      this.input.moveY = y / len;
    }
  }
}
