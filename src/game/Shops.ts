import * as THREE from 'three';
import type { Game } from './Game';
import { LANDMARKS, type Landmark } from '../world/MapData';
import {
  ARMOR_PRICE, BEARDS, BOTTOMS, CLOTH_COLORS, GUNSHOP_STOCK, GUN_UNLOCK, HAIR_DYES, HAIR_STYLES, HATS, INK_COLORS, MOD_LEVELS, MOD_NAMES,
  PAINTS, PAINT_PRICE, PANTS_COLORS, RESPRAY_PRICE, SHOE_COLORS, TATTOOS, TOPS, ammoPrice, applyChange, applyMod, changePrice, modLevel,
  modPrice, repairPrice, weaponPrice, type AppearanceChange, type ModKind, type ShopItem,
} from '../economy/Catalog';
import { WEAPONS, type WeaponId } from '../combat/Weapons';
import { PROPERTY_BY_ID, type PropertyDef } from '../economy/Estate';
import { MISSION_BY_ID } from '../missions/index';
import type { Appearance } from '../characters/Appearance';
import type { Vehicle } from '../vehicles/Vehicle';
import { formatMoney } from '../core/math';
import { rand } from '../core/rng';

const doorOut = (l: Landmark, d: number): { x: number; z: number } => ({ x: l.x + Math.sin(l.yaw) * d, z: l.z + Math.cos(l.yaw) * d });

/** Wires every store / property in the world to interaction points and shop menus. */
export class Shops {
  /** Clothing pieces bought once are free to re-wear. */
  readonly wardrobe = new Set<string>();
  private base: Appearance | null = null;
  private vehBase: { paint: number } | null = null;

  constructor(private game: Game) {
    const ia = game.interactions;
    for (const l of LANDMARKS) {
      switch (l.kind) {
        case 'gunshop':
          ia.add({ id: l.id, x: l.x, z: l.z, r: 2.2, label: `Shop at ${l.name}`, button: 'SHOP', color: 0xff5a2a, action: () => this.gunShop(l) });
          break;
        case 'barber':
          ia.add({ id: l.id, x: l.x, z: l.z, r: 2.2, label: `Get a cut at ${l.name}`, button: 'CUT', color: 0x2affea, action: () => this.barber(l) });
          break;
        case 'clothes':
          ia.add({ id: l.id, x: l.x, z: l.z, r: 2.2, label: `Browse ${l.name}`, button: 'SHOP', color: 0xffd250, action: () => this.clothes(l) });
          break;
        case 'tattoo':
          ia.add({ id: l.id, x: l.x, z: l.z, r: 2.2, label: `Get inked at ${l.name}`, button: 'INK', color: 0xa02aff, action: () => this.tattoo(l) });
          break;
        case 'modshop': {
          const p = doorOut(l, 5);
          ia.add({ id: l.id, x: p.x, z: p.z, r: 4, label: `Drive into ${l.name}`, button: 'MODS', color: 0x2a8aff, onFoot: false, inVehicle: true, action: () => this.modShop(l) });
          break;
        }
        case 'respray': {
          const p = doorOut(l, 5);
          ia.add({
            id: l.id, x: p.x, z: p.z, r: 4, label: () => `Respray at ${l.name} (${formatMoney(RESPRAY_PRICE)})`, button: 'PAINT', color: 0xffd250,
            onFoot: false, inVehicle: true, enabled: () => l.id !== 'respray' || this.unlocked('shop:respray'), action: () => this.respray(l),
          });
          break;
        }
        case 'safehouse':
        case 'business': {
          const def = PROPERTY_BY_ID[l.id];
          if (!def) break;
          ia.add({
            id: l.id, x: l.x, z: l.z, r: 2.2, color: def.kind === 'safehouse' ? 0x48d27a : 0xffe02a,
            label: () => this.propertyLabel(def), button: () => (game.estate.owned.has(def.id) ? (def.kind === 'safehouse' ? 'HOME' : 'TILL') : 'BUY'),
            enabled: () => game.estate.owned.has(def.id) || game.estate.available(def.id),
            action: () => this.property(def, l),
          });
          if (def.kind === 'safehouse') {
            const g = doorOut(l, 7);
            ia.add({
              id: l.id + ':garage', x: g.x, z: g.z, r: 4, label: 'Garage', button: 'GARAGE', color: 0x48d27a, inVehicle: true,
              enabled: () => game.estate.owned.has(def.id), action: () => this.garage(def, l),
            });
          }
          break;
        }
        default:
          break;
      }
    }
  }

