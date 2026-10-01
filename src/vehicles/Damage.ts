/** Vehicle damage state machine (pure logic). */
export type DamageState = 'ok' | 'smoking' | 'burning' | 'wrecked';

export class VehicleHealth {
  health: number;
  state: DamageState = 'ok';
  /** Seconds until a burning vehicle explodes. */
  fireTimer = 0;
  exploded = false;
  onExplode: (() => void) | null = null;

  constructor(readonly max: number, readonly armored = false) {
    this.health = max;
  }

  get fraction(): number {
    return Math.max(0, this.health / this.max);
  }

  /** Damage from a collision with peak deceleration `accel` (m/s²). Returns damage applied. */
  impact(accel: number): number {
    const threshold = this.armored ? 90 : 55;
    if (accel <= threshold) return 0;
    const dmg = (accel - threshold) * (this.armored ? 0.18 : 0.42);
    this.apply(dmg);
    return dmg;
  }

  apply(dmg: number): void {
    if (this.state === 'wrecked' || dmg <= 0) return;
    this.health -= dmg;
    this.refresh();
  }

  private refresh(): void {
    const f = this.fraction;
    if (this.health <= 0) {
      if (this.state !== 'burning') {
        this.state = 'burning';
        this.fireTimer = 4 + Math.random() * 3;
      }
    } else if (f < 0.35) this.state = 'smoking';
    else this.state = 'ok';
  }

  update(dt: number): void {
    if (this.state === 'burning') {
      this.fireTimer -= dt;
      if (this.fireTimer <= 0) this.explode();
    }
  }

  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    this.health = 0;
    this.state = 'wrecked';
    this.onExplode?.();
  }

  repair(): void {
    this.health = this.max;
    this.state = 'ok';
    this.exploded = false;
    this.fireTimer = 0;
  }
}

/** Gear & RPM model for engine audio/UI (pure). */
export function engineRpm(speed: number, maxSpeed: number, gears: number, throttle: number): { rpm: number; gear: number } {
  const s = Math.abs(speed);
  const span = maxSpeed / gears;
  const gear = Math.min(gears, Math.floor(s / span) + 1);
  const within = (s - (gear - 1) * span) / span;
  const idle = 850;
  const rpm = idle + within * 5400 + (gear === 1 ? throttle * 900 : 0) + (s < 0.5 ? throttle * 1800 : 0);
  return { rpm: Math.min(7200, rpm), gear };
}

/** Engine force multiplier: strong low-end torque falling off toward top speed. */
export function torqueCurve(speed: number, maxSpeed: number): number {
  const x = Math.min(1.2, Math.abs(speed) / maxSpeed);
  return Math.max(0, 1 - Math.pow(x, 2.4)) * (1 + 0.25 * (1 - x));
}
