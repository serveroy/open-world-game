import * as THREE from 'three';
import { Activity, type ActivityManager } from './ActivityManager';
import { deliveryPay, taxiFare, taxiTimeAllowed } from './logic';
import type { Ped } from '../peds/Ped';
import type { Vehicle } from '../vehicles/Vehicle';
import type { Blip } from '../ui/Minimap';
import { randomAppearance } from '../characters/Appearance';
import { Rng } from '../core/rng';
import { formatMoney } from '../core/math';

const rng = new Rng(4242);

type Spot = { x: number; z: number; y: number; yaw: number };

/** Taxi duty: pick up fares at the curb and drive them across town against the meter. */
export class TaxiJob extends Activity {
  readonly id = 'taxi';
  readonly title = 'Taxi Driver';
  private cab: Vehicle | null = null;
  private fare: Ped | null = null;
  private pickup: Spot | null = null;
  private drop: Spot | null = null;
  private phase: 'search' | 'pickup' | 'boarding' | 'ride' | 'leaving' = 'search';
  private timer = 0;
  private allowed = 0;
  private dist = 0;
  private wait = 0;
  private streak = 0;
  private earned = 0;
  private startHealth = 1;
  private outT = 0;

  constructor(mgr: ActivityManager) {
    super(mgr);
    const g = mgr.game;
    g.interactions.add({
      id: 'taxi', x: 0, z: 0, r: 99, onFoot: false, inVehicle: true, beacon: false, always: true, button: () => (this.active ? 'OFF DUTY' : 'TAXI'),
      at: () => {
        const v = g.vctrl?.vehicle;
        return v && v.def.taxi && Math.abs(v.speed) < 3 && (this.active || mgr.canStart()) ? v.position : null;
      },
      label: () => (this.active ? 'Go off duty' : 'Start taxi duty'),
      action: () => (this.active ? this.mgr.end(this, true, `${this.streak} fares`, 0, 'OFF DUTY') : this.start()),
    });
  }

  start(): void {
    const g = this.game;
    const v = g.vctrl?.vehicle;
    if (!v?.def.taxi || !this.mgr.begin(this)) return;
    this.cab = v;
    this.streak = 0;
    this.earned = 0;
    this.phase = 'search';
    this.wait = 1.5;
    g.hud.toast('On duty. Fares pay more when you beat the meter.', 3000);
  }

  override blips(out: Blip[]): void {
    if (!this.active) return;
    const t = this.phase === 'pickup' || this.phase === 'boarding' ? this.pickup : this.phase === 'ride' ? this.drop : null;
    if (t) out.push({ x: t.x, z: t.z, color: this.phase === 'ride' ? '#ffd250' : '#4dc3ff', shape: 'ring', size: 5, pin: true });
  }

  private nextFare(): void {
    const g = this.game;
    const pp = this.cab!.position;
    const s = this.mgr.sidewalkPoint(pp.x, pp.z, 120, 380);
    if (!s || !g.peds) {
      this.wait = 2;
      return;
    }
    g.world?.loadAround(s.x, s.z);
    const p = g.peds.spawn(randomAppearance(rng), s.x, s.y, s.z, 'scripted');
    if (!p) {
      this.wait = 2;
      return;
    }
    p.persistent = true;
    p.yaw = s.yaw;
    p.play('wave', 9999);
    this.fare = p;
    this.pickup = s;
    this.phase = 'pickup';
    g.hud.toast('New fare — pick them up', 1800);
  }

