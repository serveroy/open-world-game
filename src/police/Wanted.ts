/** Wanted level logic (pure — unit tested). */
import type { CrimeType } from '../game/events';

export interface CrimeRule {
  heat: number;
  /** Minimum stars this crime forces when seen by police. */
  minStars: number;
  /** Counts even without witnesses (e.g. stealing a police car in front of you). */
  always?: boolean;
}

export const CRIMES: Record<CrimeType, CrimeRule> = {
  assault: { heat: 0.7, minStars: 1 },
  theft: { heat: 0.9, minStars: 1 },
  carjack: { heat: 1.1, minStars: 1 },
  shooting: { heat: 1.2, minStars: 1 },
  murder: { heat: 2.4, minStars: 2 },
  copAssault: { heat: 2.2, minStars: 2 },
  copMurder: { heat: 4.5, minStars: 3 },
  explosion: { heat: 2.0, minStars: 2 },
  vehicleDamage: { heat: 0.4, minStars: 1 },
  stealPolice: { heat: 1.6, minStars: 1, always: true },
  trespass: { heat: 1.0, minStars: 1 },
  alarm: { heat: 0.5, minStars: 1 },
  hitAndRun: { heat: 1.0, minStars: 1 },
  reported: { heat: 1.0, minStars: 1, always: true },
};

/** Heat needed for each star (index = stars). */
export const STAR_HEAT = [0, 1, 3.5, 7.5, 13, 21];

export class WantedSystem {
  heat = 0;
  stars = 0;
  /** True when police lost visual contact (stars flash). */
  searching = false;
  /** Seconds since any unit saw the player. */
  unseen = 0;
  /** Seconds spent in search mode. */
  searchTime = 0;
  readonly lastSeen = { x: 0, z: 0 };
  /** Max stars allowed (missions can cap or lock). */
  maxStars = 5;
  minStars = 0;
  /** Missions can freeze changes. */
  locked = false;
  onChange: ((stars: number, prev: number) => void) | null = null;
  readonly searchDelay = 4;

  get searchRadius(): number {
    return 70 + this.stars * 45;
  }

  /** Time needed hidden / out of radius to lose the cops. */
  get loseTime(): number {
    return 8 + this.stars * 6;
  }

  get flashing(): boolean {
    return this.searching && this.stars > 0;
  }

  private setStars(s: number): void {
    s = Math.max(this.minStars, Math.min(this.maxStars, s));
    if (s === this.stars) return;
    const prev = this.stars;
    this.stars = s;
    if (s === 0) {
      this.heat = 0;
      this.searching = false;
      this.searchTime = 0;
    }
    this.onChange?.(s, prev);
  }

  /**
   * Register a crime. `witnessed` = civilians saw it (will be reported),
   * `seenByCop` = an officer saw it directly (immediate, harsher).
   */
  crime(type: CrimeType, witnessed: boolean, seenByCop: boolean, x: number, z: number): void {
    if (this.locked) return;
    const r = CRIMES[type];
    if (!r) return;
    if (!witnessed && !seenByCop && !r.always) return;
    let heat = r.heat * (seenByCop ? 1.5 : 1);
    // already wanted: crimes add on top; while wanted every crime refreshes search
    if (this.stars > 0) heat *= 0.8;
    this.heat = Math.min(30, this.heat + heat);
    let s = this.starsForHeat();
    if (seenByCop || r.always || type === 'reported') s = Math.max(s, r.minStars);
    if (s > this.stars) this.setStars(s);
    if (seenByCop) this.seen(x, z);
    else if (this.stars > 0 && !this.searching) {
      this.lastSeen.x = x;
      this.lastSeen.z = z;
    }
  }

  starsForHeat(): number {
    let s = 0;
    for (let i = 1; i < STAR_HEAT.length; i++) if (this.heat >= STAR_HEAT[i]!) s = i;
    return s;
  }

  /** Force a level (missions). */
  set(stars: number): void {
    this.heat = Math.max(this.heat, STAR_HEAT[Math.min(5, stars)]!);
    this.setStars(stars);
    if (stars > 0) this.unseen = 0;
  }

  /** A police unit has eyes on the player. */
  seen(x: number, z: number): void {
    this.lastSeen.x = x;
    this.lastSeen.z = z;
    this.unseen = 0;
    this.searching = false;
    this.searchTime = 0;
  }

  /**
   * @param copSees any unit currently sees the player
   * @param px,pz player position
   * @param hidden player is in a hiding spot (under cover / inside)
   */
  update(dt: number, copSees: boolean, px: number, pz: number, hidden = false): void {
    if (this.stars === 0) return;
    if (copSees && !hidden) {
      this.seen(px, pz);
      return;
    }
    this.unseen += dt;
    if (!this.searching && this.unseen >= this.searchDelay) {
      this.searching = true;
      this.searchTime = 0;
    }
    if (this.searching && !this.locked) {
      const d = Math.hypot(px - this.lastSeen.x, pz - this.lastSeen.z);
      const outside = d > this.searchRadius;
      this.searchTime += dt * (outside ? 2.2 : 1) * (hidden ? 1.6 : 1);
      if (this.searchTime >= this.loseTime) this.clear();
    }
  }

  /** Respray / mission end / evaded. */
  clear(): void {
    if (this.minStars > 0) {
      this.searching = false;
      this.searchTime = 0;
      return;
    }
    this.heat = 0;
    this.searching = false;
    this.unseen = 0;
    this.searchTime = 0;
    this.setStars(0);
  }

  /** Respray only works if no cop is watching. */
  respray(copSees: boolean): boolean {
    if (copSees || this.stars === 0) return this.stars === 0;
    this.clear();
    return true;
  }
}
