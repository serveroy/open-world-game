import type { Game } from '../game/Game';
import { SaveManager } from '../game/SaveManager';
import type { SaveData } from '../core/SaveSystem';
import { formatMoney } from '../core/math';

/** Request fullscreen + landscape lock (must run inside a user gesture). */
export function goFullscreen(): void {
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return;
  const de = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (!document.fullscreenElement) {
      const p = de.requestFullscreen ? de.requestFullscreen({ navigationUI: 'hide' }) : (de.webkitRequestFullscreen?.(), undefined);
      void Promise.resolve(p).then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape')).catch(() => undefined);
    }
  } catch {
    /* unsupported (iOS Safari): the rotate hint covers portrait */
  }
}

const CONTROLS = `<h3>Keyboard & mouse</h3><div class="muted">WASD move/drive · Mouse look · LMB attack · RMB aim · Space jump/handbrake · Shift sprint · Alt walk · F enter/exit vehicle · E use · R reload · Q cover · Ctrl crouch · Tab weapon wheel · T switch target · C camera · H horn · N radio · M phone · Esc pause · Enter skip dialogue</div>
<h3>Gamepad</h3><div class="muted">LS move · RS look · RT attack/gas · LT aim/brake · A jump · B enter/exit · X use/reload · Y cover · LB weapon wheel · RB switch target · D-pad radio/horn/weapons · Back phone · Start pause</div>
<h3>Touch</h3><div class="muted">Left half: floating joystick (push lightly to walk, fully to run, all the way up to sprint) · Right half: drag to look, swipe to switch targets · Buttons appear when they're useful (ENTER, USE, reload…) · 📱 phone · II pause · Tilt aiming available in Settings</div>`;

/** Title screen (New / Continue / Load) and pause menu. */
export class Menus {
  readonly title: HTMLDivElement;
  readonly pause: HTMLDivElement;
  private help: HTMLDivElement;
  private orbit = 0;
  private latest: { slot: string; data: SaveData } | null = null;