  private unlocked(key: string): boolean {
    return this.game.missions?.story.unlocked.includes(key) ?? false;
  }

  private propertyLabel(def: PropertyDef): string {
    const e = this.game.estate;
    if (!e.owned.has(def.id)) return `Buy ${def.name} — ${formatMoney(def.price)}`;
    if (def.kind === 'safehouse') return `${def.name}: sleep & save`;
    const amt = e.pending(def.id, this.day());
    return `${def.name}: collect ${formatMoney(amt)}`;
  }

  private day(): number {
    return (this.game.env?.clock.totalHours ?? 0) / 24;
  }

  /** Point the camera at the player's face for appearance shops. */
  private portrait(on: boolean): void {
    const g = this.game;
    if (!on) {
      g.cam.mode = g.vctrl?.inVehicle ? 'vehicle' : 'foot';
      g.cam.snapBehind(g.player.yaw);
      return;
    }
    const p = g.player.pos, y = g.player.yaw;
    const a = y + 0.3;
    const cx = p.x + Math.sin(a) * 2.7, cz = p.z + Math.cos(a) * 2.7;
    // aim a little to the screen-right of the player so they sit left of the shop panel
    const dx = p.x - cx, dz = p.z - cz, l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l, rz = dx / l;
    g.cam.cutPos = new THREE.Vector3(cx, p.y + 1.5, cz);
    g.cam.cutLook = new THREE.Vector3(p.x + rx * 0.85, p.y + 1.2, p.z + rz * 0.85);
    g.cam.cutFov = 46;
    g.cam.mode = 'cutscene';
  }

  private vehicleShot(v: Vehicle, on: boolean): void {
    const g = this.game;
    if (!on) {
      g.cam.mode = 'vehicle';
      g.cam.snapBehind(v.yaw);
      return;
    }
    const p = v.position, y = v.yaw + 0.8;
    const d = v.def.length * 1.1 + 2;
    g.cam.cutPos = new THREE.Vector3(p.x + Math.sin(y) * d, p.y + 1.8, p.z + Math.cos(y) * d);
    g.cam.cutLook = new THREE.Vector3(p.x, p.y + 0.5, p.z);
    g.cam.cutFov = 50;
    g.cam.mode = 'cutscene';
  }

