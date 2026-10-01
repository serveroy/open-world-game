/** Game clock (pure). One in-game day lasts `dayLengthMinutes` real minutes. */
export class GameClock {
  /** Hours since day 0, 00:00. */
  totalHours = 9;
  paused = false;
  constructor(public dayLengthMinutes = 24) {}

  get hour(): number {
    return this.totalHours % 24;
  }
  get day(): number {
    return Math.floor(this.totalHours / 24);
  }
  get minute(): number {
    return Math.floor((this.hour % 1) * 60);
  }

  advance(realSeconds: number): void {
    if (this.paused) return;
    this.totalHours += (realSeconds / (this.dayLengthMinutes * 60)) * 24;
  }

  /** Jump forward to a specific hour (next occurrence). */
  skipTo(hour: number): void {
    const cur = this.hour;
    let delta = hour - cur;
    if (delta <= 0) delta += 24;
    this.totalHours += delta;
  }

  setHour(hour: number): void {
    this.totalHours = this.day * 24 + hour;
  }

  text(): string {
    const h = Math.floor(this.hour);
    return `${h.toString().padStart(2, '0')}:${this.minute.toString().padStart(2, '0')}`;
  }

  /** Sun direction (unit vector); sunrise ~6:00, sunset ~19:00. */
  sunDir(out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const h = this.hour;
    // map 6:00 → 0, 12.5 → π/2, 19:00 → π
    const a = ((h - 6) / 13) * Math.PI;
    const el = Math.sin(a);
    const az = Math.cos(a);
    out.x = az * 0.85;
    out.y = el * 0.92 + (h > 19 || h < 6 ? -0.25 : 0);
    out.z = 0.35;
    const l = Math.hypot(out.x, out.y, out.z);
    out.x /= l;
    out.y /= l;
    out.z /= l;
    return out;
  }

  /** 0 day … 1 full night. */
  nightFactor(): number {
    const h = this.hour;
    if (h >= 7 && h <= 18.3) return 0;
    if (h > 18.3 && h < 20.2) return (h - 18.3) / 1.9;
    if (h >= 5.2 && h < 7) return 1 - (h - 5.2) / 1.8;
    return 1;
  }

  isNight(): boolean {
    return this.nightFactor() > 0.5;
  }
}

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'storm' | 'sandstorm' | 'fog';

export interface WeatherParams {
  cloud: number;
  rain: number;
  sand: number;
  fogMul: number;
  sunMul: number;
}

export const WEATHER_PARAMS: Record<WeatherKind, WeatherParams> = {
  clear: { cloud: 0.15, rain: 0, sand: 0, fogMul: 1, sunMul: 1 },
  cloudy: { cloud: 0.65, rain: 0, sand: 0, fogMul: 0.8, sunMul: 0.6 },
  rain: { cloud: 0.9, rain: 0.7, sand: 0, fogMul: 0.45, sunMul: 0.35 },
  storm: { cloud: 1, rain: 1, sand: 0, fogMul: 0.32, sunMul: 0.22 },
  sandstorm: { cloud: 0.5, rain: 0, sand: 1, fogMul: 0.6, sunMul: 0.55 },
  fog: { cloud: 0.6, rain: 0, sand: 0, fogMul: 0.18, sunMul: 0.5 },
};

/** Weather state machine: weighted random transitions every few game hours. */
export class WeatherSystem {
  current: WeatherKind = 'clear';
  target: WeatherKind = 'clear';
  blend = 1;
  private nextChange = 4;
  readonly params: WeatherParams = { ...WEATHER_PARAMS.clear };
  locked = false;

  constructor(private random: () => number = Math.random) {}

  set(kind: WeatherKind, immediate = false): void {
    if (immediate) {
      this.current = this.target = kind;
      this.blend = 1;
      Object.assign(this.params, WEATHER_PARAMS[kind]);
    } else if (kind !== this.target) {
      this.current = this.target;
      this.target = kind;
      this.blend = 0;
    }
  }

  /** @param gameHours elapsed game hours this frame, @param realDt seconds */
  update(gameHours: number, realDt: number): void {
    if (!this.locked) {
      this.nextChange -= gameHours;
      if (this.nextChange <= 0) {
        this.nextChange = 3 + this.random() * 4;
        const opts: WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm', 'sandstorm', 'fog'];
        const w = [5, 2.5, 1.4, 0.5, 1.2, 0.5];
        let r = this.random() * w.reduce((a, b) => a + b, 0);
        let pick: WeatherKind = 'clear';
        for (let i = 0; i < opts.length; i++) {
          r -= w[i]!;
          if (r <= 0) {
            pick = opts[i]!;
            break;
          }
        }
        this.set(pick);
      }
    }
    if (this.blend < 1) this.blend = Math.min(1, this.blend + realDt / 40);
    const a = WEATHER_PARAMS[this.current], b = WEATHER_PARAMS[this.target];
    const t = this.blend;
    this.params.cloud = a.cloud + (b.cloud - a.cloud) * t;
    this.params.rain = a.rain + (b.rain - a.rain) * t;
    this.params.sand = a.sand + (b.sand - a.sand) * t;
    this.params.fogMul = a.fogMul + (b.fogMul - a.fogMul) * t;
    this.params.sunMul = a.sunMul + (b.sunMul - a.sunMul) * t;
  }
}
