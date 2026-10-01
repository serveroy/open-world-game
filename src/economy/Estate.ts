/** Properties (safehouses with save points + garages) and businesses with passive income. Pure logic. */
import type { Wallet } from './Wallet';
import type { GarageCar } from '../core/SaveSystem';

export interface PropertyDef {
  id: string; // landmark id
  name: string;
  kind: 'safehouse' | 'business';
  price: number;
  /** Safehouse garage capacity. */
  garage: number;
  /** Business income per in-game day. */
  income: number;
  /** Max uncollected days that accumulate in the till. */
  cap: number;
  /** Story unlock needed before it can be bought (null = always on sale). */
  unlock: string | null;
  blurb: string;
}

const S = (id: string, name: string, price: number, garage: number, blurb: string, unlock: string | null = null): PropertyDef =>
  ({ id, name, kind: 'safehouse', price, garage, income: 0, cap: 0, unlock, blurb });
const B = (id: string, name: string, price: number, income: number, blurb: string): PropertyDef =>
  ({ id, name, kind: 'business', price, garage: 0, income, cap: 5, unlock: null, blurb });

export const PROPERTIES: PropertyDef[] = [
  S('safehouse_rustvale', 'Rustvale Walk-up', 0, 1, "Above Lena's shop. Leaky roof, great view of the cranes.", 'safehouse_rustvale'),
  S('safehouse_heights', 'Palm Heights Bungalow', 18000, 2, 'Quiet street, palm trees, a garage that actually closes.'),
  S('safehouse_marina', 'Gull Point Condo', 65000, 4, 'Glass walls over the marina. Doorman does not ask questions.'),
  S('safehouse_dustwater', "Sal's Spare Room", 0, 1, 'A cot, a fan and a view of the mesas.', 'safehouse_dustwater'),
  B('biz_carwash', 'Sudz Car Wash', 12000, 650, 'Clean cars, clean money.'),
  B('biz_taco', 'Taco Tide', 8000, 420, 'Best fish tacos on the coast. Allegedly.'),
  B('biz_arcade', 'Pixel Palace Arcade', 22000, 1100, 'Quarters, neon and a back room.'),
  B('biz_motel', 'Mirage Motel', 35000, 1700, 'Hourly rates. No register.'),
  B('biz_scrapyard', 'Rustvale Scrap', 28000, 1350, 'Cars come in whole, leave as cubes.'),
];
export const PROPERTY_BY_ID: Record<string, PropertyDef> = Object.fromEntries(PROPERTIES.map((p) => [p.id, p]));

export interface EstateSave {
  owned: string[];
  /** business id → last in-game day income was collected / credited */
  businesses: Record<string, number>;
  garages: Record<string, GarageCar[]>;
}

export class Estate {
  readonly owned = new Set<string>();
  /** business → day index of last payout */
  readonly lastPaid = new Map<string, number>();
  readonly garages = new Map<string, GarageCar[]>();
  /** Story unlocks that put a property on the market / grant it. */
  readonly unlocked = new Set<string>();

  available(id: string): boolean {
    const d = PROPERTY_BY_ID[id];
    if (!d || this.owned.has(id)) return false;
    return d.unlock === null || this.unlocked.has(d.unlock);
  }

  /** Story unlock: free safehouses are granted immediately. */
  unlock(id: string, day: number): boolean {
    this.unlocked.add(id);
    const d = PROPERTY_BY_ID[id];
    if (d && d.price === 0 && !this.owned.has(id)) {
      this.grant(id, day);
      return true;
    }
    return false;
  }

  grant(id: string, day: number): void {
    const d = PROPERTY_BY_ID[id];
    if (!d) return;
    this.owned.add(id);
    if (d.kind === 'business') this.lastPaid.set(id, day);
    if (d.garage > 0 && !this.garages.has(id)) this.garages.set(id, []);
  }

  buy(id: string, wallet: Wallet, day: number): 'ok' | 'owned' | 'locked' | 'funds' | 'unknown' {
    const d = PROPERTY_BY_ID[id];
    if (!d) return 'unknown';
    if (this.owned.has(id)) return 'owned';
    if (!this.available(id)) return 'locked';
    if (!wallet.spend(d.price, `Bought ${d.name}`)) return 'funds';
    this.grant(id, day);
    return 'ok';
  }

  /** Uncollected income sitting in a business till. */
  pending(id: string, day: number): number {
    const d = PROPERTY_BY_ID[id];
    if (!d || d.kind !== 'business' || !this.owned.has(id)) return 0;
    const last = this.lastPaid.get(id) ?? day;
    const days = Math.min(d.cap, Math.max(0, Math.floor(day - last)));
    return days * d.income;
  }

  /** Collect a business till (visit or phone). */
  collect(id: string, wallet: Wallet, day: number): number {
    const amt = this.pending(id, day);
    if (amt > 0) {
      wallet.add(amt, `${PROPERTY_BY_ID[id]!.name} income`);
      this.lastPaid.set(id, Math.floor(day));
    }
    return amt;
  }

  collectAll(wallet: Wallet, day: number): number {
    let t = 0;
    for (const id of this.owned) t += this.collect(id, wallet, day);
    return t;
  }

  dailyIncome(): number {
    let t = 0;
    for (const id of this.owned) t += PROPERTY_BY_ID[id]?.income ?? 0;
    return t;
  }

  safehouses(): PropertyDef[] {
    return PROPERTIES.filter((p) => p.kind === 'safehouse' && this.owned.has(p.id));
  }

  garageCapacity(id: string): number {
    return this.owned.has(id) ? PROPERTY_BY_ID[id]?.garage ?? 0 : 0;
  }

  /** Store a car; false if full / not owned. */
  store(id: string, car: GarageCar): boolean {
    const cap = this.garageCapacity(id);
    const g = this.garages.get(id) ?? [];
    if (g.length >= cap) return false;
    g.push(car);
    this.garages.set(id, g);
    return true;
  }

  takeOut(id: string, index: number): GarageCar | null {
    const g = this.garages.get(id);
    if (!g || index < 0 || index >= g.length) return null;
    return g.splice(index, 1)[0] ?? null;
  }

  save(): EstateSave {
    return {
      owned: [...this.owned],
      businesses: Object.fromEntries(this.lastPaid),
      garages: Object.fromEntries([...this.garages].map(([k, v]) => [k, v.map((c) => structuredClone(c))])),
    };
  }

  load(s: EstateSave, unlocked: string[] = []): void {
    this.owned.clear();
    this.lastPaid.clear();
    this.garages.clear();
    this.unlocked.clear();
    for (const u of unlocked) this.unlocked.add(u);
    for (const id of s.owned ?? []) if (PROPERTY_BY_ID[id]) this.owned.add(id);
    for (const [k, v] of Object.entries(s.businesses ?? {})) this.lastPaid.set(k, v);
    for (const [k, v] of Object.entries(s.garages ?? {})) this.garages.set(k, v.map((c) => structuredClone(c)));
    for (const id of this.owned) if ((PROPERTY_BY_ID[id]?.garage ?? 0) > 0 && !this.garages.has(id)) this.garages.set(id, []);
  }
}