  // ------------------------------------------------------------------ guns
  private gunShop(l: Landmark): void {
    const g = this.game;
    if (!this.unlocked('shop:gunshop')) {
      g.hud.toast('CLOSED — "Come back when someone vouches for you."', 3000);
      return;
    }
    const ars = g.combat?.arsenal;
    if (!ars) return;
    const done = new Set(g.missions?.story.completed ?? []);
    g.shopUI.open({
      title: l.name, subtitle: 'Licensed firearms · no questions',
      tabs: [
        {
          id: 'weapons', label: 'Weapons', items: () => GUNSHOP_STOCK.map((id): ShopItem => {
            const req = GUN_UNLOCK[id];
            const locked = !!req && !done.has(req);
            const w = WEAPONS[id];
            return { id, cat: 'weapons', name: `${w.icon} ${w.name}`, price: weaponPrice(id), owned: ars.has(id) && w.kind !== 'thrown', disabled: locked, desc: locked ? `After "${MISSION_BY_ID[req!]?.title ?? req}"` : w.kind === 'gun' ? `${w.damage * w.pellets} dmg · ${w.mag} rds` : w.kind === 'thrown' ? `+${w.ammoPack}` : `${w.damage} dmg` };
          }),
        },
        {
          id: 'ammo', label: 'Ammo', items: () => GUNSHOP_STOCK.filter((id) => WEAPONS[id].kind === 'gun' && ars.has(id)).map((id): ShopItem => {
            const a = ammoPrice(id);
            const full = ars.total(id) >= WEAPONS[id].maxAmmo;
            return { id, cat: 'ammo', name: `${WEAPONS[id].icon} ${WEAPONS[id].name} ×${a.amount}`, price: a.price, disabled: full, desc: full ? 'Full' : `${ars.total(id)}/${WEAPONS[id].maxAmmo}` };
          }),
        },
        {
          id: 'armor', label: 'Armor', items: () => [{ id: 'armor', cat: 'armor', name: '🦺 Body Armor', price: ARMOR_PRICE, disabled: g.player.vitals.armor >= 100, desc: `${Math.round(g.player.vitals.armor)}/100` }],
        },
      ],
      onBuy: (it, tab) => {
        if (tab === 'armor') {
          if (!g.wallet.spend(ARMOR_PRICE, 'Armor')) return 'Not enough cash';
          g.player.vitals.armor = 100;
          return 'Armor equipped';
        }
        const id = it.id as WeaponId;
        const w = WEAPONS[id];
        if (tab === 'ammo') {
          const a = ammoPrice(id);
          if (!g.wallet.spend(a.price, `${w.name} ammo`)) return 'Not enough cash';
          ars.addAmmo(id, a.amount);
          return `+${a.amount} rounds`;
        }
        if (it.owned) {
          ars.select(id);
          return `${w.name} equipped`;
        }
        if (!g.wallet.spend(it.price, w.name)) return 'Not enough cash';
        ars.give(id, w.kind === 'gun' ? w.mag * 3 : w.kind === 'thrown' ? w.ammoPack : 0);
        ars.select(id);
        g.haptic(20);
        return `Bought ${w.name}`;
      },
    });
  }

  // ------------------------------------------------------------------ appearance shops
  private appearanceShop(l: Landmark, title: string, sub: string, tabs: { id: string; label: string; changes: { c: AppearanceChange; name: string; swatch?: number }[] }[]): void {
    const g = this.game;
    const p = g.player;
    this.base = { ...p.appearance };
    // step out of the doorway and face the street so the camera sees the face
    const out = doorOut(l, 1.6);
    g.teleport(out.x, out.z, l.yaw);
    p.yaw = l.yaw;
    this.portrait(true);
    const item = (c: AppearanceChange, name: string, swatch?: number): ShopItem => {
      const id = `${c.k}:${c.v}`;
      const cur = this.base![c.k] === c.v;
      const owned = cur || this.wardrobe.has(id);
      return { id, cat: c.k, name: cur ? `${name} ✓` : name, price: owned ? 0 : changePrice(this.base!, c), owned, swatch };
    };
    const parse = (id: string): AppearanceChange => {
      const [k, v] = id.split(':') as [AppearanceChange['k'], string];
      const num = Number(v);
      return { k, v: Number.isFinite(num) && v !== '' && /^\d+$/.test(v) ? num : v } as AppearanceChange;
    };
    g.shopUI.open({
      title, subtitle: sub,
      tabs: tabs.map((t) => ({ id: t.id, label: t.label, items: () => t.changes.map((x) => item(x.c, x.name, x.swatch)) })),
      onPreview: (it) => {
        if (!this.base) return;
        p.setAppearance(it ? applyChange(this.base, parse(it.id)) : this.base);
      },
      buyLabel: (it) => (this.base && this.base[parse(it.id).k] === parse(it.id).v ? 'WEARING' : it.owned ? 'WEAR' : `BUY ${formatMoney(it.price)}`),
      onBuy: (it) => {
        if (!this.base) return null;
        const c = parse(it.id);
        if (this.base[c.k] === c.v) return null;
        const price = it.owned ? 0 : changePrice(this.base, c);
        if (price > 0 && !g.wallet.spend(price, title)) return 'Not enough cash';
        this.base = applyChange(this.base, c);
        this.wardrobe.add(it.id);
        p.setAppearance(this.base);
        g.stats.inc('styleChanges');
        g.haptic(15);
        return price > 0 ? `Looking sharp (−${formatMoney(price)})` : 'Changed';
      },
      onClose: () => {
        if (this.base) p.setAppearance(this.base);
        this.base = null;
        this.portrait(false);
        g.events.emit('saveRequested', { reason: 'shop' });
      },
    });
  }

