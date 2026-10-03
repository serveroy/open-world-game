/** Timing mini-game: stop the oscillating needle inside the sweet spot for each pin. */
export type LockpickResult = 'none' | 'hit' | 'miss' | 'success' | 'fail';

export class LockpickGame {
  pins: number;
  pin = 0;
  misses = 0;
  readonly maxMisses: number;
  /** Needle position 0..1 */
  needle = 0;
  private dir = 1;
  speed: number;
  zoneCenter = 0.5;
  zoneWidth: number;
  done = false;
  succeeded = false;

  constructor(private random: () => number = Math.random, difficulty = 1) {
    this.pins = 3;
    this.maxMisses = 2;
    this.speed = 0.9 * difficulty;
    this.zoneWidth = 0.22 / difficulty;
    this.newZone();
  }

  private newZone(): void {
    const w = this.zoneWidth;
    this.zoneCenter = w / 2 + this.random() * (1 - w);
  }

  tick(dt: number): void {
    if (this.done) return;
    this.needle += this.dir * this.speed * dt;
    if (this.needle >= 1) {
      this.needle = 1;
      this.dir = -1;
    } else if (this.needle <= 0) {
      this.needle = 0;
      this.dir = 1;
    }
  }

  press(): LockpickResult {
    if (this.done) return 'none';
    const inZone = Math.abs(this.needle - this.zoneCenter) <= this.zoneWidth / 2;
    if (inZone) {
      this.pin++;
      if (this.pin >= this.pins) {
        this.done = true;
        this.succeeded = true;
        return 'success';
      }
      this.speed *= 1.25;
      this.zoneWidth *= 0.82;
      this.newZone();
      return 'hit';
    }
    this.misses++;
    if (this.misses >= this.maxMisses) {
      this.done = true;
      return 'fail';
    }
    return 'miss';
  }
}
