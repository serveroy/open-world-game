import { WEAPONS, WHEEL_ORDER, type Arsenal, type WeaponId } from '../combat/Weapons';

/** Radial weapon selector. Hold the wheel button; drag / move stick toward a weapon; release. */
export class WeaponWheel {
  readonly el: HTMLDivElement;
  private segs = new Map<WeaponId, HTMLDivElement>();
  private center: HTMLDivElement;
  open = false;
  private sel: WeaponId | null = null;
  private dx = 0;
  private dy = 0;
  private pointerId: number | null = null;
  private origin = { x: 0, y: 0 };

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'wheel';
    const R = 120;
    WHEEL_ORDER.forEach((id, i) => {
      const a = (i / WHEEL_ORDER.length) * Math.PI * 2 - Math.PI / 2;
      const s = document.createElement('div');
      s.className = 'seg';
      s.style.left = `${165 + Math.cos(a) * R}px`;
      s.style.top = `${165 + Math.sin(a) * R}px`;
      s.innerHTML = `<div class="ic">${WEAPONS[id].icon}</div><div>${WEAPONS[id].name.split(' ')[0]}</div><div class="am"></div>`;
      s.dataset.id = id;
      this.el.appendChild(s);
      this.segs.set(id, s);
    });
    this.center = document.createElement('div');
    this.center.className = 'center';
    this.el.appendChild(this.center);
    parent.appendChild(this.el);
    // direct touch on a segment also selects
    this.el.addEventListener('pointermove', (e) => {
      if (!this.open) return;
      const r = this.el.getBoundingClientRect();
      this.aimAt(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
    });
    addEventListener('pointermove', (e) => {
      if (!this.open || this.pointerId !== e.pointerId) return;
      this.aimAt(e.clientX - this.origin.x, e.clientY - this.origin.y);
    });
    addEventListener('pointerdown', (e) => {
      if (this.open && this.pointerId === null) {
        this.pointerId = e.pointerId;
        this.origin = { x: innerWidth / 2, y: innerHeight / 2 };
        this.aimAt(e.clientX - this.origin.x, e.clientY - this.origin.y);
      }
    });
  }

  show(arsenal: Arsenal): void {
    this.open = true;
    this.el.classList.add('open');
    this.sel = arsenal.current;
    this.dx = this.dy = 0;
    this.pointerId = null;
    for (const [id, s] of this.segs) {
      const has = arsenal.has(id);
      s.classList.toggle('empty', !has);
      (s.querySelector('.am') as HTMLElement).textContent = has && WEAPONS[id].kind !== 'melee' ? String(arsenal.total(id)) : '';
    }
    this.refresh(arsenal);
  }

  /** Accumulate a direction (mouse delta / stick) in px-ish units. */
  push(dx: number, dy: number, arsenal: Arsenal): void {
    if (!this.open) return;
    this.dx = this.dx * 0.85 + dx;
    this.dy = this.dy * 0.85 + dy;
    if (Math.hypot(this.dx, this.dy) > 0.25) this.aimAt(this.dx, this.dy, arsenal);
  }

  stick(x: number, y: number, arsenal: Arsenal): void {
    if (!this.open || Math.hypot(x, y) < 0.5) return;
    this.aimAt(x, -y, arsenal);
  }

  private aimAt(x: number, y: number, arsenal?: Arsenal): void {
    if (Math.hypot(x, y) < 0.01) return;
    let a = Math.atan2(y, x) + Math.PI / 2;
    if (a < 0) a += Math.PI * 2;
    const i = Math.round((a / (Math.PI * 2)) * WHEEL_ORDER.length) % WHEEL_ORDER.length;
    const id = WHEEL_ORDER[i]!;
    const s = this.segs.get(id)!;
    if (s.classList.contains('empty')) return;
    this.sel = id;
    if (arsenal) this.refresh(arsenal);
    else for (const [k, el] of this.segs) el.classList.toggle('sel', k === this.sel);
  }

  private refresh(arsenal: Arsenal): void {
    for (const [k, el] of this.segs) el.classList.toggle('sel', k === this.sel);
    const d = this.sel ? WEAPONS[this.sel] : null;
    this.center.innerHTML = d ? `${d.icon}<br>${d.name}<br><span class="muted">${d.kind === 'melee' ? '' : arsenal.total(d.id)}</span>` : '';
  }

  /** Close and return the chosen weapon. */
  hide(): WeaponId | null {
    this.open = false;
    this.el.classList.remove('open');
    this.pointerId = null;
    return this.sel;
  }
}
