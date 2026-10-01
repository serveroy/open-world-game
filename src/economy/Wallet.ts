/** Player cash (pure logic). */
export class Wallet {
  private _cash: number;
  readonly history: { t: number; delta: number; reason: string }[] = [];
  onChange: ((cash: number, delta: number, reason: string) => void) | null = null;
  totalEarned = 0;
  totalSpent = 0;

  constructor(start = 0) {
    this._cash = start;
  }

  get cash(): number {
    return this._cash;
  }

  add(n: number, reason = ''): void {
    if (n <= 0) return;
    this._cash += Math.round(n);
    this.totalEarned += Math.round(n);
    this.log(n, reason);
  }

  /** Spend if affordable; returns success. */
  spend(n: number, reason = ''): boolean {
    n = Math.round(n);
    if (n > this._cash) return false;
    this._cash -= n;
    this.totalSpent += n;
    this.log(-n, reason);
    return true;
  }

  /** Lose up to n (cannot go below zero); returns the amount actually taken. */
  take(n: number, reason = ''): number {
    const t = Math.min(this._cash, Math.round(n));
    this._cash -= t;
    if (t > 0) this.log(-t, reason);
    return t;
  }

  set(n: number): void {
    this._cash = Math.max(0, Math.round(n));
    this.onChange?.(this._cash, 0, 'load');
  }

  private log(delta: number, reason: string): void {
    this.history.push({ t: Date.now(), delta, reason });
    if (this.history.length > 50) this.history.shift();
    this.onChange?.(this._cash, delta, reason);
  }
}
