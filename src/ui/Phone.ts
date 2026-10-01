import type { Game } from '../game/Game';
import { WORLD_MAX_X, WORLD_MAX_Z, WORLD_MIN_X, WORLD_MIN_Z } from '../world/constants';
import { LANDMARKS, landmark } from '../world/MapData';
import { LANDMARK_ICONS, type Blip } from './Minimap';
import { CHARACTERS } from '../data/characters';
import { PROPERTIES } from '../economy/Estate';
import { STAT_LABELS } from '../game/PlayerStats';
import { formatMoney } from '../core/math';
import { DeliveryJob } from '../activities/Jobs';

type App = 'home' | 'map' | 'missions' | 'contacts' | 'stats' | 'property' | 'call';
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const APPS: { id: App | 'settings' | 'save'; name: string; icon: string; color: string }[] = [
  { id: 'map', name: 'Maps', icon: '🗺️', color: '#2a7a5a' },
  { id: 'missions', name: 'Jobs', icon: '📋', color: '#c83a4a' },
  { id: 'contacts', name: 'Contacts', icon: '👥', color: '#3a6ac8' },
  { id: 'property', name: 'Property', icon: '🏠', color: '#c8902a' },
  { id: 'stats', name: 'Stats', icon: '📊', color: '#7a3ac8' },
  { id: 'save', name: 'Save', icon: '💾', color: '#2a8ac8' },
  { id: 'settings', name: 'Settings', icon: '⚙️', color: '#555566' },
];

const CALL_LINES: Record<string, string[]> = {
  lena: ['Car trouble? Bring it by the shop. And Nico — be careful.', 'There is always something on the contract board out back.'],
  juno: ['Your phone has three trackers on it. I removed two. You are welcome.', 'Taxi dispatch is a gold mine. Grab a cab and press the button.'],
  sal: ['Desert is quiet tonight. Too quiet. Come race the Mesa Loop sometime.', 'Kid, you drive like your father. That is a compliment.'],
  theo: ['Not on this line, Nico.', 'I owe you. I know.'],
  dima: ['You call me, you better have a reason.', 'Ships do not unload themselves.'],
  izzy: ['Halcyon is open all night, darling. VIP is on me — kidding, it is 300.', 'Everyone talks at my bar. I just listen.'],
};

