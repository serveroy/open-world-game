import { formatMoney } from '../core/math';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}

/** DOM heads-up display. All writes are diffed to avoid layout thrash. */
export class Hud {
  readonly root: HTMLDivElement;
  private hp: HTMLElement;
  private hpBar: HTMLElement;
  private ar: HTMLElement;
  private arBar: HTMLElement;
  private st: HTMLElement;
  private stBar: HTMLElement;
  private brBar: HTMLElement;
  private cash: HTMLElement;
  private clock: HTMLElement;
  private stars: HTMLElement;
  private weapon: HTMLElement;
  private crosshair: HTMLElement;
  readonly lockon: HTMLElement;
  private hitmarker: HTMLElement;
  private vignette: HTMLElement;
  private underwater: HTMLElement;
  private speedo: HTMLElement;
  private toasts: HTMLElement;
  private help: HTMLElement;
  private bigMsg: HTMLElement;
  private subtitle: HTMLElement;
  private objective: HTMLElement;
  private timer: HTMLElement;
  private counter: HTMLElement;
  private fadeEl: HTMLElement;
  private debugEl: HTMLElement;
  private radioEl: HTMLElement;
  private zoneEl: HTMLElement;
  readonly minimapWrap: HTMLDivElement;
  private cache = new Map<string, string | number>();
  private hitTimer = 0;
  private dmgTimer = 0;
  private bigTimer = 0;
  private helpTimer = 0;
  private subTimer = 0;
  private radioTimer = 0;
  private zoneTimer = 0;
  private shownCash = 0;
  private targetCash = 0;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'ui-layer', parent);
    this.vignette = el('div', 'damage-vignette', this.root);
    this.underwater = el('div', 'underwater', this.root);
    const tr = el('div', 'hud-top-right', this.root);
    this.clock = el('div', 'hud-clock', tr);
    this.cash = el('div', 'hud-cash', tr);
    this.weapon = el('div', 'hud-weapon', tr);
    this.weapon.style.display = 'none';
    const bars = el('div', 'hud-bars', tr);
    this.hp = el('div', 'bar hp', bars);
    this.hpBar = el('i', '', this.hp);
    this.ar = el('div', 'bar ar', bars);
    this.arBar = el('i', '', this.ar);
    this.st = el('div', 'bar st', bars);
    this.stBar = el('i', '', this.st);
    const br = el('div', 'bar br', bars);
    this.brBar = el('i', '', br);
    br.style.display = 'none';
    this.brBar.dataset.wrap = '1';
    this.stars = el('div', 'hud-stars', tr, '<span>★</span><span>★</span><span>★</span><span>★</span><span>★</span>');
    this.stars.style.display = 'none';
    this.crosshair = el('div', 'crosshair', this.root);
    this.lockon = el('div', 'lockon', this.root);
    this.hitmarker = el('div', 'hitmarker', this.root);
    this.speedo = el('div', 'speedo', this.root, '<div class="vname"></div><span class="v">0</span><span class="u">KM/H</span><div class="bar hp vhp"><i></i></div>');
    this.toasts = el('div', 'toast-wrap', this.root);
    this.help = el('div', 'help', this.root);
    this.bigMsg = el('div', 'big-msg', this.root);
    this.subtitle = el('div', 'subtitle', this.root);
    this.objective = el('div', 'objective', this.root);
    this.timer = el('div', 'mission-timer', this.root);
    this.counter = el('div', 'mission-counter', this.root);
    this.radioEl = el('div', 'radio-name', this.root);
    this.zoneEl = el('div', 'zone-name', this.root);
    this.minimapWrap = el('div', 'minimap', this.root);
    this.fadeEl = el('div', 'fade', parent);
    this.debugEl = el('div', 'debug', parent);
    this.debugEl.style.display = 'none';
    const rot = el('div', 'rotate-hint', document.body, '<div class="ph"></div>Rotate your device to landscape');
    void rot;
  }

  private setText(key: string, e: HTMLElement, v: string): void {
    if (this.cache.get(key) !== v) {
      this.cache.set(key, v);
      e.textContent = v;
    }
  }
  private setHtml(key: string, e: HTMLElement, v: string): void {
    if (this.cache.get(key) !== v) {
      this.cache.set(key, v);
      e.innerHTML = v;
    }
  }
  private setStyle(key: string, e: HTMLElement, prop: 'display' | 'opacity' | 'transform' | 'left' | 'top', v: string): void {
    const k = key + prop;
    if (this.cache.get(k) !== v) {
      this.cache.set(k, v);
      e.style[prop] = v;
    }
  }
  private setClass(key: string, e: HTMLElement, cls: string, on: boolean): void {
    const k = key + ':' + cls;
    const v = on ? 1 : 0;
    if (this.cache.get(k) !== v) {
      this.cache.set(k, v);
      e.classList.toggle(cls, on);
    }
  }

  vitals(health: number, maxHealth: number, armor: number, stamina: number, breath: number | null): void {
    const h = Math.max(0, health / maxHealth);
    this.setStyle('hp', this.hpBar, 'transform', `scaleX(${h.toFixed(3)})`);
    this.setClass('hp', this.hp, 'low', h < 0.25);
    this.setStyle('ar', this.ar, 'display', armor > 0 ? '' : 'none');
    this.setStyle('arb', this.arBar, 'transform', `scaleX(${(armor / 100).toFixed(3)})`);
    this.setStyle('st', this.st, 'display', stamina < 99.5 ? '' : 'none');
    this.setStyle('stb', this.stBar, 'transform', `scaleX(${(stamina / 100).toFixed(3)})`);
    const brWrap = this.brBar.parentElement!;
    this.setStyle('br', brWrap, 'display', breath !== null && breath < 100 ? '' : 'none');
    if (breath !== null) this.setStyle('brb', this.brBar, 'transform', `scaleX(${(breath / 100).toFixed(3)})`);
  }

  setCash(n: number, instant = false): void {
    this.targetCash = n;
    if (instant) this.shownCash = n;
  }

  clockText(t: string): void {
    this.setText('clock', this.clock, t);
  }

  wanted(stars: number, flashing: boolean): void {
    const k = `${stars}|${flashing}`;
    if (this.cache.get('stars') === k) return;
    this.cache.set('stars', k);
    const spans = this.stars.children;
    for (let i = 0; i < 5; i++) spans[i]!.classList.toggle('on', i < stars);
    this.stars.classList.toggle('flash', flashing);
    this.stars.style.display = stars > 0 ? '' : 'none';
  }

  weaponInfo(icon: string, name: string, ammo: string): void {
    this.setStyle('wpn', this.weapon, 'display', '');
    this.setHtml('weapon', this.weapon, `<span>${icon}</span><span>${name}</span><span class="ammo">${ammo}</span>`);
  }

  crosshairVisible(on: boolean, dot = false): void {
    this.setStyle('ch', this.crosshair, 'display', on ? 'block' : 'none');
    this.setClass('ch', this.crosshair, 'dot', dot);
  }

  lockOn(x: number | null, y = 0): void {
    if (x === null) {
      this.setStyle('lock', this.lockon, 'display', 'none');
      return;
    }
    this.setStyle('lock', this.lockon, 'display', 'block');
    this.lockon.style.left = `${x}px`;
    this.lockon.style.top = `${y}px`;
  }

  hit(kill = false): void {
    this.hitTimer = 0.18;
    this.hitmarker.classList.add('on');
    this.hitmarker.classList.toggle('kill', kill);
  }

  damageFlash(intensity = 1): void {
    this.dmgTimer = Math.min(1, this.dmgTimer + 0.5 * intensity);
  }

  setUnderwater(on: boolean): void {
    this.setStyle('uw', this.underwater, 'display', on ? 'block' : 'none');
  }

  speedometer(visible: boolean, speedKmh = 0, name = '', health = 1, imperial = false): void {
    this.setStyle('spd', this.speedo, 'display', visible ? 'block' : 'none');
    if (!visible) return;
    const v = imperial ? speedKmh * 0.621 : speedKmh;
    this.setText('spdv', this.speedo.querySelector('.v') as HTMLElement, String(Math.round(v)));
    this.setText('spdu', this.speedo.querySelector('.u') as HTMLElement, imperial ? 'MPH' : 'KM/H');
    this.setText('spdn', this.speedo.querySelector('.vname') as HTMLElement, name);
    this.setStyle('spdh', this.speedo.querySelector('.vhp i') as HTMLElement, 'transform', `scaleX(${Math.max(0, health).toFixed(2)})`);
  }

  toast(msg: string, ms = 2600): void {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    this.toasts.appendChild(t);
    while (this.toasts.children.length > 3) this.toasts.firstChild?.remove();
    setTimeout(() => t.remove(), ms);
  }

  showHelp(html: string | null, seconds = 6): void {
    if (html === null) {
      this.helpTimer = 0;
      this.help.style.display = 'none';
      this.cache.delete('help');
      return;
    }
    this.setHtml('help', this.help, html);
    this.help.style.display = 'block';
    this.helpTimer = seconds;
  }

  big(text: string, cls: string, sub = '', seconds = 3.5): void {
    this.bigMsg.className = `big-msg ${cls}`;
    this.bigMsg.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    this.bigMsg.style.display = 'block';
    this.bigTimer = seconds;
  }

  subtitleText(who: string | null, text: string | null, seconds = 4): void {
    if (!text) {
      this.subtitle.style.display = 'none';
      this.subTimer = 0;
      return;
    }
    this.subtitle.innerHTML = `${who ? `<span class="who">${who}:</span>` : ''}${text}`;
    this.subtitle.style.display = 'block';
    this.subTimer = seconds;
  }

  objectiveText(text: string | null): void {
    this.setStyle('obj', this.objective, 'display', text ? 'block' : 'none');
    if (text) this.setHtml('objt', this.objective, text);
  }

  timerText(text: string | null): void {
    this.setStyle('tmr', this.timer, 'display', text ? 'block' : 'none');
    if (text) this.setText('tmrt', this.timer, text);
  }

  counterText(text: string | null): void {
    this.setStyle('cnt', this.counter, 'display', text ? 'block' : 'none');
    if (text) this.setText('cntt', this.counter, text);
  }

  radio(name: string): void {
    this.radioEl.textContent = name;
    this.radioEl.style.opacity = '1';
    this.radioTimer = 2.5;
  }

  zone(name: string): void {
    this.zoneEl.textContent = name;
    this.zoneEl.style.opacity = '1';
    this.zoneTimer = 3.5;
  }

  letterbox(on: boolean): void {
    this.setClass('lb', this.root, 'letterbox', on);
  }

  fade(opacity: number, ms = 600): void {
    this.fadeEl.style.transition = `opacity ${ms}ms`;
    this.fadeEl.style.opacity = String(opacity);
  }

  debug(text: string | null): void {
    this.setStyle('dbg', this.debugEl, 'display', text ? 'block' : 'none');
    if (text) this.debugEl.textContent = text;
  }

  setVisible(on: boolean): void {
    this.setStyle('root', this.root, 'display', on ? '' : 'none');
  }

  update(dt: number): void {
    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitmarker.classList.remove('on');
    }
    if (this.dmgTimer > 0) this.dmgTimer = Math.max(0, this.dmgTimer - dt * 1.2);
    this.setStyle('vig', this.vignette, 'opacity', this.dmgTimer.toFixed(2));
    if (this.bigTimer > 0) {
      this.bigTimer -= dt;
      if (this.bigTimer <= 0) this.bigMsg.style.display = 'none';
    }
    if (this.helpTimer > 0) {
      this.helpTimer -= dt;
      if (this.helpTimer <= 0) this.showHelp(null);
    }
    if (this.subTimer > 0) {
      this.subTimer -= dt;
      if (this.subTimer <= 0) this.subtitle.style.display = 'none';
    }
    if (this.radioTimer > 0) {
      this.radioTimer -= dt;
      if (this.radioTimer <= 0) this.radioEl.style.opacity = '0';
    }
    if (this.zoneTimer > 0) {
      this.zoneTimer -= dt;
      if (this.zoneTimer <= 0) this.zoneEl.style.opacity = '0';
    }
    if (this.shownCash !== this.targetCash) {
      const d = this.targetCash - this.shownCash;
      const step = Math.max(1, Math.abs(d) * Math.min(1, dt * 6));
      this.shownCash = Math.abs(d) <= step ? this.targetCash : this.shownCash + Math.sign(d) * step;
    }
    this.setText('cash', this.cash, formatMoney(Math.round(this.shownCash)));
  }
}
