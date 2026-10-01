/**
 * Unified input state. Keyboard/mouse, touch and gamepad sources all write into one
 * `Input` instance; gameplay reads actions and analog axes without caring about source.
 */
export const ACTIONS = [
  'jump', 'sprint', 'attack', 'aim', 'enter', 'reload', 'wheel', 'cover', 'crouch',
  'horn', 'camera', 'handbrake', 'phone', 'pause', 'nextWeapon', 'prevWeapon',
  'gas', 'brake', 'lookBack', 'interact', 'switchTarget', 'radio', 'lights', 'ascend', 'descend', 'skip',
] as const;
export type Action = (typeof ACTIONS)[number];

export type InputDevice = 'keyboard' | 'touch' | 'gamepad';

export class Input {
  /** Movement on foot / steering in vehicle: x right, y forward, each in [-1, 1]. */
  moveX = 0;
  moveY = 0;
  /** Look delta accumulated this frame (radians-ish, already sensitivity-scaled by source). */
  lookX = 0;
  lookY = 0;
  /** Analog throttle/brake (0..1) — from triggers or pedals; digital gas/brake fall back to 1. */
  throttle = 0;
  brakeAxis = 0;
  /** Swipe gesture X this frame (touch target switching), pixels. */
  swipeX = 0;
  lastDevice: InputDevice = 'keyboard';

  private held = new Map<Action, number>(); // action → source bitmask
  private pressedSet = new Set<Action>();
  private releasedSet = new Set<Action>();
  private consumed = false;

  /** Source sets/clears its own bit so multiple sources can hold the same action. */
  setAction(a: Action, down: boolean, sourceBit = 1): void {
    const prev = this.held.get(a) ?? 0;
    const next = down ? prev | sourceBit : prev & ~sourceBit;
    if (prev === 0 && next !== 0) this.pressedSet.add(a);
    if (prev !== 0 && next === 0) this.releasedSet.add(a);
    if (next === 0) this.held.delete(a);
    else this.held.set(a, next);
  }
  /** Fire a press+release pulse (e.g. tap gestures). */
  tap(a: Action): void {
    this.pressedSet.add(a);
    this.releasedSet.add(a);
  }
  down(a: Action): boolean {
    return this.held.has(a);
  }
  pressed(a: Action): boolean {
    return this.pressedSet.has(a);
  }
  released(a: Action): boolean {
    return this.releasedSet.has(a);
  }
  /** Mark that gameplay consumed the edge flags (called after a fixed step). */
  markConsumed(): void {
    this.consumed = true;
  }
  /** Called once per rendered frame after all reads. */
  endFrame(): void {
    if (this.consumed) {
      this.pressedSet.clear();
      this.releasedSet.clear();
      this.lookX = 0;
      this.lookY = 0;
      this.swipeX = 0;
      this.consumed = false;
    }
  }
  /** Drop all held state (e.g. on blur / menu open). */
  reset(): void {
    this.held.clear();
    this.pressedSet.clear();
    this.releasedSet.clear();
    this.moveX = this.moveY = this.lookX = this.lookY = this.throttle = this.brakeAxis = 0;
  }
}

export const SOURCE_KEYBOARD = 1;
export const SOURCE_MOUSE = 2;
export const SOURCE_TOUCH = 4;
export const SOURCE_GAMEPAD = 8;