  override update(dt: number): void {
    const g = this.game;
    const v = g.vctrl?.vehicle;
    if (v !== this.cab || !this.cab || this.cab.destroyed) {
      this.outT += dt;
      g.hud.objectiveText(`Get back in your <b>cab</b> (${Math.max(0, 15 - this.outT).toFixed(0)})`);
      if (this.outT > 15 || this.cab?.destroyed) this.endShift(false, 'You abandoned the cab');
      return;
    }
    this.outT = 0;
    const cab = this.cab;
    const cp = cab.position;
    const wanted = g.police?.wanted.stars ?? 0;
    if (wanted > 0 && this.fare && (this.phase === 'ride' || this.phase === 'boarding')) {
      this.passengerBails('"I am not getting shot for a cab ride!"');
      return;
    }
    switch (this.phase) {
      case 'search':
        this.wait -= dt;
        g.hud.objectiveText('Cruise around for a <b>fare</b>');
        if (this.wait <= 0) this.nextFare();
        break;
      case 'pickup': {
        const s = this.pickup!;
        const curb = this.mgr.curbside(s);
        g.gps.objective = curb;
        this.mgr.markers.beacon(curb.x, s.y - 0.1, curb.z, 3, 0x4dc3ff, 5);
        g.hud.objectiveText('Pick up the <b>fare</b>');
        const d = Math.hypot(cp.x - s.x, cp.z - s.z);
        if (!this.fare?.alive) {
          this.phase = 'search';
          this.wait = 2;
          break;
        }
        if (d < 9 && Math.abs(cab.speed) < 1.5) {
          this.phase = 'boarding';
          this.timer = 0;
          this.fare.play('none', 0);
        } else if (d > 700) {
          this.dropFare();
          this.phase = 'search';
        }
        break;
      }
      case 'boarding': {
        const p = this.fare!;
        this.timer += dt;
        cab.toWorld(cab.info.door2, _door);
        const dd = Math.hypot(_door.x - p.pos.x, _door.z - p.pos.z);
        if (dd > 1 && this.timer < 4) {
          p.prevPos.copy(p.pos);
          g.peds!.moveToward(p, _door.x, _door.z, 2.4, dt, false);
          g.peds!.settleGround(p, dt);
          p.sync();
        } else {
          this.mgr.seat(p, cab);
          const dest = this.mgr.sidewalkPoint(cp.x, cp.z, 380, 1100);
          if (!dest) {
            this.passengerBails('');
            break;
          }
          this.drop = dest;
          this.dist = Math.hypot(dest.x - cp.x, dest.z - cp.z) * 1.25;
          this.allowed = taxiTimeAllowed(this.dist);
          this.timer = 0;
          this.startHealth = cab.health.fraction;
          this.phase = 'ride';
          g.hud.subtitleText('Fare', rng.pick(['Take me across town, and step on it.', 'Need to be there yesterday.', 'Long day. Just drive.', 'You know the way? Good.']), 3);
        }
        if (Math.abs(cab.speed) > 4) {
          // drove off while they walked over
          this.dropFare();
          this.phase = 'search';
          this.wait = 3;
        }
        break;
      }
      case 'ride': {
        const s = this.drop!;
        const curb = this.mgr.curbside(s);
        g.gps.objective = curb;
        this.mgr.markers.beacon(curb.x, s.y - 0.1, curb.z, 3.5, 0xffd250, 6);
        this.timer += dt;
        const left = this.allowed - this.timer;
        g.hud.timerText(`${left < 0 ? '+' : ''}${Math.abs(Math.ceil(left))}s`);
        g.hud.objectiveText(`Drive the fare to the <b>destination</b>`);
        if (Math.hypot(cp.x - curb.x, cp.z - curb.z) < 9 && Math.abs(cab.speed) < 1.5) {
          const dmg = Math.max(0, this.startHealth - cab.health.fraction);
          const { fare, tip } = taxiFare(this.dist, this.timer, this.allowed, dmg);
          this.streak++;
          let pay = fare + tip;
          if (this.streak % 5 === 0) pay += 250;
          this.earned += pay;
          g.wallet.add(pay, 'Taxi fare');
          g.stats.inc('taxiFares');
          this.mgr.bump('taxi_fares');
          g.hud.toast(`Fare ${formatMoney(fare)}${tip ? ` + tip ${formatMoney(tip)}` : ''}${this.streak % 5 === 0 ? ' + streak bonus $250' : ''}`, 2800);
          g.hud.timerText(null);
          this.mgr.unseat(this.fare!);
          this.phase = 'leaving';
          this.timer = 0;
        }
        break;
      }
      case 'leaving': {
        const p = this.fare;
        this.timer += dt;
        if (p) {
          p.prevPos.copy(p.pos);
          const s = this.drop!;
          g.peds!.moveToward(p, s.x - Math.sin(s.yaw) * 3, s.z - Math.cos(s.yaw) * 3, 1.4, dt, false);
          g.peds!.settleGround(p, dt);
          p.sync();
        }
        if (this.timer > 2.5) {
          this.dropFare();
          this.phase = 'search';
          this.wait = 4 + rng.range(0, 4);
          g.hud.counterText(`FARES ${this.streak} · ${formatMoney(this.earned)}`);
        }
        break;
      }
    }
  }

  private passengerBails(line: string): void {
    const g = this.game;
    if (this.fare) {
      if (this.mgr.isSeated(this.fare)) this.mgr.unseat(this.fare);
      if (line) g.hud.subtitleText('Fare', line, 3);
      this.fare.persistent = false;
      g.peds?.resumeRoutine(this.fare);
      this.fare.setState('flee');
      this.fare.threat.copy(this.cab!.position);
      this.fare = null;
    }
    g.hud.timerText(null);
    this.streak = 0;
    this.phase = 'search';
    this.wait = 6;
  }

  private dropFare(): void {
    const g = this.game;
    const p = this.fare;
    if (!p) return;
    if (this.mgr.isSeated(p)) this.mgr.unseat(p);
    p.play('none', 0);
    p.persistent = false;
    g.peds?.resumeRoutine(p);
    this.fare = null;
  }

  private endShift(passed: boolean, msg: string): void {
    this.mgr.end(this, passed || this.streak > 0, msg || `${this.streak} fares · ${formatMoney(this.earned)}`, 0, 'OFF DUTY');
  }

  override cleanup(): void {
    if (this.fare && this.mgr.isSeated(this.fare)) this.mgr.unseat(this.fare);
    this.dropFare();
    this.cab = null;
    this.game.hud.subtitleText(null, null);
  }
}

const _door = new THREE.Vector3();

