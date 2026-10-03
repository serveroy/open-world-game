import { Activity, type ActivityManager } from './ActivityManager';
import { contractPay } from './logic';
import type { Vehicle } from '../vehicles/Vehicle';
import type { Ped } from '../peds/Ped';
import type { Blip } from '../ui/Minimap';
import { landmark } from '../world/MapData';
import { vehicleDef } from '../vehicles/VehicleData';
import { Rng } from '../core/rng';
import { formatMoney } from '../core/math';
import type { ArsenalSave, WeaponId } from '../combat/Weapons';

const rng = new Rng(777);
const CONTRACT_MODELS = ['meridian', 'bruiser', 'stiletto', 'ranger', 'mule', 'wasp', 'thunder', 'aurelia', 'pico'];

/** "Wanted list" theft contracts: find a specific model parked somewhere and deliver it to the scrapyard. */
export class TheftContracts extends Activity {
  readonly id = 'contract';
  readonly title = 'Theft Contract';
  private target: Vehicle | null = null;
  private model = '';
  private area = { x: 0, z: 0 };
  private drop = { x: 0, z: 0 };
  private cooldown = 0;
  private stolen = false;

  constructor(mgr: ActivityManager) {
    super(mgr);
    const g = mgr.game;
    const r = landmark('respray');
    // contract board beside Lena's roller door
    const bx = r.x + Math.cos(r.yaw) * 7, bz = r.z - Math.sin(r.yaw) * 7;
    const yard = landmark('biz_scrapyard');
    this.drop = { x: yard.x + Math.sin(yard.yaw) * 8, z: yard.z + Math.cos(yard.yaw) * 8 };
    g.interactions.add({
      id: 'contracts', x: bx, z: bz, r: 2.2, color: 0xff8a4d, button: 'JOBS',
      label: () => (this.cooldown > 0 ? `Contract board — next job in ${Math.ceil(this.cooldown)}s` : 'Contract board: take a theft contract'),
      enabled: () => !this.active && mgr.canStart() && (g.missions?.story.unlocked.includes('shop:respray') ?? false),
      action: () => (this.cooldown > 0 ? g.hud.toast('Nothing on the board yet. Check back soon.', 1800) : this.start()),
    });
  }

  override idle(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt;
  }

  override blips(out: Blip[]): void {
    if (!this.active) return;
    if (!this.stolen) {
      const near = this.target && this.game.player.pos.distanceTo(this.target.position) < 70;
      if (near && this.target) out.push({ x: this.target.position.x, z: this.target.position.z, color: '#ff8a4d', shape: 'triangle', size: 5, pin: true });
      else out.push({ x: this.area.x, z: this.area.z, color: '#ff8a4d', shape: 'ring', size: 12, pin: true });
    } else out.push({ x: this.drop.x, z: this.drop.z, color: '#ffd250', shape: 'ring', size: 5, pin: true });
  }

  start(): void {
    const g = this.game;
    const spots = (g.world?.data.parking ?? []).filter((p) => {
      const d = Math.hypot(p.x - g.player.pos.x, p.z - g.player.pos.z);
      return d > 300 && d < 1100 && p.district !== 'desert';
    });
    if (!spots.length || !g.vehicles) return;
    if (!this.mgr.begin(this)) return;
    const sp = spots[Math.floor(rng.next() * spots.length)]!;
    this.model = rng.pick(CONTRACT_MODELS);
    g.world?.loadAround(sp.x, sp.z);
    for (const o of [...g.vehicles.vehicles]) if (!o.persistent && o.driver?.kind !== 'player' && Math.hypot(o.position.x - sp.x, o.position.z - sp.z) < 5) g.vehicles.despawn(o);
    const v = g.vehicles.spawn(this.model, sp.x, sp.z, sp.yaw, { role: 'parked', locked: rng.chance(0.7) });
    v.persistent = true;
    v.alarm = 0;
    this.target = v;
    this.stolen = false;
    const a = rng.range(0, Math.PI * 2), d = rng.range(10, 45);
    this.area = { x: sp.x + Math.cos(a) * d, z: sp.z + Math.sin(a) * d };
    g.gps.objective = this.area;
    const def = vehicleDef(this.model);
    g.hud.subtitleText('Lena', `Buyer wants a ${def.name}. Clean. Bring it to Rustvale Scrap — pays about ${formatMoney(contractPay(def.value, 1))}.`, 5);
  }