  constructor(private game: Game) {
    this.title = document.createElement('div');
    this.title.className = 'title';
    this.title.style.display = 'none';
    game.container.appendChild(this.title);
    this.pause = document.createElement('div');
    this.pause.className = 'panel pause';
    game.container.appendChild(this.pause);
    this.help = document.createElement('div');
    this.help.className = 'panel';
    this.help.innerHTML = `<div class="box"><h2>CONTROLS</h2>${CONTROLS}<div style="text-align:right;margin-top:12px"><button class="btn primary" data-a="close">Back</button></div></div>`;
    game.container.appendChild(this.help);
    for (const el of [this.title, this.pause, this.help]) {
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
        if (a) this.action(a);
      });
    }
  }

  get titleOpen(): boolean {
    return this.game.ui.has(this.title);
  }

  async showTitle(): Promise<void> {
    const g = this.game;
    this.latest = await g.saves.store.latest();
    const l = this.latest;
    this.title.innerHTML = `<h1>CRIMSON COAST</h1><div class="tag">PORT SOLANO · ${new Date().getFullYear()}</div>
      <div class="btns">
        ${l ? `<button class="btn primary" data-a="continue">▶ Continue<small>${l.data.slotName} · ${formatMoney(l.data.cash)}</small></button>` : ''}
        <button class="btn ${l ? '' : 'primary'}" data-a="new">✦ New Game</button>
        ${l ? '<button class="btn" data-a="load">⤓ Load Game</button>' : ''}
        <button class="btn" data-a="settings">⚙ Settings</button>
        <button class="btn" data-a="controls">⌨ Controls</button>
      </div>
      <div class="foot">An original open-world story. All characters, places and vehicles are fictional.</div>`;
    this.title.style.display = '';
    g.hud.setVisible(false);
    g.ui.push({ el: this.title, pauses: true, onBack: () => false });
    (this.title.querySelector('.btn') as HTMLElement | null)?.focus();
  }

  private startPlaying(): void {
    const g = this.game;
    goFullscreen();
    g.ui.pop(this.title);
    this.title.style.display = 'none';
    g.saves.enabled = true;
    g.cam.snapBehind(g.player.yaw);
    g.hud.setVisible(true);
  }

  private async loadSlot(slot: string): Promise<void> {
    const g = this.game;
    const d = await g.saves.store.load(slot);
    if (!d) {
      g.hud.toast('That save could not be read', 2000);
      return;
    }
    if (this.titleOpen) {
      g.saves.apply(d);
      this.startPlaying();
      g.hud.toast(`Loaded "${d.slotName}"`, 2200);
    } else g.saves.loadViaReload(slot);
  }

  private loadPicker(): void {
    const g = this.game;
    void g.saves.store.list().then((list) => {
      g.shopUI.open({
        title: 'Load Game', subtitle: `${list.length} save${list.length === 1 ? '' : 's'}`,
        tabs: [{ id: 'slots', label: 'Saves', items: () => list.map((x) => ({ id: x.slot, cat: 'slot', name: `${x.slot === 'auto' ? '⟳ Autosave' : x.data.slotName}`, price: 0, owned: true, badge: '', desc: `${new Date(x.data.savedAt).toLocaleString()} · ${formatMoney(x.data.cash)}` })) }],
        buyLabel: () => 'LOAD',
        onBuy: (it) => {
          g.ui.pop(g.shopUI.el);
          void this.loadSlot(it.id);
          return null;
        },
      });
    });
  }

  private action(a: string): void {
    const g = this.game;
    switch (a) {
      case 'continue':
        if (this.latest) void this.loadSlot(this.latest.slot);
        break;
      case 'new':
        if (this.titleOpen) this.startPlaying();
        else g.saves.loadViaReload(null);
        break;
      case 'load':
        this.loadPicker();
        break;
      case 'settings':
        g.settingsUI.open();
        break;
      case 'controls':
        g.ui.push({ el: this.help });
        break;
      case 'close':
        g.ui.pop(this.help);
        break;
      case 'resume':
        g.ui.pop(this.pause);
        break;
      case 'map':
        g.ui.pop(this.pause);
        g.phone.open('map');
        break;
      case 'save':
        if (!g.saves.safeToSave()) g.hud.toast('Can\'t save during a mission, job or police chase', 2200);
        else g.saves.slotPicker('Save Game');
        break;
      case 'quit':
        if (g.saves.safeToSave()) void g.saves.save('auto').then(() => location.reload());
        else location.reload();
        break;
    }
  }

  openPause(): void {
    const g = this.game;
    const st = g.missions?.runner.state === 'running' ? 'On a mission' : g.activities?.current ? g.activities.current.title : 'Free roam';
    this.pause.innerHTML = `<div class="box" style="max-width:420px"><h2>PAUSED</h2><div class="muted">${st} · Story ${g.saves.progressText()} · ${formatMoney(g.wallet.cash)}</div>
      <div class="btns col">
        <button class="btn primary" data-a="resume">▶ Resume</button>
        <button class="btn" data-a="map">🗺 Map</button>
        <button class="btn" data-a="save">💾 Save</button>
        <button class="btn" data-a="load">⤓ Load</button>
        <button class="btn" data-a="settings">⚙ Settings</button>
        <button class="btn" data-a="controls">⌨ Controls</button>
        <button class="btn" data-a="quit">⏏ Quit to title</button>
      </div></div>`;
    g.ui.push({ el: this.pause, pauses: true });
    (this.pause.querySelector('.btn') as HTMLElement | null)?.focus();
  }

  /** Free-roam pause key (ignored while other screens are open). */
  update(): void {
    const g = this.game;
    if (!g.ui.open && g.input.pressed('pause') && !g.respawn.active) this.openPause();
  }

  /** Slow orbit around the player behind the title screen. */
  updateTitle(dt: number): void {
    if (!this.titleOpen) return;
    const g = this.game;
    this.orbit += dt * 0.06;
    const p = g.player.pos;
    const cam = g.renderer.camera;
    cam.position.set(p.x + Math.sin(this.orbit) * 38, p.y + 16, p.z + Math.cos(this.orbit) * 38);
    cam.lookAt(p.x, p.y + 4, p.z);
  }

  static pendingLoad(): string | null {
    return SaveManager.takePending();
  }
}
