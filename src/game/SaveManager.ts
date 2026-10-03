import type { Game, System } from './Game';
import { SaveSystem, SAVE_VERSION, type SaveData } from '../core/SaveSystem';
import { PROPERTY_BY_ID } from '../economy/Estate';
import { districtAt, districtName, landmark, SPAWNS } from '../world/MapData';
import { MISSION_BY_ID } from '../missions/index';
import { formatMoney } from '../core/math';
import { defaultPlayerAppearance } from '../characters/Appearance';

export const SLOTS = ['auto', 'slot1', 'slot2', 'slot3'] as const;
const PENDING_KEY = 'crimson-coast.pendingLoad';

/** Gathers / applies the full game state and runs auto-save. */
export class SaveManager implements System {
  name = 'saves';
  readonly store = new SaveSystem();
  private pending: string | null = null;
  private debounce = 0;
  private periodic = 180;
  private saving = false;
  lastSave = 0;
  /** Disabled until a game is started or loaded (title screen). */
  enabled = false;

  constructor(private game: Game) {
    game.events.on('saveRequested', (e) => this.request(e.reason));
    game.events.on('appHidden', () => {
      if (this.enabled && this.safeToSave()) void this.save('auto');
    });
  }

  request(reason: string): void {
    this.pending = reason;
    this.debounce = 1.2;
  }

  /** Not mid-mission / activity, no wanted level, alive. */
  safeToSave(): boolean {
    const g = this.game;
    return !(g.missions?.active ?? false) && !g.activities?.current && (g.police?.wanted.stars ?? 0) === 0 && !g.respawn.active && g.player.mode !== 'dead' && g.player.mode !== 'ragdoll';
  }