  private barber(l: Landmark): void {
    this.appearanceShop(l, l.name, 'Cuts · shaves · colour', [
      { id: 'hair', label: 'Hair', changes: HAIR_STYLES.map((h) => ({ c: { k: 'hairStyle', v: h.id }, name: h.name })) },
      { id: 'beard', label: 'Beard', changes: BEARDS.map((h) => ({ c: { k: 'beard', v: h.id }, name: h.name })) },
      { id: 'dye', label: 'Colour', changes: HAIR_DYES.map((hex, i) => ({ c: { k: 'hair', v: hex }, name: `Shade ${i + 1}`, swatch: hex })) },
    ]);
  }

  private clothes(l: Landmark): void {
    this.appearanceShop(l, l.name, 'Streetwear · suits · kicks', [
      { id: 'tops', label: 'Tops', changes: TOPS.map((h) => ({ c: { k: 'top', v: h.id }, name: h.name })) },
      { id: 'shirt', label: 'Shirt', changes: CLOTH_COLORS.map((hex, i) => ({ c: { k: 'shirt', v: hex }, name: `Shirt ${i + 1}`, swatch: hex })) },
      { id: 'jacket', label: 'Jacket', changes: CLOTH_COLORS.map((hex, i) => ({ c: { k: 'jacket', v: hex }, name: `Jacket ${i + 1}`, swatch: hex })) },
      { id: 'legs', label: 'Legs', changes: [...BOTTOMS.map((h) => ({ c: { k: 'bottom', v: h.id } as AppearanceChange, name: h.name })), ...PANTS_COLORS.map((hex, i) => ({ c: { k: 'pants', v: hex } as AppearanceChange, name: `Colour ${i + 1}`, swatch: hex }))] },
      { id: 'shoes', label: 'Shoes', changes: SHOE_COLORS.map((hex, i) => ({ c: { k: 'shoes', v: hex }, name: `Kicks ${i + 1}`, swatch: hex })) },
      { id: 'hats', label: 'Hats', changes: [...HATS.map((h) => ({ c: { k: 'hat', v: h.id } as AppearanceChange, name: h.name })), ...CLOTH_COLORS.slice(0, 8).map((hex, i) => ({ c: { k: 'hatColor', v: hex } as AppearanceChange, name: `Hat colour ${i + 1}`, swatch: hex }))] },
    ]);
  }

  private tattoo(l: Landmark): void {
    this.appearanceShop(l, l.name, 'Custom ink · walk-ins welcome', [
      { id: 'designs', label: 'Designs', changes: TATTOOS.map((h) => ({ c: { k: 'tattoo', v: h.id }, name: h.name })) },
      { id: 'ink', label: 'Ink', changes: INK_COLORS.map((hex, i) => ({ c: { k: 'tattooColor', v: hex }, name: `Ink ${i + 1}`, swatch: hex })) },
    ]);
  }

  // ------------------------------------------------------------------ vehicles
  private playerCar(): Vehicle | null {
    const v = this.game.vctrl?.vehicle;
    if (!v || v.destroyed) return null;
    if (v.kind !== 'car' && v.kind !== 'bike') {
      this.game.hud.toast('They only work on cars and bikes here', 2000);
      return null;
    }
    return v;
  }

