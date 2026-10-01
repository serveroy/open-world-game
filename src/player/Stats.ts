/** Player vitals (pure logic). */
export class Vitals {
  health = 100;
  maxHealth = 100;
  armor = 0;
  maxArmor = 100;
  stamina = 100;
  maxStamina = 100;
  breath = 100;
  private staminaCooldown = 0;
  invulnerable = false;

  get dead(): boolean {
    return this.health <= 0;
  }

  /** Apply damage; armor absorbs 70% of it until depleted. Returns health lost. */
  damage(amount: number, ignoreArmor = false): number {
    if (this.invulnerable || amount <= 0 || this.dead) return 0;
    let dmg = amount;
    if (!ignoreArmor && this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg * 0.7);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    const before = this.health;
    this.health = Math.max(0, this.health - dmg);
    return before - this.health;
  }

  heal(amount: number): void {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addArmor(amount: number): void {
    this.armor = Math.min(this.maxArmor, this.armor + amount);
  }

  /** Try to spend stamina; returns false (and blocks regen briefly) when exhausted. */
  useStamina(amount: number): boolean {
    this.staminaCooldown = 1;
    if (this.stamina <= 0) return false;
    this.stamina = Math.max(0, this.stamina - amount);
    return true;
  }

  update(dt: number, regenRate = 22): void {
    if (this.staminaCooldown > 0) this.staminaCooldown -= dt;
    else this.stamina = Math.min(this.maxStamina, this.stamina + regenRate * dt);
  }

  reset(): void {
    this.health = this.maxHealth;
    this.stamina = this.maxStamina;
    this.breath = 100;
  }
}
