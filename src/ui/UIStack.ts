import type { Input } from '../input/Input';

export interface Screen {
  el: HTMLElement;
  /** Back / cancel (Esc, B button, ✕). Return false to keep the screen open. */
  onBack?: () => boolean | void;
  /** Called after the screen is removed from the stack. */
  onClose?: () => void;
  /** Pause the simulation while this screen is on top. */
  pauses?: boolean;
}

/**
 * Stack of modal UI screens (menus, shops, phone). Handles focus navigation for keyboard and
 * gamepad: arrows / stick move between focusable buttons, confirm activates, back pops.
 */
export class UIStack {
  private stack: Screen[] = [];
  private navCooldown = 0;
  onChange: ((open: boolean) => void) | null = null;

  get open(): boolean {
    return this.stack.length > 0;
  }
  get top(): Screen | null {
    return this.stack[this.stack.length - 1] ?? null;
  }
  get pausing(): boolean {
    return this.stack.some((s) => s.pauses);
  }
  has(el: HTMLElement): boolean {
    return this.stack.some((s) => s.el === el);
  }

  push(s: Screen): void {
    if (this.has(s.el)) return;
    this.stack.push(s);
    s.el.classList.add('open');
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* ignore */
    }
    this.onChange?.(true);
  }

  /** Remove a screen (top by default). */
  pop(s: Screen | HTMLElement | null = this.top): void {
    if (!s) return;
    const el = s instanceof HTMLElement ? s : s.el;
    const i = this.stack.findIndex((x) => x.el === el);
    if (i < 0) return;
    const [scr] = this.stack.splice(i, 1);
    scr!.el.classList.remove('open');
    scr!.onClose?.();
    this.onChange?.(this.open);
  }

  back(): void {
    const t = this.top;
    if (!t) return;
    if (t.onBack && t.onBack() === false) return;
    this.pop(t);
  }

  clear(): void {
    while (this.stack.length) this.pop();
  }

  private focusables(): HTMLElement[] {
    const t = this.top;
    if (!t) return [];
    return Array.from(t.el.querySelectorAll<HTMLElement>('button:not([disabled]), [data-nav], select, input')).filter((e) => e.offsetParent !== null);
  }

  /** Poll gameplay input for menu navigation; call every frame while open. */
  poll(input: Input, dt: number): void {
    if (!this.open) return;
    if (input.pressed('pause') || input.pressed('enter')) {
      this.back();
      return;
    }
    this.navCooldown -= dt;
    const mx = input.moveX, my = input.moveY;
    const items = this.focusables();
    if (!items.length) return;
    const cur = document.activeElement as HTMLElement | null;
    let idx = cur ? items.indexOf(cur) : -1;
    if (input.pressed('jump') && idx >= 0 && input.lastDevice !== 'touch') {
      if (cur instanceof HTMLButtonElement || cur?.dataset.nav !== undefined) cur!.click();
      return;
    }
    if (this.navCooldown > 0 || (Math.abs(mx) < 0.5 && Math.abs(my) < 0.5)) {
      if (Math.abs(mx) < 0.3 && Math.abs(my) < 0.3) this.navCooldown = 0;
      return;
    }
    if (input.lastDevice === 'touch') return;
    this.navCooldown = 0.18;
    if (idx < 0) {
      items[0]!.focus();
      return;
    }
    // spatial navigation: nearest element in the pressed direction
    const r0 = cur!.getBoundingClientRect();
    const cx = r0.left + r0.width / 2, cy = r0.top + r0.height / 2;
    const dx = Math.abs(mx) > Math.abs(my) ? Math.sign(mx) : 0;
    const dy = dx === 0 ? -Math.sign(my) : 0;
    let best: HTMLElement | null = null, bd = Infinity;
    for (const e of items) {
      if (e === cur) continue;
      const r = e.getBoundingClientRect();
      const ex = r.left + r.width / 2 - cx, ey = r.top + r.height / 2 - cy;
      const along = ex * dx + ey * dy;
      if (along <= 2) continue;
      const across = Math.abs(ex * dy) + Math.abs(ey * dx);
      const d = along + across * 2.5;
      if (d < bd) {
        bd = d;
        best = e;
      }
    }
    if (!best) best = items[(idx + (dx + dy > 0 ? 1 : items.length - 1)) % items.length]!;
    best.focus();
    best.scrollIntoView({ block: 'nearest' });
    idx = items.indexOf(best);
  }
}
