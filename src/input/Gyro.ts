import type { Input } from './Input';
import type { Settings } from '../core/Settings';

/** Optional gyro aiming: device rotation adds to look input while aiming. */
export class Gyro {
  private lastA: number | null = null;
  private lastB: number | null = null;
  active = false;
  private granted = false;
  constructor(private input: Input, private settings: Settings) {
    addEventListener('deviceorientation', (e) => this.onOrient(e));
  }

  /** iOS needs an explicit permission request from a user gesture. */
  async requestPermission(): Promise<boolean> {
    const D = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    if (D?.requestPermission) {
      try {
        this.granted = (await D.requestPermission()) === 'granted';
      } catch {
        this.granted = false;
      }
    } else this.granted = true;
    return this.granted;
  }

  private onOrient(e: DeviceOrientationEvent): void {
    if (!this.settings.data.gyroAim || !this.active || e.beta === null || e.gamma === null) {
      this.lastA = this.lastB = null;
      return;
    }
    // landscape: gamma ≈ pitch, beta ≈ yaw-ish
    const landscape = Math.abs((screen.orientation?.angle ?? 90)) === 90;
    const a = landscape ? e.beta : e.gamma;
    const b = landscape ? e.gamma : e.beta;
    if (this.lastA !== null && this.lastB !== null) {
      const sens = 0.012 * this.settings.data.aimSensitivity;
      const sign = (screen.orientation?.angle ?? 90) === 270 || (screen.orientation?.angle ?? 90) === -90 ? -1 : 1;
      this.input.lookX += (a - this.lastA) * sens * sign;
      this.input.lookY += (b - this.lastB) * sens * sign;
    }
    this.lastA = a;
    this.lastB = b;
  }
}