  override update(): void {
    const g = this.game;
    const v = this.target;
    if (!v || v.destroyed) return void this.mgr.end(this, false, 'The car was wrecked');
    const pv = g.vctrl?.vehicle;
    const name = v.def.name;
    if (pv !== v) {
      const d = g.player.pos.distanceTo(v.position);
      g.hud.objectiveText(this.stolen ? `Get back in the <b>${name}</b>` : d < 70 ? `Steal the <b>${name}</b>` : `Find the <b>${name}</b> in the marked area`);
      g.gps.objective = this.stolen || d < 70 ? { x: v.position.x, z: v.position.z } : this.area;
      if (d > 1500) this.mgr.end(this, false, 'You lost the car');
      return;
    }
    if (!this.stolen) {
      this.stolen = true;
      g.hud.toast(`Got it. Take the ${name} to Rustvale Scrap.`, 2400);
    }
    g.gps.objective = this.drop;
    const y = g.world ? Math.max(g.world.groundY(this.drop.x, this.drop.z), 0) : 0;
    this.mgr.markers.beacon(this.drop.x, y, this.drop.z, 4, 0xffd250, 6);
    const wanted = g.police?.wanted.stars ?? 0;
    g.hud.objectiveText(wanted > 0 ? 'Lose the <b>cops</b> before the drop' : `Deliver the <b>${name}</b> · ${Math.round(v.health.fraction * 100)}% condition`);
    if (wanted === 0 && Math.hypot(v.position.x - this.drop.x, v.position.z - this.drop.z) < 7 && Math.abs(v.speed) < 2) {
      const pay = contractPay(v.def.value, v.health.fraction);
      g.vctrl!.exit(true);
      g.stats.inc('contracts');
      this.mgr.bump('contracts');
      this.cooldown = 90;
      this.mgr.end(this, true, `${name} delivered`, pay);
    }
  }

  override cleanup(): void {
    const v = this.target;
    if (v) {
      v.role = 'parked';
      this.mgr.discard({ v });
      // the scrapyard crushes delivered cars
      if (this.stolen && Math.hypot(v.position.x - this.drop.x, v.position.z - this.drop.z) < 10) setTimeout(() => {
        if (!v.driver && this.game.vehicles?.vehicles.includes(v)) this.game.vehicles.despawn(v);
      }, 2500);
    }
    this.target = null;
    this.game.hud.subtitleText(null, null);
  }
}

interface RampageDef {
  id: string;
  near: [number, number];
  weapon: WeaponId;
  kills: number;
  time: number;
  reward: number;
}

const RAMPAGES: RampageDef[] = [
  { id: 'rampage_rustvale', near: [60, -980], weapon: 'bat', kills: 12, time: 120, reward: 2000 },
  { id: 'rampage_docks', near: [-560, -900], weapon: 'smg', kills: 20, time: 120, reward: 3500 },
  { id: 'rampage_velvet', near: [-700, 150], weapon: 'shotgun', kills: 18, time: 120, reward: 4000 },
  { id: 'rampage_heights', near: [100, 900], weapon: 'rifle', kills: 25, time: 150, reward: 5000 },
];

/** Skull pickups: kill N gang members within the time limit. */
export class Rampage extends Activity {
  readonly id = 'rampage';
  readonly title = 'Rampage';
  private spots: (RampageDef & { x: number; z: number; y: number })[] = [];
  private cur: (RampageDef & { x: number; z: number; y: number }) | null = null;
  private kills = 0;
  private spawnT = 0;
  private snap: ArsenalSave | null = null;

