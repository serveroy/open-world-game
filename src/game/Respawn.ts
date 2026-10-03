import type { Game } from './Game';
import { SPAWNS, LANDMARKS } from '../world/MapData';

/** Wasted / Busted flows and respawning. */
export class Respawn {
  private t = 0;
  private kind: 'none' | 'wasted' | 'busted' = 'none';
  private fadeStarted = false;
  onRespawn: ((kind: 'wasted' | 'busted') => void) | null = null;
  /** Mission hook: return true to handle failure/retry instead of normal respawn. */
  intercept: ((kind: 'wasted' | 'busted') => boolean) | null = null;

  constructor(private game: Game) {}

  get active(): boolean {
    return this.kind !== 'none';
  }

  wasted(cause = 'unknown'): void {
    const g = this.game;
    if (this.kind !== 'none') return;
    this.kind = 'wasted';
    this.t = 0;
    this.fadeStarted = false;
    const p = g.player;
    if (g.vctrl?.inVehicle) g.vctrl.exit(true);
    p.vitals.health = 0;
    if (g.combat) {
      p.mode = 'foot';
      g.combat.ragdollPlayer(p.vel.clone().setY(1), 99, true);
    }
    p.mode = 'dead';
    g.inputLocked = true;
    g.timeScale = 0.4;
    g.hud.big('WASTED', 'wasted', '', 4);
    g.haptic([60, 40, 120]);
    g.events.emit('playerDied', { cause });
  }

  busted(): void {
    const g = this.game;
    if (this.kind !== 'none') return;
    this.kind = 'busted';
    this.t = 0;
    this.fadeStarted = false;
    const p = g.player;
    if (g.vctrl?.inVehicle) g.vctrl.exit(true);
    p.mode = 'scripted';
    p.playAction('handsup', 99);
    g.inputLocked = true;
    g.timeScale = 0.6;
    g.hud.big('BUSTED', 'busted', '', 4);
    g.events.emit('playerBusted', {});
  }

  update(dt: number): void {
    if (this.kind === 'none') return;
    const g = this.game;
    this.t += dt / Math.max(0.2, g.timeScale);
    if (this.t > 2.6 && !this.fadeStarted) {
      this.fadeStarted = true;
      g.hud.fade(1, 700);
    }
    if (this.t > 3.6) this.finish();
  }

  private finish(): void {
    const g = this.game;
    const kind = this.kind as 'wasted' | 'busted';
    this.kind = 'none';
    g.timeScale = 1;
    g.inputLocked = false;
    const p = g.player;
    g.combat?.ragdolls.remove(p.slot);
    p.mode = 'foot';
    p.setCollisionEnabled(true);
    p.anim.action = 'none';
    p.actionTimer = 0;
    p.vitals.reset();
    p.vitals.armor = kind === 'busted' ? 0 : p.vitals.armor;
    const handled = this.intercept?.(kind) ?? false;
    if (!handled) {
      if (kind === 'wasted') {
        const sp = SPAWNS.hospital;
        const at = { x: p.pos.x, z: p.pos.z };
        const home = g.saves.nearestSafehouse(at.x, at.z);
        if (home && Math.hypot(home.x - at.x, home.z - at.z) < Math.hypot(sp.x - at.x, sp.z - at.z)) {
          // a closer safehouse: a street medic patches you up at home for a smaller fee
          const fee = g.wallet.take(Math.min(250, g.wallet.cash), 'Medic house call');
          g.teleport(home.x, home.z, home.yaw);
          g.hud.toast(`A medic patched you up at your safehouse. Fee: $${fee}`, 4000);
        } else {
          const fee = g.wallet.take(Math.min(500, g.wallet.cash), 'Hospital bill');
          g.teleport(sp.x, sp.z, sp.yaw);
          g.hud.toast(`Solano General patched you up. Bill: $${fee}`, 4000);
        }
      } else {
        const fine = g.wallet.take(Math.min(5000, Math.floor(g.wallet.cash * 0.1)), 'Bail');
        g.combat?.arsenal.strip();
        const sp = SPAWNS.police;
        g.teleport(sp.x, sp.z, sp.yaw);
        g.hud.toast(`Released on bail ($${fine}). Your weapons were confiscated.`, 4000);
      }
      g.events.emit('playerRespawned', { where: kind === 'wasted' ? 'hospital' : 'police' });
    }
    g.vehicles?.clearTraffic();
    g.combat?.clearWorldFx();
    g.hud.fade(0, 900);
    this.onRespawn?.(kind);
  }

  /** Nearest landmark of a kind (for respawn alternatives). */
  static nearest(kind: string, x: number, z: number): { x: number; z: number } {
    let best = { x: SPAWNS.hospital.x, z: SPAWNS.hospital.z }, bd = Infinity;
    for (const l of LANDMARKS) if (l.kind === kind) {
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bd) {
        bd = d;
        best = { x: l.x, z: l.z };
      }
    }
    return best;
  }
}
