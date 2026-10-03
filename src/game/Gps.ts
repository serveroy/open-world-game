import type { Game, System } from './Game';

/**
 * Free-roam GPS: activity objectives and the phone-map waypoint. Story missions drive the minimap
 * route themselves; this only writes the route while no mission is running.
 */
export class Gps implements System {
  name = 'gps';
  /** Activity objective (takes priority over the waypoint). */
  objective: { x: number; z: number } | null = null;
  /** Player-placed waypoint from the phone map. */
  waypoint: { x: number; z: number } | null = null;
  private t = 0;
  private had = false;

  constructor(private game: Game) {
    game.blipProviders.push((out) => {
      if (this.waypoint) out.push({ x: this.waypoint.x, z: this.waypoint.z, color: '#c07dff', shape: 'diamond', size: 5, pin: true });
    });
  }

  setWaypoint(p: { x: number; z: number } | null): void {
    this.waypoint = p;
    this.t = 0;
  }

  update(dt: number): void {
    const g = this.game;
    if (!g.minimap || !g.world || g.missions?.active) return;
    const tgt = this.objective ?? this.waypoint;
    const pp = g.vctrl?.vehicle?.position ?? g.player.pos;
    if (this.waypoint && !this.objective && Math.hypot(pp.x - this.waypoint.x, pp.z - this.waypoint.z) < 18) {
      this.waypoint = null;
      g.hud.toast('Arrived at waypoint', 1500);
    }
    if (!tgt) {
      if (this.had) g.minimap.route = null;
      this.had = false;
      return;
    }
    this.t -= dt;
    if (this.t > 0) return;
    this.t = 1.5;
    this.had = true;
    g.minimap.route = g.world.data.graph.route(pp.x, pp.z, tgt.x, tgt.z);
  }
}
