import type { Game } from '../game/Game';
import { DEFAULT_SETTINGS, type SettingsData } from '../core/Settings';

type Row =
  | { k: keyof SettingsData; label: string; type: 'range'; min: number; max: number; step: number; fmt?: (v: number) => string; restart?: boolean }
  | { k: keyof SettingsData; label: string; type: 'toggle'; restart?: boolean }
  | { k: keyof SettingsData; label: string; type: 'select'; options: [string | number, string][]; restart?: boolean }
  | { k: 'hud.buttonScale' | 'hud.opacity'; label: string; type: 'hudrange'; min: number; max: number; step: number }
  | { k: 'hud.leftHanded'; label: string; type: 'hudtoggle' };

const pct = (v: number): string => `${Math.round(v * 100)}%`;
const TABS: { id: string; label: string; rows: Row[] }[] = [
  {
    id: 'gfx', label: 'Graphics', rows: [
      { k: 'quality', label: 'Quality preset', type: 'select', options: [['auto', 'Auto'], ['low', 'Low'], ['med', 'Medium'], ['high', 'High']], restart: true },
      { k: 'dynamicResolution', label: 'Dynamic resolution', type: 'toggle' },
      { k: 'fpsCap', label: 'Frame-rate cap', type: 'select', options: [[60, '60 FPS'], [30, '30 FPS (battery)'], [0, 'Uncapped']] },
      { k: 'shadows', label: 'Shadows', type: 'toggle', restart: true },
      { k: 'bloom', label: 'Bloom & post FX (High)', type: 'toggle' },
      { k: 'viewDistance', label: 'View distance', type: 'range', min: 0.5, max: 1.5, step: 0.1, fmt: pct },
      { k: 'showFps', label: 'Show FPS counter', type: 'toggle' },
    ],
  },
  {
    id: 'audio', label: 'Audio', rows: [
      { k: 'masterVolume', label: 'Master volume', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'musicVolume', label: 'Radio / music', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'sfxVolume', label: 'Effects', type: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
      { k: 'voice', label: 'Dialogue voices', type: 'select', options: [['speech', 'Spoken (device voice)'], ['babble', 'Babble'], ['off', 'Off']] },
      { k: 'radioStation', label: 'Default station', type: 'select', options: [[0, 'Neon FM'], [1, 'Dust Radio'], [2, 'Low Tide'], [3, 'Radio off']] },
    ],
  },
  {
    id: 'ctrl', label: 'Controls', rows: [
      { k: 'lookSensitivity', label: 'Look sensitivity', type: 'range', min: 0.3, max: 2.5, step: 0.05, fmt: (v) => v.toFixed(2) },
      { k: 'aimSensitivity', label: 'Aim sensitivity', type: 'range', min: 0.3, max: 2, step: 0.05, fmt: (v) => v.toFixed(2) },
      { k: 'invertY', label: 'Invert look Y', type: 'toggle' },
      { k: 'aimAssist', label: 'Aim assist', type: 'select', options: [['full', 'Full lock-on'], ['light', 'Light (slow-down)'], ['off', 'Off']] },
      { k: 'gyroAim', label: 'Gyro aiming (phones)', type: 'toggle' },
      { k: 'haptics', label: 'Vibration / rumble', type: 'toggle' },
      { k: 'screenShake', label: 'Screen shake', type: 'range', min: 0, max: 1.5, step: 0.1, fmt: pct },
    ],
  },
  {
    id: 'access', label: 'Accessibility', rows: [
      { k: 'subtitles', label: 'Subtitles', type: 'toggle' },
      { k: 'subtitleSize', label: 'Subtitle size', type: 'range', min: 0.8, max: 1.8, step: 0.1, fmt: pct },
      { k: 'colorblind', label: 'Colour-blind mode', type: 'select', options: [['off', 'Off'], ['protanopia', 'Protanopia'], ['deuteranopia', 'Deuteranopia'], ['tritanopia', 'Tritanopia']] },
      { k: 'units', label: 'Units', type: 'select', options: [['metric', 'km/h'], ['imperial', 'mph']] },
      { k: 'dayLengthMinutes', label: 'Day length', type: 'range', min: 12, max: 60, step: 4, fmt: (v) => `${v} min` },
    ],
  },
  {
    id: 'hud', label: 'HUD & Touch', rows: [
      { k: 'hud.buttonScale', label: 'Button size', type: 'hudrange', min: 0.7, max: 1.5, step: 0.05 },
      { k: 'hud.opacity', label: 'Button opacity', type: 'hudrange', min: 0.3, max: 1, step: 0.05 },
      { k: 'hud.leftHanded', label: 'Left-handed layout', type: 'hudtoggle' },
    ],
  },
];

/** Settings screen with live-applied options and the touch HUD layout editor. */
export class SettingsUI {
  readonly el: HTMLDivElement;
  private tab = 'gfx';
  private restart = false;
  private editBar: HTMLDivElement;

  constructor(private game: Game) {
    this.el = document.createElement('div');
    this.el.className = 'panel settings';
    game.container.appendChild(this.el);
    this.editBar = document.createElement('div');
    this.editBar.className = 'edit-bar';
    this.editBar.innerHTML = `<span>Drag buttons to move them</span><button class="btn small" data-e="reset">Reset</button><button class="btn small primary" data-e="done">Done</button>`;
    game.container.appendChild(this.editBar);
    this.editBar.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.editBar.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-e]')?.dataset.e;
      if (a === 'reset') {
        game.settings.data.hud.offsets = {};
        game.settings.save();
      } else if (a === 'done') this.endEdit();
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-a]');
      if (!t) return;
      const a = t.dataset.a;
      if (a === 'tab') {
        this.tab = t.dataset.id!;
        this.render();
      } else if (a === 'close') game.ui.pop(this.el);
      else if (a === 'edit') this.beginEdit();
      else if (a === 'testsound') game.audio.test();
      else if (a === 'reload') location.reload();
      else if (a === 'defaults') {
        game.settings.reset();
        this.render();
      }
    });
    this.el.addEventListener('input', (e) => this.onInput(e.target as HTMLInputElement | HTMLSelectElement));
    this.el.addEventListener('change', (e) => this.onInput(e.target as HTMLInputElement | HTMLSelectElement));
  }

  open(): void {
    this.render();
    this.game.ui.push({ el: this.el, pauses: true });
  }

  private value(r: Row): unknown {
    const d = this.game.settings.data;
    if (r.k.startsWith('hud.')) return d.hud[r.k.slice(4) as 'buttonScale'];
    return d[r.k as keyof SettingsData];
  }

  private onInput(t: HTMLInputElement | HTMLSelectElement): void {
    const key = t.dataset.k;
    if (!key) return;
    const s = this.game.settings;
    const row = TABS.flatMap((x) => x.rows).find((r) => r.k === key);
    if (!row) return;
    let v: unknown;
    if (row.type === 'toggle' || row.type === 'hudtoggle') v = (t as HTMLInputElement).checked;
    else if (row.type === 'range' || row.type === 'hudrange') v = Number(t.value);
    else {
      const def = DEFAULT_SETTINGS[row.k as keyof SettingsData];
      v = typeof def === 'number' ? Number(t.value) : t.value;
    }
    if (key.startsWith('hud.')) (s.data.hud as unknown as Record<string, unknown>)[key.slice(4)] = v;
    else (s.data as unknown as Record<string, unknown>)[key] = v;
    s.save();
    if ('restart' in row && row.restart) this.restart = true;
    const out = this.el.querySelector(`[data-out="${key}"]`);
    if (out && (row.type === 'range' || row.type === 'hudrange')) out.textContent = row.type === 'range' && row.fmt ? row.fmt(v as number) : pct(v as number);
    const note = this.el.querySelector('.restart-note') as HTMLElement | null;
    if (note) note.style.display = this.restart ? '' : 'none';
  }

  private render(): void {
    const tab = TABS.find((t) => t.id === this.tab)!;
    const rows = tab.rows.map((r) => {
      const v = this.value(r);
      let ctl = '';
      if (r.type === 'toggle' || r.type === 'hudtoggle') ctl = `<input type="checkbox" data-k="${r.k}" ${v ? 'checked' : ''}>`;
      else if (r.type === 'range' || r.type === 'hudrange') {
        const txt = r.type === 'range' && r.fmt ? r.fmt(v as number) : pct(v as number);
        ctl = `<span class="muted" data-out="${r.k}">${txt}</span><input type="range" data-k="${r.k}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}">`;
      } else ctl = `<select data-k="${r.k}">${r.options.map(([val, lab]) => `<option value="${val}" ${String(val) === String(v) ? 'selected' : ''}>${lab}</option>`).join('')}</select>`;
      return `<div class="row"><label>${r.label}${'restart' in r && r.restart ? ' <span class="muted">(restart)</span>' : ''}</label><span class="ctl">${ctl}</span></div>`;
    }).join('');
    const extra = this.tab === 'audio'
      ? `<div class="row"><label>Can't hear anything? On iPhone, check the volume buttons; the silent switch is handled automatically.</label><button class="btn small primary" data-a="testsound">🔊 Test sound</button></div>`
      : this.tab === 'hud' ? `<div class="row"><label>Custom button layout</label><button class="btn small primary" data-a="edit">✥ Edit layout</button></div>` : '';
    this.el.innerHTML = `<div class="box"><h2>SETTINGS</h2>
      <div class="tabs">${TABS.map((t) => `<button class="btn small${t.id === this.tab ? ' sel' : ''}" data-a="tab" data-id="${t.id}">${t.label}</button>`).join('')}</div>
      ${rows}${extra}
      <div class="restart-note muted" style="display:${this.restart ? '' : 'none'};margin-top:8px">Some changes apply after a restart. <button class="btn small" data-a="reload">Restart now</button></div>
      <div style="margin-top:12px;text-align:right"><button class="btn small" data-a="defaults">Restore defaults</button><button class="btn primary" data-a="close">Done</button></div></div>`;
  }

  private beginEdit(): void {
    const g = this.game;
    g.ui.pop(this.el);
    g.touch.setEnabled(true);
    g.touch.editMode = true;
    g.touch.setMode('foot');
    g.touch.applyLayout();
    g.touch.root.classList.add('edit');
    this.editBar.classList.add('open');
    g.ui.push({ el: this.editBar, pauses: true, onBack: () => (this.endEdit(), false) });
  }

  private endEdit(): void {
    const g = this.game;
    g.touch.editMode = false;
    g.touch.root.classList.remove('edit');
    g.touch.applyLayout();
    g.settings.save();
    g.ui.pop(this.editBar);
  }
}