  private modShop(l: Landmark): void {
    const g = this.game;
    const v = this.playerCar();
    if (!v) return;
    if ((g.police?.wanted.stars ?? 0) > 0) {
      g.hud.toast('"Not with the cops on your tail!"', 2200);
      return;
    }
    v.throttle = 0;
    v.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.vehBase = { paint: v.paint };
    this.vehicleShot(v, true);
    const perf = (k: ModKind): ShopItem[] => {
      const cur = modLevel(v.mods, k);
      const out: ShopItem[] = [];
      for (let lv = 1; lv <= MOD_LEVELS[k]; lv++) out.push({ id: `${k}:${lv}`, cat: k, name: MOD_NAMES[k][lv]!, price: modPrice(v.def, k, lv), owned: cur >= lv, disabled: lv > cur + 1, desc: lv > cur + 1 ? 'Install previous level first' : '' });
      return out;
    };
    g.shopUI.open({
      title: l.name, subtitle: `${v.def.name} · ${formatMoney(v.def.value)} value`,
      tabs: [
        { id: 'engine', label: 'Engine', items: () => [...perf('engine'), ...perf('turbo')] },
        { id: 'brakes', label: 'Brakes', items: () => perf('brakes') },
        { id: 'wheels', label: 'Tyres', items: () => perf('wheels') },
        { id: 'armor', label: 'Armor', items: () => perf('armor') },
        { id: 'paint', label: 'Paint', items: () => PAINTS.map((pt) => ({ id: `paint:${pt.hex}`, cat: 'paint', name: pt.name, price: PAINT_PRICE, swatch: pt.hex, owned: this.vehBase?.paint === pt.hex })) },
        { id: 'repair', label: 'Repair', items: () => [{ id: 'repair', cat: 'repair', name: '🔧 Full Repair', price: repairPrice(v.def, v.health.fraction), disabled: v.health.fraction > 0.99 && !v.tirePopped.some(Boolean), desc: `${Math.round(v.health.fraction * 100)}% condition` }] },
      ],
      onPreview: (it) => {
        if (it && it.id.startsWith('paint:')) v.setPaint(Number(it.id.slice(6)));
        else if (this.vehBase) v.setPaint(this.vehBase.paint);
      },
      onBuy: (it) => {
        if (it.owned) return null;
        if (!g.wallet.spend(it.price, `${l.name}: ${it.name}`)) return 'Not enough cash';
        g.haptic(25);
        if (it.id === 'repair') {
          v.resetDamage();
          return 'Good as new';
        }
        if (it.id.startsWith('paint:')) {
          this.vehBase = { paint: Number(it.id.slice(6)) };
          v.setPaint(this.vehBase.paint);
          v.hot = false;
          return `Painted ${it.name}`;
        }
        const [k, lv] = it.id.split(':') as [ModKind, string];
        v.mods = applyMod(v.mods, k, Number(lv));
        g.stats.inc('modsInstalled');
        return `${it.name} installed`;
      },
      onClose: () => {
        if (this.vehBase) v.setPaint(this.vehBase.paint);
        this.vehBase = null;
        this.vehicleShot(v, false);
        g.events.emit('saveRequested', { reason: 'shop' });
      },
    });
  }

  private respray(l: Landmark): void {
    const g = this.game;
    const v = this.playerCar();
    if (!v) return;
    if (Math.abs(v.speed) > 3) return;
    if (!g.wallet.spend(RESPRAY_PRICE, `${l.name} respray`)) {
      g.hud.toast(`A respray costs ${formatMoney(RESPRAY_PRICE)}`, 2000);
      return;
    }
    g.inputLocked = true;
    g.hud.fade(1, 500);
    setTimeout(() => {
      const opts = PAINTS.filter((p) => p.hex !== v.paint);
      const pick = opts[Math.floor(rand.next() * opts.length)]!;
      v.setPaint(pick.hex);
      v.resetDamage();
      v.hot = false;
      const police = g.police;
      const wasWanted = (police?.wanted.stars ?? 0) > 0;
      const ok = police ? police.wanted.respray(police.copSees) : true;
      g.hud.fade(0, 600);
      g.inputLocked = false;
      if (wasWanted && !ok) g.hud.toast('The cops saw you go in — the paint will not fool them', 3000);
      else if (wasWanted) g.hud.toast(`New paint, new plates. Wanted level cleared. (${pick.name})`, 3000);
      else g.hud.toast(`Resprayed ${pick.name}`, 2200);
      g.haptic([20, 40, 20]);
    }, 900);
  }

