import { Activity, type ActivityManager } from './ActivityManager';
import type { Ped } from '../peds/Ped';
import type { Blip } from '../ui/Minimap';
import { randomAppearance } from '../characters/Appearance';
import { Rng } from '../core/rng';
import { districtAt } from '../world/MapData';
import { headingOf } from '../core/math';

const rng = new Rng(31337);

/** Random street events: purse snatchers and muggings the player can choose to intervene in. */
export class StreetEvents extends Activity {
  readonly id = 'event';
  readonly title = 'Street Event';
  private next = 70;
  private kind: 'snatch' | 'mugging' = 'snatch';
  private victim: Ped | null = null;
  private crook: Ped | null = null;
  private phase: 'chase' | 'bag' | 'return' | 'standoff' | 'fight' = 'chase';
  private bag = { x: 0, y: 0, z: 0 };

  constructor(mgr: ActivityManager) {
    super(mgr);
  }

  override idle(dt: number): void {
    if (this.active) return;
    const g = this.game;
    const p = g.player;
    if (p.mode !== 'foot' || !this.mgr.canStart() || (g.police?.wanted.stars ?? 0) > 0) return;
    const d = districtAt(p.pos.x, p.pos.z);
    if (d === 'desert' || d === 'sea' || d === 'beach' || d === 'coralkeys' || d === 'pelican') return;
    this.next -= dt;
    if (this.next > 0) return;
    this.next = rng.range(120, 240);
    this.start(rng.chance(0.55) ? 'snatch' : 'mugging');
  }

  override blips(out: Blip[]): void {
    if (!this.active) return;
    if (this.crook?.alive && (this.phase === 'chase' || this.phase === 'standoff' || this.phase === 'fight')) out.push({ x: this.crook.pos.x, z: this.crook.pos.z, color: '#ff4d4d', shape: 'dot', size: 4.5, pin: true });
    if (this.phase === 'bag') out.push({ x: this.bag.x, z: this.bag.z, color: '#7dffa1', shape: 'diamond', size: 4, pin: true });
    if (this.phase === 'return' && this.victim) out.push({ x: this.victim.pos.x, z: this.victim.pos.z, color: '#4dc3ff', shape: 'dot', size: 4.5, pin: true });
  }

  private start(kind: 'snatch' | 'mugging'): void {
    const g = this.game;
    const peds = g.peds;
    if (!peds || g.chars.used > g.chars.capacity - 6) return;
    const pp = g.player.pos;
    const s = this.mgr.sidewalkPoint(pp.x, pp.z, 22, 45);
    if (!s) return;
    if (!this.mgr.begin(this)) return;
    this.kind = kind;
    const v = peds.spawn(randomAppearance(rng, { female: rng.chance(0.6) }), s.x, s.y, s.z, 'scripted');
    const crookApp = g.missions?.appearance('thug') ?? randomAppearance(rng);
    const c = peds.spawn(crookApp, s.x + Math.cos(s.yaw) * 1.4, s.y, s.z - Math.sin(s.yaw) * 1.4, 'scripted');
    if (!v || !c) {
      if (v) peds.despawn(v);
      if (c) peds.despawn(c);
      this.mgr.end(this, false, '', 0, ' ');
      return;
    }
    v.persistent = c.persistent = true;
    c.tag = 'event';
    this.victim = v;
    this.crook = c;
    v.yaw = headingOf(c.pos.x - v.pos.x, c.pos.z - v.pos.z);
    c.yaw = v.yaw + Math.PI;
    if (kind === 'snatch') {
      this.phase = 'chase';
      v.play('hurt', 1.2);
      g.hud.subtitleText('Victim', rng.pick(['Stop! Thief! He took my bag!', 'Somebody stop him! My purse!', 'Hey! Give that back!']), 3.5);
    } else {
      this.phase = 'standoff';
      v.play('handsup', 9999);
      c.weapon = 'pistol';
      c.held = 'pistol';
      c.play('talk', 9999);
      g.hud.subtitleText('Victim', rng.pick(['Please, take it, just don\'t shoot!', 'Okay, okay! Here — take the wallet!']), 3.5);
    }
    g.hud.toast(kind === 'snatch' ? 'A purse snatcher is getting away' : 'Somebody is being mugged nearby', 2400);
  }

