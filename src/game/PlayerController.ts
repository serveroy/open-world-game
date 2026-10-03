import type { Game } from './Game';
import type { MoveIntent } from '../player/Player';

/**
 * Translates input into on-foot player intents and camera modes.
 * Vehicle driving, weapons and interactions plug in through Game systems.
 */
export class PlayerController {
  aiming = false;
  crouchToggle = false;
  private intent: MoveIntent = { dx: 0, dz: 0, sprint: false, jump: false, crouch: false, faceYaw: null };

  constructor(private game: Game) {}

  /** Build movement intent from input relative to the camera. */
  footIntent(): MoveIntent {
    const g = this.game;
    const inp = g.input;
    const yaw = g.cam.yaw;
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const rx = -Math.cos(yaw), rz = Math.sin(yaw);
    const mx = inp.moveX, my = inp.moveY;
    const it = this.intent;
    it.dx = fx * my + rx * mx;
    it.dz = fz * my + rz * mx;
    it.sprint = inp.down('sprint');
    it.jump = inp.pressed('jump');
    it.crouch = this.crouchToggle;
    it.faceYaw = this.aiming ? yaw : null;
    return it;
  }

  fixedUpdate(dt: number): void {
    const g = this.game;
    const p = g.player;
    if (p.mode === 'scripted') {
      p.step(dt, this.footIntent());
      return;
    }
    if (p.mode !== 'foot' && p.mode !== 'vault') return;
    const inp = g.input;
    if (g.controlsLocked) {
      const it = this.footIntent();
      it.dx = it.dz = 0;
      it.jump = false;
      it.sprint = false;
      p.step(dt, it);
      return;
    }
    if (inp.pressed('crouch')) {
      this.crouchToggle = !this.crouchToggle;
      p.crouching = this.crouchToggle;
    }
    if (inp.pressed('cover') && p.mode === 'foot' && !p.swimming) {
      const ok = p.tryCover(this.aiming ? g.cam.yaw : p.yaw);
      if (!ok) {
        const ok2 = p.tryCover(g.cam.yaw);
        if (!ok2) g.hud.toast('No cover nearby', 1200);
      }
      this.crouchToggle = p.inCover;
    }
    let it = this.footIntent();
    it = p.coverIntent(it);
    if (!p.inCover && !this.crouchToggle) p.crouching = false;
    p.step(dt, it);
  }

  update(): void {
    const g = this.game;
    const p = g.player;
    if (p.mode === 'foot' || p.mode === 'vault') {
      this.aiming = g.input.down('aim') && !p.swimming && !g.controlsLocked;
      if (g.cam.mode !== 'cutscene') g.cam.mode = this.aiming ? 'aim' : 'foot';
    }
  }
}
