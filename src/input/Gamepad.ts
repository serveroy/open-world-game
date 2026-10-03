import { Input, SOURCE_GAMEPAD, type Action } from './Input';
import type { Settings } from '../core/Settings';

// Standard mapping button indices → actions.
const BUTTONS: [number, Action][] = [
  [0, 'jump'], [1, 'enter'], [2, 'reload'], [2, 'interact'], [3, 'cover'], [4, 'wheel'], [5, 'switchTarget'],
  [8, 'phone'], [9, 'pause'], [10, 'sprint'], [11, 'camera'], [12, 'radio'], [13, 'horn'],
  [14, 'prevWeapon'], [15, 'nextWeapon'],
];

/** Gamepad API polling source (standard mapping). */
export class GamepadSource {
  private active = false;
  constructor(private input: Input, private settings: Settings) {
    addEventListener('gamepadconnected', () => (this.active = true));
  }
  poll(dt: number): void {
    if (!this.active || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    const gp = Array.from(pads).find((p) => p && p.connected);
    if (!gp) return;
    const dz = (v: number): number => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
    const lx = dz(gp.axes[0] ?? 0), ly = dz(gp.axes[1] ?? 0);
    const rx = dz(gp.axes[2] ?? 0), ry = dz(gp.axes[3] ?? 0);
    const any = Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0 || gp.buttons.some((b) => b.pressed);
    if (any) this.input.lastDevice = 'gamepad';
    if (this.input.lastDevice !== 'gamepad') return;
    this.input.moveX = lx;
    this.input.moveY = -ly;
    const s = 3.2 * dt * this.settings.data.lookSensitivity;
    this.input.lookX += rx * s;
    this.input.lookY += ry * s * (this.settings.data.invertY ? -1 : 1);
    const lt = gp.buttons[6]?.value ?? 0, rt = gp.buttons[7]?.value ?? 0;
    this.input.throttle = rt;
    this.input.brakeAxis = lt;
    // In vehicles the triggers are pedals only; drive-by fire moves to Y (aim follows the shot).
    const driving = this.input.inVehicle;
    this.input.setAction('aim', !driving && lt > 0.3, SOURCE_GAMEPAD);
    this.input.setAction('attack', driving ? !!gp.buttons[3]?.pressed : rt > 0.3, SOURCE_GAMEPAD);
    this.input.setAction('gas', rt > 0.1, SOURCE_GAMEPAD);
    this.input.setAction('brake', lt > 0.1, SOURCE_GAMEPAD);
    this.input.setAction('handbrake', !!gp.buttons[5]?.pressed, SOURCE_GAMEPAD);
    this.input.setAction('ascend', !!gp.buttons[5]?.pressed, SOURCE_GAMEPAD);
    this.input.setAction('descend', !!gp.buttons[4]?.pressed, SOURCE_GAMEPAD);
    for (const [i, a] of BUTTONS) {
      if (driving && i === 3) continue; // Y = drive-by while driving
      this.input.setAction(a, !!gp.buttons[i]?.pressed, SOURCE_GAMEPAD);
    }
  }
  rumble(intensity: number, ms: number): void {
    const gp = navigator.getGamepads?.().find((p) => p && p.connected) as (Gamepad & { vibrationActuator?: { playEffect: (t: string, o: object) => Promise<unknown> } }) | undefined;
    gp?.vibrationActuator?.playEffect('dual-rumble', { duration: ms, strongMagnitude: intensity, weakMagnitude: intensity * 0.6 }).catch(() => undefined);
  }
}
