/** Lifetime player statistics shown in the phone's Stats app (pure counters). */
export const STAT_LABELS: Record<string, string> = {
  playTime: 'Time played',
  missions: 'Story missions passed',
  kills: 'People killed',
  copKills: 'Cops killed',
  carsStolen: 'Vehicles stolen',
  carsDestroyed: 'Vehicles destroyed',
  distanceFoot: 'Distance on foot (km)',
  distanceDriven: 'Distance driven (km)',
  shots: 'Shots fired',
  maxWanted: 'Highest wanted level',
  busted: 'Times busted',
  wasted: 'Times wasted',
  racesWon: 'Street races won',
  taxiFares: 'Taxi fares completed',
  deliveries: 'Deliveries completed',
  contracts: 'Theft contracts',
  rampages: 'Rampages completed',
  events: 'Street events resolved',
  shells: 'Saint Shells found',
  dances: 'Dance-floor streaks',
  earned: 'Total earned ($)',
  spent: 'Total spent ($)',
};

export class PlayerStats {
  readonly v: Record<string, number> = {};
  inc(k: string, n = 1): void {
    this.v[k] = (this.v[k] ?? 0) + n;
  }
  max(k: string, n: number): void {
    if (n > (this.v[k] ?? 0)) this.v[k] = n;
  }
  get(k: string): number {
    return this.v[k] ?? 0;
  }
  load(s: Record<string, number>): void {
    for (const k of Object.keys(this.v)) delete this.v[k];
    for (const [k, n] of Object.entries(s ?? {})) if (typeof n === 'number' && Number.isFinite(n)) this.v[k] = n;
  }
  save(): Record<string, number> {
    return { ...this.v };
  }
  /** Human readable value. */
  format(k: string): string {
    const n = this.get(k);
    if (k === 'playTime') {
      const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60);
      return `${h}h ${String(m).padStart(2, '0')}m`;
    }
    if (k.startsWith('distance')) return (n / 1000).toFixed(1);
    if (k === 'earned' || k === 'spent') return '$' + Math.round(n).toLocaleString('en-US');
    return String(Math.round(n));
  }
}