  // ------------------------------------------------------------------ properties
  private property(def: PropertyDef, l: Landmark): void {
    const g = this.game;
    const e = g.estate;
    if (!e.owned.has(def.id)) {
      g.shopUI.open({
        title: def.name, subtitle: def.blurb,
        tabs: [{
          id: 'buy', label: 'Buy', items: () => [{
            id: def.id, cat: 'property', name: def.kind === 'safehouse' ? `🏠 Safehouse · ${def.garage}-car garage` : `💼 Business · ${formatMoney(def.income)}/day`,
            price: def.price, owned: e.owned.has(def.id), desc: def.kind === 'safehouse' ? 'Save point · respawn · garage' : `Till holds up to ${def.cap} days of income`,
          }],
        }],
        onBuy: () => {
          const r = e.buy(def.id, g.wallet, this.day());
          if (r === 'ok') {
            g.hud.big('PROPERTY ACQUIRED', 'passed', def.name, 3.5);
            g.stats.inc('properties');
            g.events.emit('saveRequested', { reason: 'property' });
            setTimeout(() => g.shopUI.isOpen && g.ui.pop(g.shopUI.el), 600);
            return null;
          }
          return r === 'funds' ? 'Not enough cash' : r === 'locked' ? 'Not on the market yet' : null;
        },
      });
      return;
    }
    if (def.kind === 'business') {
      const amt = e.collect(def.id, g.wallet, this.day());
      g.hud.toast(amt > 0 ? `Collected ${formatMoney(amt)} from ${def.name}` : `The till is empty. Earns ${formatMoney(def.income)}/day.`, 2600);
      return;
    }
    // safehouse: sleep & save
    void l;
    g.saves.sleepAt(def.id);
  }

  private garage(def: PropertyDef, l: Landmark): void {
    const g = this.game;
    const e = g.estate;
    const cap = e.garageCapacity(def.id);
    const v = g.vctrl?.vehicle;
    const cars = e.garages.get(def.id) ?? [];
    if (v) {
      if (v.kind !== 'car' && v.kind !== 'bike') return void g.hud.toast('That does not fit in a garage', 1800);
      if (v.def.siren) return void g.hud.toast('Not storing a cop car here', 1800);
      if (v.destroyed || v.health.state === 'burning') return void g.hud.toast('Too wrecked to store', 1800);
      if (v.tag) return void g.hud.toast('Finish the job first', 1800);
      if (cars.length >= cap) return void g.hud.toast(`Garage full (${cap}/${cap}). Take a car out first.`, 2200);
      e.store(def.id, { def: v.def.id, paint: v.paint, mods: { ...v.mods } });
      g.vctrl!.exit(true);
      setTimeout(() => {
        if (g.vehicles && !v.driver) g.vehicles.despawn(v);
      }, 50);
      g.hud.toast(`${v.def.name} stored in ${def.name} (${cars.length + 1}/${cap})`, 2400);
      g.events.emit('saveRequested', { reason: 'garage' });
      return;
    }
    if (!cars.length) return void g.hud.toast(`${def.name} garage is empty (0/${cap})`, 2000);
    g.shopUI.open({
      title: `${def.name} Garage`, subtitle: `${cars.length}/${cap} stored`,
      tabs: [{ id: 'cars', label: 'Cars', items: () => (e.garages.get(def.id) ?? []).map((c, i) => ({ id: String(i), cat: 'car', name: g.vehicles!.allDefs().find((d) => d.id === c.def)?.name ?? c.def, price: 0, owned: true, badge: '', swatch: c.paint, desc: c.mods.engine || c.mods.turbo ? `Engine ${c.mods.engine}${c.mods.turbo ? ' · turbo' : ''}` : 'Stock' })) }],
      buyLabel: () => 'DRIVE OUT',
      onBuy: (it) => {
        const car = e.takeOut(def.id, Number(it.id));
        if (!car || !g.vehicles) return null;
        const p = doorOut(l, 8);
        const nv = g.vehicles.spawn(car.def, p.x, p.z, l.yaw, { paint: car.paint, role: 'player' });
        nv.mods = { ...car.mods };
        nv.persistent = true;
        g.ui.pop(g.shopUI.el);
        g.vctrl?.enter(nv, true);
        g.events.emit('saveRequested', { reason: 'garage' });
        return null;
      },
    });
  }
}
