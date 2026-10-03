import type { Game } from '../game/Game';
import { LANDMARKS, type Landmark } from '../world/MapData';
import { judgeBeat } from './logic';
import { formatMoney } from '../core/math';
import { Rng } from '../core/rng';

const rng = new Rng(2024);
const DIRS = ['←', '↑', '→', '↓'] as const;
const KEYS: Record<string, number> = { ArrowLeft: 0, KeyA: 0, ArrowUp: 1, KeyW: 1, ArrowRight: 2, KeyD: 2, ArrowDown: 3, KeyS: 3 };
const PAD: Record<number, number> = { 14: 0, 12: 1, 15: 2, 13: 3 };
const DRINK_PRICE = 25;
const VIP_PRICE = 300;
const BPM = 116;

interface Note { t: number; dir: number; el: HTMLElement; judged: boolean }

/**
 * Club Halcyon & The Ember Room: walk in at night for the dance-floor rhythm game, the bar and the
 * VIP lounge. The lounge is implied entirely off-screen (fade to black, time passes).
 */
export class Nightlife {
  private el: HTMLDivElement;
  private club: Landmark | null = null;
  private dancing = false;
  private notes: Note[] = [];
  private songT = 0;
  private score = 0;
  private combo = 0;
  private best = 0;
  private drinks = 0;
  private tipsyT = 0;
  private padPrev: boolean[] = [];
  private raf = 0;
  private lastT = 0;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'club';
    game.container.appendChild(this.el);
    for (const l of LANDMARKS) {
      if (l.kind !== 'club') continue;
      game.interactions.add({
        id: l.id, x: l.x, z: l.z, r: 2.2, color: 0xff2a8a, button: 'ENTER',
        label: () => (this.isOpen() ? `Enter ${l.name}` : `${l.name} — opens at 20:00`),
        action: () => (this.isOpen() ? this.enter(l) : game.hud.toast(`${l.name} is closed. Doors open at 20:00.`, 2000)),
      });
    }
    this.el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a="dir"]');
      if (t) this.hit(Number(t.dataset.d));
    });
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      if (!t) return;
      const a = t.dataset.a!;
      if (a === 'dance') this.startDance();
      else if (a === 'bar') this.drink();
      else if (a === 'vip') this.vip();
      else if (a === 'leave') this.game.ui.pop(this.el);
    });
    addEventListener('keydown', (e) => {
      if (!this.dancing) return;
      const d = KEYS[e.code];
      if (d !== undefined && !e.repeat) {
        e.preventDefault();
        this.hit(d);
      }
    });
  }

  isOpen(): boolean {
    const h = this.game.env?.clock.hour ?? 22;
    return h >= 20 || h < 5;
  }

  get tipsy(): number {
    return this.tipsyT;
  }

  private enter(l: Landmark): void {
    const g = this.game;
    if ((g.police?.wanted.stars ?? 0) > 0) {
      g.hud.toast('The bouncer shakes his head. "Not with that heat on you."', 2400);
      return;
    }
    this.club = l;
    g.audio.setClub(true, l.id === 'club_ember' ? 2 : 0);
    g.hud.fade(1, 400);
    setTimeout(() => {
      this.menu();
      g.ui.push({
        el: this.el, pauses: true,
        onBack: () => {
          if (this.dancing) {
            this.stopDance(false);
            return false;
          }
          return true;
        },
        onClose: () => this.leave(),
      });
      g.hud.fade(0, 500);
    }, 420);
  }

  private leave(): void {
    const g = this.game;
    this.stopDance(false);
    cancelAnimationFrame(this.raf);
    g.hud.fade(1, 0);
    g.hud.fade(0, 700);
    if (this.drinks >= 3) {
      this.tipsyT = 50;
      g.container.classList.add('tipsy');
      g.hud.toast('The street is spinning a little…', 2200);
    }
    this.drinks = 0;
    this.club = null;
    g.audio.setClub(false, -1);
  }

  private menu(): void {
    const l = this.club!;
    const g = this.game;
    this.el.innerHTML = `<div class="club-bg ${l.id}"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="club-ui">
        <h2>${l.name}</h2>
        <div class="muted">${g.env?.clock.text() ?? ''} · ${formatMoney(g.wallet.cash)}</div>
        <div class="club-opts">
          <button class="btn primary" data-a="dance">💃 Hit the dance floor</button>
          <button class="btn" data-a="bar">🍸 Bar — ${formatMoney(DRINK_PRICE)}</button>
          <button class="btn" data-a="vip">🛋️ VIP lounge — ${formatMoney(VIP_PRICE)}</button>
          <button class="btn" data-a="leave">🚪 Leave</button>
        </div>
        <div class="club-msg muted"></div>
      </div>`;
  }

  private msg(t: string): void {
    const m = this.el.querySelector('.club-msg');
    if (m) m.textContent = t;
  }

  private drink(): void {
    const g = this.game;
    if (!g.wallet.spend(DRINK_PRICE, 'Club bar')) return this.msg('You can\'t cover the tab.');
    this.drinks++;
    g.player.vitals.health = Math.min(g.player.vitals.maxHealth, g.player.vitals.health + 15);
    this.msg(this.drinks >= 3 ? 'The bartender slides you another. Your feet feel lighter.' : rng.pick(['"On the rocks."', 'Something blue with an umbrella.', '"Make it a double."']));
    this.menu();
    this.msg(this.drinks >= 3 ? 'Things are getting blurry around the edges.' : 'Cheers.');
  }

  private vip(): void {
    const g = this.game;
    if (!g.wallet.spend(VIP_PRICE, 'VIP lounge')) return this.msg('"VIP means you pay, sweetheart."');
    const black = document.createElement('div');
    black.className = 'club-fade';
    black.innerHTML = '<div>Later that night…</div>';
    this.el.appendChild(black);
    requestAnimationFrame(() => black.classList.add('on'));
    setTimeout(() => {
      if (g.env) g.env.clock.totalHours += 2;
      g.player.vitals.health = g.player.vitals.maxHealth;
      g.stats.inc('vipNights');
      black.classList.remove('on');
      setTimeout(() => black.remove(), 700);
      this.menu();
      this.msg('You feel relaxed. Two hours went by somehow.');
    }, 2600);
  }

  // --------------------------------------------------------------- rhythm game
  private startDance(): void {
    this.dancing = true;
    this.score = 0;
    this.combo = 0;
    this.best = 0;
    this.songT = -1.5;
    const beat = 60 / BPM;
    this.el.querySelector('.club-ui')!.innerHTML = `<h2>DANCE!</h2><div class="dance-score">0</div>
      <div class="lane"><div class="hitline"></div></div>
      <div class="dance-pad">${DIRS.map((d, i) => `<button class="btn" data-a="dir" data-d="${i}">${d}</button>`).join('')}</div>
      <div class="muted">Hit the arrow as it crosses the line · arrows / WASD / D-pad / tap</div>`;
    const lane = this.el.querySelector('.lane') as HTMLElement;
    this.notes = [];
    for (let i = 0; i < 28; i++) {
      const el = document.createElement('div');
      const dir = i > 0 && rng.chance(0.3) ? this.notes[i - 1]!.dir : Math.floor(rng.next() * 4);
      el.className = `note d${dir}`;
      el.textContent = DIRS[dir]!;
      lane.appendChild(el);
      this.notes.push({ t: i * beat * (i > 16 ? 0.75 : 1) + (i > 16 ? 16 * beat * 0.25 : 0), dir, el, judged: false });
    }
    this.lastT = performance.now();
    const loop = (): void => {
      if (!this.dancing) return;
      const now = performance.now();
      this.tick((now - this.lastT) / 1000);
      this.lastT = now;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  private tick(dt: number): void {
    this.songT += Math.min(dt, 0.05);
    // gamepad d-pad
    const gp = navigator.getGamepads?.().find((p) => p && p.connected);
    if (gp) {
      for (const [b, d] of Object.entries(PAD)) {
        const down = !!gp.buttons[Number(b)]?.pressed;
        if (down && !this.padPrev[Number(b)]) this.hit(d);
        this.padPrev[Number(b)] = down;
      }
    }
    for (const n of this.notes) {
      const dtn = n.t - this.songT;
      n.el.style.transform = `translate(${n.dir * 70 - 105}px, ${-dtn * 220}px)`;
      n.el.style.opacity = n.judged ? '0' : dtn > 2.4 ? '0' : '1';
      if (!n.judged && dtn < -0.2) {
        n.judged = true;
        this.combo = 0;
        this.flash('miss');
      }
    }
    const last = this.notes[this.notes.length - 1]!;
    if (this.songT > last.t + 0.8) this.stopDance(true);
  }

  private hit(dir: number): void {
    if (!this.dancing) return;
    let best: Note | null = null, bd = Infinity;
    for (const n of this.notes) {
      if (n.judged) continue;
      const o = Math.abs(n.t - this.songT);
      if (o < bd) {
        bd = o;
        best = n;
      }
    }
    if (!best || bd > 0.35) return;
    const j = best.dir === dir ? judgeBeat(best.t - this.songT) : 'miss';
    best.judged = true;
    if (j === 'miss') this.combo = 0;
    else {
      this.combo++;
      this.best = Math.max(this.best, this.combo);
      this.score += (j === 'perfect' ? 100 : 50) * (1 + Math.floor(this.combo / 8) * 0.5);
    }
    this.flash(j);
    if (j !== 'miss') this.game.haptic(8);
  }

  private flash(j: string): void {
    const s = this.el.querySelector('.dance-score');
    if (s) s.innerHTML = `${Math.round(this.score)}<small>${j.toUpperCase()}${this.combo > 2 ? ` · ${this.combo}×` : ''}</small>`;
  }

  private stopDance(finished: boolean): void {
    if (!this.dancing) return;
    this.dancing = false;
    cancelAnimationFrame(this.raf);
    const g = this.game;
    if (!this.club) return;
    this.menu();
    if (!finished) return;
    const sc = Math.round(this.score);
    if (sc >= 2200) {
      g.wallet.add(200, 'Dance-off');
      g.stats.inc('dances');
      this.msg(`Score ${sc} (best combo ${this.best}). The crowd goes wild — someone tips you ${formatMoney(200)}.`);
    } else this.msg(`Score ${sc} (best combo ${this.best}). ${sc > 1200 ? 'Not bad at all.' : 'Maybe another drink first?'}`);
    g.activities?.best('dance_best', sc, false);
  }

  update(dt: number): void {
    if (this.tipsyT > 0) {
      this.tipsyT -= dt;
      this.game.cam.addShake(0.02);
      if (this.tipsyT <= 0) this.game.container.classList.remove('tipsy');
    }
  }
}