  gather(slotName: string): SaveData {
    const g = this.game;
    const p = g.player;
    const v = g.vctrl?.vehicle;
    const pos = v ? v.position : p.pos;
    const est = g.estate.save();
    const story = g.missions?.save() ?? { completed: [], flags: {}, unlocked: [] };
    const clock = g.env?.clock;
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      playTime: g.stats.get('playTime'),
      slotName,
      player: { x: pos.x, y: pos.y, z: pos.z, yaw: v ? v.yaw : p.yaw, health: p.vitals.health, armor: p.vitals.armor, appearance: { ...p.appearance } },
      cash: g.wallet.cash,
      arsenal: g.combat?.arsenal.save() ?? { owned: ['fists'], ammo: {}, clip: {}, current: 'fists' },
      story,
      hour: clock ? clock.hour : 9,
      day: clock ? clock.day : 0,
      properties: est.owned,
      businesses: est.businesses,
      garages: est.garages,
      shells: g.collectibles?.save() ?? [],
      stats: { ...g.stats.save(), earned: g.wallet.totalEarned + g.stats.get('earnedBase'), spent: g.wallet.totalSpent + g.stats.get('spentBase') },
      activities: g.activities?.save() ?? {},
      wardrobe: [...(g.shops?.wardrobe ?? [])],
      vehicle: v && !v.destroyed && !v.tag ? { def: v.def.id, paint: v.paint, mods: { ...v.mods }, health: v.health.fraction, yaw: v.yaw } : null,
    };
  }

  /** Apply a save onto a freshly booted world. */
  apply(d: SaveData): void {
    const g = this.game;
    g.missions?.load(d.story);
    const unlockedProps = d.story.unlocked.filter((u) => u.startsWith('property:')).map((u) => u.slice(9));
    g.estate.load({ owned: d.properties, businesses: d.businesses, garages: d.garages }, unlockedProps);
    g.wallet.set(d.cash);
    g.hud.setCash(d.cash, true);
    g.combat?.arsenal.load(d.arsenal);
    g.player.setAppearance({ ...defaultPlayerAppearance(), ...d.player.appearance });
    g.player.vitals.health = Math.max(30, d.player.health);
    g.player.vitals.armor = d.player.armor;
    g.collectibles?.load(d.shells);
    g.activities?.load(d.activities);
    g.stats.load(d.stats);
    // wallet counters restart per session; keep lifetime totals in the stats base
    g.stats.v.earnedBase = d.stats.earned ?? 0;
    g.stats.v.spentBase = d.stats.spent ?? 0;
    if (g.shops) {
      g.shops.wardrobe.clear();
      for (const w of d.wardrobe) g.shops.wardrobe.add(w);
    }
    if (g.env) {
      g.env.clock.totalHours = d.day * 24 + d.hour;
    }
    const ok = Number.isFinite(d.player.x) && Number.isFinite(d.player.z) && Math.abs(d.player.x) < 1600 && Math.abs(d.player.z) < 1200;
    const x = ok ? d.player.x : SPAWNS.start.x, z = ok ? d.player.z : SPAWNS.start.z;
    g.teleport(x, z, d.player.yaw);
    const sv = d.vehicle;
    if (ok && sv && g.vehicles && g.vctrl) {
      try {
        const nv = g.vehicles.spawn(sv.def, x, z, sv.yaw, { paint: sv.paint, role: 'player' });
        nv.mods = { ...sv.mods };
        nv.health.health = nv.health.max * Math.max(0.25, sv.health);
        nv.persistent = true;
        g.vctrl.enter(nv, true);
        g.cam.snapBehind(sv.yaw);
      } catch {
        /* unknown vehicle id in an old save: stay on foot */
      }
    }
    this.enabled = true;
  }

  async save(slot: string, name?: string): Promise<boolean> {
    if (this.saving) return false;
    this.saving = true;
    const g = this.game;
    const where = whereName(g);
    const ok = await this.store.save(slot, this.gather(name ?? `${where} · ${this.progressText()}`));
    this.saving = false;
    if (ok) {
      this.lastSave = g.time;
      g.hud.saveIcon();
    }
    return ok;
  }

  progressText(): string {
    const done = this.game.missions?.story.completed.length ?? 0;
    const total = Object.keys(MISSION_BY_ID).length - 1; // one ending counts
    return `${Math.min(100, Math.round((done / total) * 100))}%`;
  }

  /** Safehouse bed: sleep until morning (or +6h), heal, then offer the save slots. */
  sleepAt(id: string): void {
    const g = this.game;
    const def = PROPERTY_BY_ID[id];
    if (!def) return;
    if ((g.police?.wanted.stars ?? 0) > 0) {
      g.hud.toast('You can\'t sleep with the cops on your tail', 2000);
      return;
    }
    g.inputLocked = true;
    g.hud.fade(1, 600);
    setTimeout(() => {
      const c = g.env?.clock;
      if (c) {
        const h = c.hour;
        if (h >= 20 || h < 6) c.skipTo(8);
        else c.totalHours += 6;
      }
      g.player.vitals.health = g.player.vitals.maxHealth;
      g.estate.collectAll(g.wallet, (c?.totalHours ?? 0) / 24) > 0 && g.hud.toast('Business income collected', 2000);
      g.hud.fade(0, 800);
      g.inputLocked = false;
      this.slotPicker(`Sleep · ${def.name}`);
    }, 900);
  }

  /** Manual save: pick a slot (via the shop panel). */
  slotPicker(title: string): void {
    const g = this.game;
    void this.store.list().then((list) => {
      const by = new Map(list.map((x) => [x.slot, x.data]));
      g.shopUI.open({
        title, subtitle: 'Choose a save slot',
        tabs: [{
          id: 'slots', label: 'Slots', items: () => SLOTS.filter((s) => s !== 'auto').map((s) => {
            const d = by.get(s);
            return { id: s, cat: 'slot', name: d ? d.slotName : `Empty slot ${s.slice(4)}`, price: 0, owned: true, badge: d ? 'OVERWRITE' : 'EMPTY', desc: d ? `${new Date(d.savedAt).toLocaleString()} · ${formatMoney(d.cash)}` : '—' };
          }),
        }],
        buyLabel: () => 'SAVE HERE',
        onBuy: (it) => {
          void this.save(it.id).then((ok) => {
            g.hud.toast(ok ? 'Game saved' : 'Save failed (storage full or blocked)', 2000);
            if (ok) g.ui.pop(g.shopUI.el);
          });
          return null;
        },
      });
    });
  }

  /** Reload the page and load `slot` on boot (clean state for mid-game loads). */
  loadViaReload(slot: string | null): void {
    try {
      sessionStorage.setItem(PENDING_KEY, slot ?? '__new__');
    } catch {
      /* ignore */
    }
    location.reload();
  }

  static takePending(): string | null {
    try {
      const v = sessionStorage.getItem(PENDING_KEY);
      sessionStorage.removeItem(PENDING_KEY);
      return v;
    } catch {
      return null;
    }
  }

  /** Nearest owned safehouse to (x,z) for respawns. */
  nearestSafehouse(x: number, z: number): { x: number; z: number; yaw: number } | null {
    let best: { x: number; z: number; yaw: number } | null = null, bd = Infinity;
    for (const p of this.game.estate.safehouses()) {
      const l = landmark(p.id);
      const d = Math.hypot(l.x - x, l.z - z);
      if (d < bd) {
        bd = d;
        best = { x: l.x + Math.sin(l.yaw) * 2, z: l.z + Math.cos(l.yaw) * 2, yaw: l.yaw };
      }
    }
    return best;
  }

  update(dt: number): void {
    const g = this.game;
    if (!this.enabled) return;
    g.stats.inc('playTime', dt);
    g.stats.v.earned = g.wallet.totalEarned + g.stats.get('earnedBase');
    g.stats.v.spent = g.wallet.totalSpent + g.stats.get('spentBase');
    g.stats.max('maxWanted', g.police?.wanted.stars ?? 0);
    if (this.pending) {
      this.debounce -= dt;
      if (this.debounce <= 0) {
        const reason = this.pending;
        // story saves happen as soon as the mission closes; others wait for a safe moment
        if (reason === 'mission' || this.safeToSave()) {
          this.pending = null;
          void this.save('auto');
        } else this.debounce = 3;
      }
    }
    this.periodic -= dt;
    if (this.periodic <= 0) {
      this.periodic = 180;
      if (this.safeToSave()) void this.save('auto');
    }
  }
}

function whereName(g: Game): string {
  const p = g.player.pos;
  return districtName(districtAt(p.x, p.z)) || 'Port Solano';
}
