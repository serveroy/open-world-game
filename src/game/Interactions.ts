import type { Game, System } from './Game';
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

  constructor(private game: Game) {
    this.markers = new Markers(game.scene);
  }

  add(p: InteractPoint): InteractPoint {
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
        this.markers.beacon(ix, y, iz, inVeh && ip.inVehicle ? Math.max(ip.r * 0.7, 2) : 0.9, ip.color ?? 0x7dc3ff, inVeh && ip.inVehicle ? 5 : 2.2);
      }
      if (!usable || busy) continue;
      if (d < ip.r && d < bd) {
        bd = d;
        best = ip;
      }
    }
    this.markers.end(dt);
    // vehicle doors take precedence over shop prompts when on foot next to a car
    const nearCar = !inVeh && g.vctrl?.nearVehicle;
    if (nearCar && best && bd > 1.2) best = null;
    this.current = best;
    const label = best ? (typeof best.label === 'function' ? best.label() : best.label) : '';
    const button = best ? (typeof best.button === 'function' ? best.button() : best.button ?? 'USE') : 'USE';
    if (label !== this.shown) {
      this.shown = label;
      if (label) g.hud.showHelp(`${g.input.lastDevice === 'touch' ? 'Tap <b>' + button + '</b>' : g.input.lastDevice === 'gamepad' ? 'Press <b>X</b>' : 'Press <b>E</b>'} — ${label}`, 999);
      else g.hud.showHelp(null);
    }
    if (!g.theft?.busy) g.touch.setContext('interact', !!best, button);
    if (best && g.input.pressed('interact')) {
      g.hud.showHelp(null);
      this.shown = '';
      best.action();
    }
  }
}
