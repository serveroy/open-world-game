import * as THREE from 'three';
import type { Game, System } from './Game';
import { LANDMARKS } from '../world/MapData';

const _p = new THREE.Vector3();
import { Markers } from '../ui/Markers';

export interface InteractPoint {
  id: string;
  x: number;
  z: number;
  /** Activation radius (m). */
  r: number;
  /** Prompt text, e.g. "Enter Fade Factory". */
  label: string | (() => string);
  /** Touch button caption. */
  button?: string | (() => string);
  color?: number;
  /** Usable on foot / in a vehicle. */
  onFoot?: boolean;
  inVehicle?: boolean;
  /** Draw a ground beacon (default true). */
  beacon?: boolean;
  enabled?: () => boolean;
  /** Dynamic position (e.g. the player's taxi); null = unavailable. Overrides x/z. */
  at?: () => { x: number; z: number } | null;
  /** Stay usable while a side activity is running. */
  always?: boolean;
  /** Place name for the floating world label (defaults to the landmark's name for landmark ids). */
  title?: string;
  action: () => void;
}

/**
 * Contextual "press USE" points in the world: shop doors, safehouse beds, garages, business tills,
 * clubs and activity starts. Shows a beacon + help prompt and lights the touch USE button.
 */
export class Interactions implements System {
  name = 'interactions';
  readonly points: InteractPoint[] = [];
  private markers: Markers;
  private current: InteractPoint | null = null;
  private shown = '';
  private shownHtml = '';

  private labels: HTMLDivElement[] = [];
  private near: { ip: InteractPoint; x: number; z: number; d: number }[] = [];

  constructor(private game: Game) {
    this.markers = new Markers(game.scene);
    for (let i = 0; i < 3; i++) {
      const el = document.createElement('div');
      el.className = 'place-label';
      el.style.display = 'none';
      game.hud.root.appendChild(el);
      this.labels.push(el);
    }
  }

  add(p: InteractPoint): InteractPoint {
    if (!p.title) {
      const id = p.id.split(':')[0]!;
      const l = LANDMARKS.find((x) => x.id === id);
      if (l) p.title = p.id.endsWith(':garage') ? `${l.name} · Garage` : l.name;
    }
    this.points.push(p);
    return p;
  }

  remove(id: string): void {
    const i = this.points.findIndex((p) => p.id === id);
    if (i >= 0) this.points.splice(i, 1);
  }

  get active(): InteractPoint | null {
    return this.current;
  }

  update(dt: number): void {
    const g = this.game;
    const p = g.player;
    const inVeh = !!g.vctrl?.inVehicle;
    const pos = inVeh ? g.vctrl!.vehicle!.position : p.pos;
    const busy = g.controlsLocked || g.ui.open || g.respawn.active || p.mode === 'ragdoll' || p.mode === 'dead' || (g.missions?.active ?? false);
    const actBusy = !!g.activities?.current;
    this.markers.begin();
    this.near.length = 0;
    let best: InteractPoint | null = null;
    let bd = Infinity;
    for (const ip of this.points) {
      let ix = ip.x, iz = ip.z;
      if (ip.at) {
        const a = ip.at();
        if (!a) continue;
        ix = a.x;
        iz = a.z;
      }
      const d = Math.hypot(pos.x - ix, pos.z - iz);
      if (d > 90) continue;
      if (actBusy && !ip.always) continue;
      if (ip.enabled && !ip.enabled()) continue;
      const usable = inVeh ? !!ip.inVehicle : ip.onFoot !== false;
      if (ip.beacon !== false && (!g.missions?.active)) {
        const y = g.world ? Math.max(g.world.groundY(ix, iz), 0.16) : 0;
        this.markers.beacon(ix, y, iz, inVeh && ip.inVehicle ? Math.min(2.6, Math.max(ip.r * 0.55, 1.6)) : 0.9, ip.color ?? 0x7dc3ff, inVeh && ip.inVehicle ? 3.2 : 2.2);
      }
      if (ip.title && d < (inVeh ? 70 : 45) && !g.missions?.active) this.near.push({ ip, x: ix, z: iz, d });
      if (!usable || busy) continue;
      if (d < ip.r && d < bd) {
        bd = d;
        best = ip;
      }
    }
    this.markers.end(dt);
    this.drawLabels(busy && !g.vctrl?.inVehicle);
    // vehicle doors take precedence over shop prompts when on foot next to a car
    const nearCar = !inVeh && g.vctrl?.nearVehicle;
    if (nearCar && best && bd > 1.2) best = null;
    this.current = best;
    const label = best ? (typeof best.label === 'function' ? best.label() : best.label) : '';
    const button = best ? (typeof best.button === 'function' ? best.button() : best.button ?? 'USE') : 'USE';
    if (label !== this.shown) {
      if (this.shownHtml) g.hud.clearHelpIf(this.shownHtml);
      this.shown = label;
      this.shownHtml = label ? `${g.input.lastDevice === 'touch' ? 'Tap <b>' + button + '</b>' : g.input.lastDevice === 'gamepad' ? 'Press <b>X</b>' : 'Press <b>E</b>'} — ${label}` : '';
      if (label) g.hud.showHelp(this.shownHtml, 999);
    }
    if (!g.theft?.busy) {
      g.touch.setContext('interact', !!best && !inVeh, button);
      g.touch.setContext('vinteract', !!best && inVeh, button);
    }
    if (best && g.input.pressed('interact')) {
      g.hud.clearHelpIf(this.shownHtml);
      this.shown = this.shownHtml = '';
      best.action();
    }
  }

  /** Floating name + "what you can do here" labels over the nearest places. */
  private drawLabels(hidden: boolean): void {
    const g = this.game;
    const cam = g.renderer.camera;
    this.near.sort((a, b) => a.d - b.d);
    for (let i = 0; i < this.labels.length; i++) {
      const el = this.labels[i]!;
      const n = this.near[i];
      if (!n || hidden || g.ui.open) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      const y = g.world ? Math.max(g.world.groundY(n.x, n.z), 0) : 0;
      _p.set(n.x, y + 7.2, n.z).project(cam); // above the storefront sign
      if (_p.z > 1 || Math.abs(_p.x) > 1.1 || Math.abs(_p.y) > 1.1) {
        el.style.display = 'none';
        continue;
      }
      const ip = n.ip;
      const what = typeof ip.label === 'function' ? ip.label() : ip.label;
      const html = `<b>${ip.title}</b><span>${what}</span>`;
      if (el.dataset.h !== html) {
        el.dataset.h = html;
        el.innerHTML = html;
      }
      const c = '#' + (ip.color ?? 0x7dc3ff).toString(16).padStart(6, '0');
      el.style.setProperty('--c', c);
      el.style.display = '';
      el.style.opacity = String(Math.max(0.35, Math.min(1, 1.25 - n.d / 50)));
      el.style.transform = `translate(-50%, -100%) translate(${((_p.x + 1) / 2) * innerWidth}px, ${((1 - _p.y) / 2) * innerHeight}px)`;
    }
  }
}