/** Gull Express courier job: load a van at the depot and make timed deliveries around town. */
export class DeliveryJob extends Activity {
  readonly id = 'delivery';
  readonly title = 'Gull Express';
  /** Courier depot on Freight Avenue (snapped to the sidewalk at runtime). */
  static DEPOT = { x: -470, z: -585, yaw: 0 };
  private van: Vehicle | null = null;
  private drops: Spot[] = [];
  private i = 0;
  private timer = 0;
  private earned = 0;
  private outT = 0;
  private legDist = 0;

  constructor(mgr: ActivityManager) {
    super(mgr);
    const sw = mgr.nearestSidewalk(-470, -585);
    DeliveryJob.DEPOT = { x: sw.x, z: sw.z, yaw: sw.yaw };
    const D = DeliveryJob.DEPOT;
    mgr.game.interactions.add({
      id: 'delivery', x: D.x, z: D.z, r: 3, color: 0xffd250, button: 'WORK', inVehicle: true,
      label: 'Gull Express depot: start a delivery run',
      enabled: () => !this.active && mgr.canStart() && (mgr.game.police?.wanted.stars ?? 0) === 0,
      action: () => this.start(),
    });
  }

  override blips(out: Blip[]): void {
    const D = DeliveryJob.DEPOT;
    if (!this.active) {
      out.push({ x: D.x, z: D.z, color: '#ffd250', shape: 'icon', size: 5, label: '📦' });
      return;
    }
    const d = this.drops[this.i];
    if (d) out.push({ x: d.x, z: d.z, color: '#ffd250', shape: 'ring', size: 5, pin: true });
  }

  start(): void {
    const g = this.game;
    if (!this.mgr.begin(this)) return;
    const D = DeliveryJob.DEPOT;
    g.world?.loadAround(D.x, D.z);
    const vm = g.vehicles!;
    const curb = this.mgr.curbside({ ...D, yaw: D.yaw }, 4.5);
    const sx = curb.x, sz = curb.z;
    for (const o of [...vm.vehicles]) if (!o.persistent && o.driver?.kind !== 'player' && Math.hypot(o.position.x - sx, o.position.z - sz) < 7) vm.despawn(o);
    if (g.vctrl?.vehicle) g.vctrl.exit(true);
    const van = vm.spawn('courier', sx, sz, D.yaw + Math.PI / 2, { paint: 0xe0c030, role: 'player' });
    van.persistent = true;
    this.van = van;
    setTimeout(() => g.vctrl?.enter(van, true), 60);
    this.drops = [];
    let px = D.x, pz = D.z;
    for (let k = 0; k < 4; k++) {
      const s = this.mgr.sidewalkPoint(px, pz, 220, 700);
      if (!s) break;
      this.drops.push(s);
      px = s.x;
      pz = s.z;
    }
    this.i = 0;
    this.earned = 0;
    this.outT = 0;
    this.beginLeg();
    g.hud.toast('Four parcels, four addresses. Do not dent the van.', 3000);
  }

  private beginLeg(): void {
    const d = this.drops[this.i];
    if (!d || !this.van) return;
    const from = this.i === 0 ? DeliveryJob.DEPOT : this.drops[this.i - 1]!;
    this.legDist = Math.hypot(d.x - from.x, d.z - from.z) * 1.3;
    this.timer = Math.round(25 + this.legDist / 10);
  }

  override update(dt: number): void {
    const g = this.game;
    const van = this.van;
    if (!van || van.destroyed) return void this.mgr.end(this, false, 'The van was wrecked');
    if (g.vctrl?.vehicle !== van) {
      this.outT += dt;
      g.hud.objectiveText(`Get back in the <b>van</b> (${Math.max(0, 20 - this.outT).toFixed(0)})`);
      if (this.outT > 20) this.mgr.end(this, false, 'You abandoned the van');
      return;
    }
    this.outT = 0;
    const d = this.drops[this.i];
    if (!d) return void this.finish();
    const curb = this.mgr.curbside(d);
    g.gps.objective = curb;
    this.mgr.markers.beacon(curb.x, d.y - 0.1, curb.z, 3.5, 0xffd250, 6);
    this.timer -= dt;
    g.hud.timerText(`${Math.max(0, Math.ceil(this.timer))}s`);
    g.hud.counterText(`PARCEL ${this.i + 1}/${this.drops.length}`);
    g.hud.objectiveText('Deliver the parcel to the <b>address</b>');
    if (this.timer <= 0) return void this.mgr.end(this, false, 'Too slow — the customer cancelled', this.earned);
    if (Math.hypot(van.position.x - curb.x, van.position.z - curb.z) < 9 && Math.abs(van.speed) < 2) {
      const pay = deliveryPay(this.legDist, van.health.fraction);
      this.earned += pay;
      g.hud.toast(`Delivered! +${formatMoney(pay)}`, 1800);
      g.haptic(20);
      g.stats.inc('deliveries');
      this.i++;
      if (this.i >= this.drops.length) this.finish();
      else this.beginLeg();
    }
  }

  private finish(): void {
    const bonus = 300;
    this.mgr.bump('delivery_runs');
    this.mgr.end(this, true, `${this.drops.length} parcels`, this.earned + bonus);
  }

  override cleanup(): void {
    if (this.van) this.mgr.discard({ v: this.van });
    this.van = null;
  }
}