  constructor(mgr: ActivityManager) {
    super(mgr);
    const g = mgr.game;
    for (const r of RAMPAGES) {
      const s = mgr.nearestSidewalk(r.near[0], r.near[1]);
      const spot = { ...r, x: s.x, z: s.z, y: s.y };
      this.spots.push(spot);
      g.interactions.add({
        id: r.id, x: spot.x, z: spot.z, r: 1.8, color: 0xff2a2a, button: 'RAMPAGE',
        label: () => `Rampage: ${r.kills} kills in ${r.time}s with the ${r.weapon.toUpperCase()}${mgr.record[r.id] ? ' ✓' : ''}`,
        enabled: () => mgr.canStart() && (g.police?.wanted.stars ?? 0) === 0,
        action: () => this.start(spot),
      });
    }
    g.events.on('pedKilled', (e) => {
      if (!this.active || !e.byPlayer) return;
      const p = e.ped as Ped;
      if (p.tag === 'rampage') {
        this.kills++;
        g.haptic(12);
      }
    });
  }

  override blips(out: Blip[]): void {
    if (this.active) return;
    for (const s of this.spots) out.push({ x: s.x, z: s.z, color: this.mgr.record[s.id] ? '#7a4040' : '#ff2a2a', shape: 'icon', size: 4.5, label: '☠' });
  }

  start(s: RampageDef & { x: number; z: number; y: number }): void {
    const g = this.game;
    const ars = g.combat?.arsenal;
    if (!ars || !this.mgr.begin(this)) return;
    this.cur = s;
    this.kills = 0;
    this.spawnT = 0;
    this.snap = ars.save();
    ars.give(s.weapon, 600);
    ars.select(s.weapon);
    g.missions?.setWanted(0, true);
    g.hud.big('RAMPAGE!', 'failed', `Kill ${s.kills} gang members in ${s.time} seconds`, 3);
    g.cam.addShake(0.4);
  }

  override update(dt: number): void {
    const g = this.game;
    const s = this.cur!;
    const left = s.time - this.elapsed;
    g.hud.timerText(`${Math.max(0, Math.ceil(left))}s`);
    g.hud.counterText(`KILLS ${this.kills}/${s.kills}`);
    g.hud.objectiveText('Kill the <b>gang members</b>!');
    if (this.kills >= s.kills) {
      const first = !this.mgr.record[s.id];
      this.mgr.bump(s.id);
      g.stats.inc('rampages');
      this.mgr.end(this, true, `${this.kills} kills`, first ? s.reward : Math.round(s.reward * 0.3), 'RAMPAGE COMPLETE');
      return;
    }
    if (left <= 0) return void this.mgr.end(this, false, `${this.kills}/${s.kills} kills`);
    // keep waves coming
    this.spawnT -= dt;
    const alive = g.missions?.aliveCount('rampage') ?? 0;
    if (this.spawnT <= 0 && alive < 6) {
      this.spawnT = 2.5;
      const pp = g.player.pos;
      const sp = this.mgr.sidewalkPoint(pp.x, pp.z, 25, 55) ?? { x: pp.x + 30, z: pp.z };
      g.missions?.spawnWave({ tag: 'rampage', count: 3, x: sp.x, z: sp.z, r: 4, app: 'gang', weapon: rng.pick(['pistol', 'bat', 'knife', 'pistol']) });
    }
  }

  override cleanup(): void {
    const g = this.game;
    g.missions?.despawn('rampage');
    g.missions?.setWanted(0, false);
    // the rampage weapon is a loan: restore the previous arsenal
    const ars = g.combat?.arsenal;
    if (ars && this.snap && g.player.mode !== 'dead') ars.load(this.snap);
    this.snap = null;
    this.cur = null;
  }
}
