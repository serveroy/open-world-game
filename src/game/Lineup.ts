import type { Game, System } from './Game';
import { makeAnimState, makePose, type ActionAnim, type AnimState } from '../characters/Pose';
import { policeAppearance, randomAppearance, type Appearance } from '../characters/Appearance';
import type { HeldItem } from '../characters/CharacterRenderer';
import { Rng } from '../core/rng';

/**
 * Debug: a row of characters in front of the player, each with a random outfit and a different
 * animation state (`__game.lineup()` or `?lineup=1` with `?test=1`). Used for visual QA screenshots.
 */
interface Actor {
  slot: number;
  anim: AnimState;
  held: HeldItem;
  x: number;
  z: number;
  yaw: number;
  setup: (a: AnimState, t: number) => void;
}

const CASES: { label: string; held?: HeldItem; setup: (a: AnimState, t: number) => void }[] = [
  { label: 'idle', setup: () => {} },
  { label: 'walk', setup: (a) => (a.speed = 1.4) },
  { label: 'run', setup: (a) => (a.speed = 4.6) },
  { label: 'sprint', setup: (a) => (a.speed = 7.2) },
  { label: 'pistol', held: 'pistol', setup: (a, t) => { a.aim = 'pistol'; a.aimPitch = Math.sin(t) * 0.5; } },
  { label: 'rifle', held: 'rifle', setup: (a) => (a.aim = 'rifle') },
  { label: 'phone', held: 'phone', setup: (a) => (a.action = 'phone') },
  { label: 'talk', setup: (a) => (a.action = 'talk') },
  { label: 'dance', setup: (a) => (a.action = 'dance') },
  { label: 'sit', setup: (a) => (a.action = 'sit') },
  { label: 'handsup', setup: (a) => (a.action = 'handsup') },
  { label: 'cower', setup: (a) => (a.action = 'cower') },
  { label: 'crouch', setup: (a) => (a.crouch = 1) },
  { label: 'punch', setup: (a, t) => cycle(a, 'punch', t, 0.5) },
  { label: 'bat', held: 'bat', setup: (a, t) => cycle(a, 'swing', t, 0.7) },
  { label: 'drive', setup: (a, t) => { a.driving = true; a.steer = Math.sin(t); } },
];

function cycle(a: AnimState, act: ActionAnim, t: number, dur: number): void {
  const k = (t % (dur + 0.6)) / dur;
  a.action = k <= 1 ? act : 'none';
  a.actionT = Math.min(1, k);
}

export class Lineup implements System {
  name = 'lineup';
  private actors: Actor[] = [];
  private t = 0;
  private pose = makePose();

  constructor(private game: Game, seed = 7, spacing = 1.6) {
    const rng = new Rng(seed);
    const p = game.player.pos;
    CASES.forEach((c, i) => {
      const app: Appearance = i === 5 ? policeAppearance(rng) : randomAppearance(rng);
      const slot = game.chars.alloc(app);
      if (slot < 0) return;
      const row = Math.floor(i / 8), col = i % 8;
      this.actors.push({ slot, anim: makeAnimState(), held: c.held ?? 'none', x: p.x + (col - 3.5) * spacing, z: p.z - 4 - row * 3.2, yaw: 0, setup: c.setup });
    });
  }

  get labels(): string[] {
    return CASES.map((c) => c.label);
  }

  update(dt: number): void {
    this.t += dt;
    const g = this.game;
    for (const a of this.actors) {
      const st = a.anim;
      st.speed = 0;
      st.action = 'none';
      st.aim = 'none';
      st.driving = false;
      st.crouch = 0;
      a.setup(st, this.t);
      st.time += dt;
      const y = g.world ? g.world.groundY(a.x, a.z) : 0;
      g.chars.update(a.slot, a.x, y, a.z, a.yaw, this.pose, a.held, st);
    }
  }

  dispose(): void {
    for (const a of this.actors) this.game.chars.free(a.slot);
    this.actors = [];
  }
}