  override fixedUpdate(dt: number): void {
    const g = this.game;
    const c = this.crook;
    const peds = g.peds;
    if (!peds || !c || !c.alive || c.state !== 'scripted') return;
    const pp = g.player.pos;
    if (this.phase === 'chase') {
      c.prevPos.copy(c.pos);
      const dx = c.pos.x - pp.x, dz = c.pos.z - pp.z;
      const d = Math.hypot(dx, dz) || 1;
      peds.moveToward(c, c.pos.x + (dx / d) * 10, c.pos.z + (dz / d) * 10, 5.4, dt, true);
      peds.settleGround(c, dt);
      c.sync();
    }
  }

  override update(): void {
    const g = this.game;
    const c = this.crook, v = this.victim;
    if (!c || !v) return void this.mgr.end(this, false, '', 0, ' ');
    const pp = g.player.pos;
    const crookDown = !c.alive || c.state === 'down' || c.state === 'dead';
    switch (this.phase) {
      case 'chase':
        g.hud.objectiveText('Stop the <b>purse snatcher</b>');
        if (crookDown) {
          this.bag = { x: c.pos.x, y: c.pos.y, z: c.pos.z };
          this.mgr.markers.addPickup('purse', this.bag.x, this.bag.y, this.bag.z);
          this.phase = 'bag';
        } else if (c.pos.distanceTo(pp) > 160 || this.elapsed > 120) this.giveUp('The thief got away');
        break;
      case 'bag':
        g.hud.objectiveText('Grab the <b>bag</b>');
        if (this.mgr.markers.collect(pp.x, pp.y, pp.z, 1.8) > 0) {
          this.phase = 'return';
          g.hud.toast('Return the bag to its owner', 2000);
        }
        if (this.elapsed > 180) this.giveUp('');
        break;
      case 'return':
        g.hud.objectiveText('Return the bag to the <b>victim</b>');
        if (!v.alive) return void this.giveUp('');
        if (v.pos.distanceTo(pp) < 2.4) {
          v.play('talk', 2);
          g.hud.subtitleText('Victim', rng.pick(['Oh thank you! Here, take this.', 'You\'re a lifesaver. Please, take something for your trouble.']), 3);
          g.stats.inc('events');
          this.mgr.end(this, true, 'Bag returned', 150 + Math.floor(rng.range(0, 150)), 'GOOD SAMARITAN');
        }
        break;
      case 'standoff': {
        g.hud.objectiveText('Stop the <b>mugger</b>');
        const d = c.pos.distanceTo(pp);
        if (crookDown) return void this.rescued();
        c.yaw = headingOf(v.pos.x - c.pos.x, v.pos.z - c.pos.z);
        if (d < 9 || c.state !== 'scripted') {
          // the mugger turns on the player
          g.missions?.makeHostile(c);
          this.phase = 'fight';
          g.hud.subtitleText('Mugger', rng.pick(['Mind your business!', 'You want some too?!']), 2.5);
          v.play('cower', 9999);
        } else if (d > 140 || this.elapsed > 90) this.giveUp('The mugger got away with it');
        break;
      }
      case 'fight':
        g.hud.objectiveText('Take down the <b>mugger</b>');
        if (crookDown) this.rescued();
        else if (c.pos.distanceTo(pp) > 150) this.giveUp('');
        break;
    }
  }

  private rescued(): void {
    const g = this.game;
    const v = this.victim!;
    v.play('talk', 2);
    g.hud.subtitleText('Victim', rng.pick(['Thank you! I thought I was dead.', 'Bless you. Take this, please.']), 3);
    g.stats.inc('events');
    this.mgr.end(this, true, 'Mugging stopped', 100 + Math.floor(rng.range(0, 120)), 'HERO OF THE DAY');
  }

  private giveUp(msg: string): void {
    this.mgr.end(this, false, msg, 0, msg ? 'EVENT FAILED' : ' ');
  }

  override cleanup(): void {
    const g = this.game;
    this.mgr.markers.clearPickups('purse');
    for (const p of [this.victim, this.crook]) {
      if (!p) continue;
      p.persistent = false;
      p.tag = null;
      p.play('none', 0);
      if (p.alive && p.state === 'scripted') g.peds?.resumeRoutine(p);
    }
    if (this.victim?.alive && this.kind === 'mugging') {
      this.victim.setState('flee');
      this.victim.threat.copy(this.crook?.pos ?? g.player.pos);
    }
    this.victim = this.crook = null;
    g.hud.subtitleText(null, null);
  }
}