/** In-game smartphone: GPS map with waypoints, jobs, contacts, properties, stats, settings and save. */
export class Phone {
  readonly el: HTMLDivElement;
  private screen: HTMLDivElement;
  private app: App = 'home';
  private callWho = '';
  // map view state
  private canvas: HTMLCanvasElement | null = null;
  private cx = 0;
  private cz = 0;
  private zoom = 1.6; // canvas px per metre
  private pointers = new Map<number, { x: number; y: number }>();
  private dragMoved = 0;
  private pinch = 0;
  private raf = 0;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'phone';
    this.el.innerHTML = `<div class="bar-top"><span class="ph-clock">09:00</span><span>CRIMSON·NET</span><span class="ph-cash"></span></div><div class="screen"></div>
      <div class="nav"><button class="btn small" data-a="back">◀</button><button class="btn small" data-a="home">●</button><button class="btn small" data-a="close">✕</button></div>`;
    game.container.appendChild(this.el);
    this.screen = this.el.querySelector('.screen')!;
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      if (!t) return;
      e.stopPropagation();
      this.action(t.dataset.a!, t.dataset);
    });
  }

  get isOpen(): boolean {
    return this.game.ui.has(this.el);
  }

  toggle(): void {
    if (this.isOpen) this.game.ui.pop(this.el);
    else this.open('home');
  }

  open(app: App = 'home'): void {
    const g = this.game;
    this.app = app;
    this.render();
    if (!this.isOpen) {
      g.ui.push({
        el: this.el, pauses: true,
        onBack: () => {
          if (this.app !== 'home') {
            this.go(this.app === 'call' ? 'contacts' : 'home');
            return false;
          }
          return true;
        },
        onClose: () => cancelAnimationFrame(this.raf),
      });
      g.haptic(10);
    }
  }

  private go(app: App): void {
    this.app = app;
    this.render();
  }

  private action(a: string, d: DOMStringMap): void {
    const g = this.game;
    switch (a) {
      case 'back':
        g.ui.back();
        break;
      case 'home':
        this.go('home');
        break;
      case 'close':
        g.ui.pop(this.el);
        break;
      case 'app':
        if (d.id === 'settings') g.settingsUI.open();
        else if (d.id === 'save') {
          if (!g.saves.safeToSave()) g.hud.toast('Can\'t save right now (mission, job or wanted level)', 2200);
          else g.saves.slotPicker('Save Game');
        } else this.go(d.id as App);
        break;
      case 'wp': {
        const x = Number(d.x), z = Number(d.z);
        g.gps.setWaypoint({ x, z });
        g.hud.toast('Waypoint set', 1200);
        this.cx = x;
        this.cz = z;
        this.go('map');
        break;
      }
      case 'clearwp':
        g.gps.setWaypoint(null);
        this.render();
        break;
      case 'center':
        this.centerOnPlayer();
        break;
      case 'zoom':
        this.zoom = Math.min(4, Math.max(0.35, this.zoom * Number(d.f)));
        break;
      case 'call':
        this.callWho = d.id!;
        this.go('call');
        break;
      case 'collect': {
        const day = (g.env?.clock.totalHours ?? 0) / 24;
        let total = 0;
        for (const id of g.estate.owned) total += g.estate.pending(id, day);
        if (total <= 0) return void g.hud.toast('Nothing to collect', 1500);
        const got = g.estate.collectAll(g.wallet, day);
        const fee = Math.round(got * 0.1);
        g.wallet.take(fee, 'Wire fee');
        g.hud.toast(`Wired ${formatMoney(got - fee)} (10% fee)`, 2200);
        this.render();
        break;
      }
    }
  }

  private centerOnPlayer(): void {
    const p = this.game.vctrl?.vehicle?.position ?? this.game.player.pos;
    this.cx = p.x;
    this.cz = p.z;
  }

  private render(): void {
    const g = this.game;
    cancelAnimationFrame(this.raf);
    this.canvas = null;
    (this.el.querySelector('.ph-cash') as HTMLElement).textContent = formatMoney(g.wallet.cash);
    (this.el.querySelector('.ph-clock') as HTMLElement).textContent = g.env?.clock.text() ?? '';
    const s = this.screen;
    switch (this.app) {
      case 'home':
        s.innerHTML = `<div class="apps">${APPS.map((a) => `<button class="app" data-a="app" data-id="${a.id}"><span class="ic" style="background:${a.color}">${a.icon}</span>${a.name}</button>`).join('')}</div>
          <div class="muted" style="text-align:center;padding:8px">Story ${g.saves.progressText()} · 🐚 ${g.collectibles?.count ?? 0}/${g.collectibles?.spots.length ?? 30}</div>`;
        break;
      case 'map':
        this.renderMap();
        break;
      case 'missions':
        s.innerHTML = this.missionsHtml();
        break;
      case 'contacts':
        s.innerHTML = this.contactsHtml();
        break;
      case 'call':
        s.innerHTML = this.callHtml();
        break;
      case 'stats':
        s.innerHTML = `<div class="list">${Object.keys(STAT_LABELS).map((k) => `<div class="item"><span>${STAT_LABELS[k]}</span><b>${g.stats.format(k)}</b></div>`).join('')}</div>`;
        break;
      case 'property':
        s.innerHTML = this.propertyHtml();
        break;
    }
  }

  private missionsHtml(): string {
    const g = this.game;
    const m = g.missions;
    const rows: string[] = [];
    if (m) {
      const av = m.available();
      rows.push('<div class="item"><b>STORY</b><span class="s">' + g.saves.progressText() + '</span></div>');
      if (!av.length) rows.push('<div class="item muted">No story missions available.</div>');
      for (const mi of av) {
        const giver = CHARACTERS[mi.giver];
        rows.push(`<button class="item" data-a="wp" data-x="${mi.start.x}" data-z="${mi.start.z}"><span><b>${esc(mi.title)}</b><br><span class="s">${esc(giver?.name ?? mi.giver)} · ${esc(mi.summary)}</span></span><span>📍</span></button>`);
      }
    }
    const blips: Blip[] = [];
    for (const a of g.activities?.list ?? []) a.blips(blips);
    rows.push('<div class="item"><b>SIDE JOBS</b><span class="s"></span></div>');
    const named: { name: string; x: number; z: number; desc: string }[] = [];
    for (const r of g.activities?.list ?? []) {
      const any = r as unknown as { def?: { name: string; anchors: [number, number][]; prize: number } };
      if (any.def?.anchors) named.push({ name: `🏁 ${any.def.name}`, x: any.def.anchors[0]![0], z: any.def.anchors[0]![1], desc: `Street race · 1st ${formatMoney(any.def.prize)}` });
    }
    const dep = landmark('respray');
    named.push({ name: '📦 Gull Express', x: DeliveryJob.DEPOT.x, z: DeliveryJob.DEPOT.z, desc: 'Courier deliveries' });
    named.push({ name: '🚗 Contract board', x: dep.x, z: dep.z, desc: "Theft contracts at Reyes' Body & Paint" });
    named.push({ name: '🚕 Taxi', x: 0, z: 0, desc: 'Get in any Solano Cab and go on duty' });
    for (const b of blips) if (b.label === '☠') named.push({ name: '☠ Rampage', x: b.x, z: b.z, desc: 'Gang territory' });
    for (const n of named) rows.push(n.x || n.z ? `<button class="item" data-a="wp" data-x="${n.x}" data-z="${n.z}"><span><b>${n.name}</b><br><span class="s">${n.desc}</span></span><span>📍</span></button>` : `<div class="item"><span><b>${n.name}</b><br><span class="s">${n.desc}</span></span></div>`);
    return `<div class="list">${rows.join('')}</div>`;
  }

  private contacts(): string[] {
    const un = this.game.missions?.story.unlocked ?? [];
    const out = ['lena'];
    for (const u of un) if (u.startsWith('contact:')) out.push(u.slice(8));
    if (this.game.missions?.story.completed.includes('m03_dockwork')) out.push('dima');
    if (this.game.missions?.story.completed.includes('m04_velvetropes')) out.push('izzy');
    return [...new Set(out)].filter((id) => CHARACTERS[id]);
  }

  private contactsHtml(): string {
    const list = this.contacts();
    return `<div class="list">${list.map((id) => {
      const c = CHARACTERS[id]!;
      return `<button class="item" data-a="call" data-id="${id}"><span><b>${esc(c.name)}</b><br><span class="s">${esc(c.role)} · ${c.phone || 'private'}</span></span><span>📞</span></button>`;
    }).join('')}</div>`;
  }

  private callHtml(): string {
    const g = this.game;
    const c = CHARACTERS[this.callWho];
    if (!c) return '';
    const lines = CALL_LINES[this.callWho] ?? ['…'];
    const line = lines[Math.floor((g.time / 7) % lines.length)]!;
    const next = g.missions?.available().find((m) => m.giver === this.callWho);
    return `<div style="padding:18px;text-align:center"><div style="font-size:54px">📞</div><h3>${esc(c.name)}</h3><div class="muted">${esc(c.bio)}</div>
      <p style="font-style:italic;margin:18px 6px">"${esc(next ? `I need you. Meet me — I'll send the location.` : line)}"</p>
      ${next ? `<button class="btn primary" data-a="wp" data-x="${next.start.x}" data-z="${next.start.z}">📍 ${esc(next.title)}</button>` : ''}</div>`;
  }

  private propertyHtml(): string {
    const g = this.game;
    const e = g.estate;
    const day = (g.env?.clock.totalHours ?? 0) / 24;
    let pending = 0;
    for (const id of e.owned) pending += e.pending(id, day);
    const rows = PROPERTIES.map((p) => {
      const own = e.owned.has(p.id);
      const l = LANDMARKS.find((x) => x.id === p.id)!;
      const sub = own ? (p.kind === 'business' ? `${formatMoney(p.income)}/day · till ${formatMoney(e.pending(p.id, day))}` : `Garage ${(e.garages.get(p.id) ?? []).length}/${p.garage}`) : e.available(p.id) ? `For sale · ${formatMoney(p.price)}` : 'Not available';
      return `<button class="item" data-a="wp" data-x="${l.x}" data-z="${l.z}"><span><b>${own ? '✅ ' : ''}${esc(p.name)}</b><br><span class="s">${sub}</span></span><span>📍</span></button>`;
    });
    return `<div class="list"><div class="item"><span>Daily income <b>${formatMoney(e.dailyIncome())}</b></span><button class="btn small primary" data-a="collect" ${pending > 0 ? '' : 'disabled'}>Collect ${formatMoney(pending)}</button></div>${rows.join('')}</div>`;
  }

  // -------------------------------------------------------------------- map app
  private renderMap(): void {
    const g = this.game;
    this.screen.innerHTML = `<div class="mapview"><canvas></canvas>
      <div class="map-tools"><button class="btn small" data-a="zoom" data-f="1.4">＋</button><button class="btn small" data-a="zoom" data-f="0.7">－</button><button class="btn small" data-a="center">◎</button>${g.gps.waypoint ? '<button class="btn small" data-a="clearwp">✕ WP</button>' : ''}</div>
      <div class="map-hint muted">Tap to set a waypoint</div></div>`;
    const c = this.screen.querySelector('canvas')!;
    this.canvas = c;
    if (!this.cx && !this.cz) this.centerOnPlayer();
    if (g.gps.waypoint === null) this.centerOnPlayer();
    c.addEventListener('pointerdown', this.onDown);
    c.addEventListener('pointermove', this.onMove);
    c.addEventListener('pointerup', this.onUp);
    c.addEventListener('pointercancel', this.onUp);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.min(4, Math.max(0.35, this.zoom * (e.deltaY > 0 ? 0.85 : 1.18)));
    }, { passive: false });
    const loop = (): void => {
      this.drawMap();
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private onDown = (e: PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.dragMoved = 0;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (this.pinch > 0) this.zoom = Math.min(4, Math.max(0.35, this.zoom * (d / this.pinch)));
      this.pinch = d;
      this.dragMoved = 99;
      return;
    }
    this.dragMoved += Math.abs(dx) + Math.abs(dy);
    const k = (devicePixelRatio || 1) / this.zoom;
    this.cx -= dx * k;
    this.cz -= dy * k;
  };

  private onUp = (e: PointerEvent): void => {
    const was = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = 0;
    if (!was || this.dragMoved > 8 || !this.canvas) return;
    // tap: toggle waypoint
    const r = this.canvas.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const x = this.cx + ((e.clientX - r.left) * dpr - this.canvas.width / 2) / this.zoom;
    const z = this.cz + ((e.clientY - r.top) * dpr - this.canvas.height / 2) / this.zoom;
    const wp = this.game.gps.waypoint;
    if (wp && Math.hypot(wp.x - x, wp.z - z) < 30 / this.zoom + 10) this.game.gps.setWaypoint(null);
    else this.game.gps.setWaypoint({ x, z });
    this.game.haptic(10);
    const tools = this.screen.querySelector('.map-tools');
    if (tools) tools.innerHTML = `<button class="btn small" data-a="zoom" data-f="1.4">＋</button><button class="btn small" data-a="zoom" data-f="0.7">－</button><button class="btn small" data-a="center">◎</button>${this.game.gps.waypoint ? '<button class="btn small" data-a="clearwp">✕ WP</button>' : ''}`;
  };

  private drawMap(): void {
    const g = this.game;
    const c = this.canvas;
    const base = g.baseMap;
    if (!c || !base) return;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#16304a';
    ctx.fillRect(0, 0, w, h);
    const Z = this.zoom;
    const sx = (x: number): number => (x - this.cx) * Z + w / 2;
    const sz = (z: number): number => (z - this.cz) * Z + h / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, sx(WORLD_MIN_X), sz(WORLD_MIN_Z), (WORLD_MAX_X - WORLD_MIN_X) * Z, (WORLD_MAX_Z - WORLD_MIN_Z) * Z);
    // route
    const route = g.minimap?.route;
    if (route && route.length > 1) {
      ctx.strokeStyle = '#c86aff';
      ctx.lineWidth = Math.max(2, 4 * dpr);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      route.forEach(([x, z], i) => (i ? ctx.lineTo(sx(x), sz(z)) : ctx.moveTo(sx(x), sz(z))));
      ctx.stroke();
    }
    // landmarks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fs = Math.round(13 * dpr);
    ctx.font = `bold ${fs}px system-ui`;
    for (const l of LANDMARKS) {
      const ic = LANDMARK_ICONS[l.kind];
      if (!ic) continue;
      const x = sx(l.x), y = sz(l.z);
      if (x < -20 || y < -20 || x > w + 20 || y > h + 20) continue;
      ctx.fillStyle = 'rgba(0,0,0,.65)';
      ctx.beginPath();
      ctx.arc(x, y, fs * 0.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = l.kind === 'safehouse' && !g.estate.owned.has(l.id) ? '#888' : ic.color;
      ctx.fillText(ic.label, x, y + 1);
      if (Z > 1.2) {
        ctx.font = `${Math.round(10 * dpr)}px system-ui`;
        ctx.fillStyle = 'rgba(255,255,255,.75)';
        ctx.fillText(l.name, x, y + fs * 1.4);
        ctx.font = `bold ${fs}px system-ui`;
      }
    }
    // dynamic blips (missions, activities, waypoint)
    const bl: Blip[] = [];
    for (const f of g.blipProviders) f(bl);
    for (const b of bl) {
      const x = sx(b.x), y = sz(b.z);
      ctx.fillStyle = b.color;
      if (b.shape === 'icon' && b.label) {
        ctx.fillStyle = 'rgba(0,0,0,.7)';
        ctx.beginPath();
        ctx.arc(x, y, fs * 0.9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = b.color;
        ctx.fillText(b.label, x, y + 1);
      } else if (b.shape === 'ring') {
        ctx.strokeStyle = b.color;
        ctx.lineWidth = 3 * dpr;
        ctx.beginPath();
        ctx.arc(x, y, (b.size ?? 5) * dpr * 1.4, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, (b.size ?? 4) * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // player arrow
    const p = g.vctrl?.vehicle?.position ?? g.player.pos;
    const yaw = g.vctrl?.vehicle?.yaw ?? g.player.yaw;
    ctx.save();
    ctx.translate(sx(p.x), sz(p.z));
    ctx.rotate(-yaw + Math.PI);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.beginPath();
    const a = 9 * dpr;
    ctx.moveTo(0, -a);
    ctx.lineTo(a * 0.7, a * 0.8);
    ctx.lineTo(0, a * 0.4);
    ctx.lineTo(-a * 0.7, a * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  update(): void {
    const g = this.game;
    if (g.input.pressed('phone') && (this.isOpen || !g.controlsLocked)) this.toggle();
  }
}
