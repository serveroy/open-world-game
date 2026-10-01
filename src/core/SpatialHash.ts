/** 2D (XZ) uniform grid spatial hash for fast neighbour queries. */
export interface HasPos2 {
  x: number;
  z: number;
}

export class SpatialHash<T extends HasPos2> {
  private cells = new Map<number, T[]>();
  constructor(readonly cellSize = 16) {}

  private key(cx: number, cz: number): number {
    return ((cx + 32768) << 16) | ((cz + 32768) & 0xffff);
  }
  clear(): void {
    for (const arr of this.cells.values()) arr.length = 0;
  }
  insert(item: T): void {
    const k = this.key(Math.floor(item.x / this.cellSize), Math.floor(item.z / this.cellSize));
    let arr = this.cells.get(k);
    if (!arr) this.cells.set(k, (arr = []));
    arr.push(item);
  }
  /** Calls fn for items within radius r of (x,z). */
  query(x: number, z: number, r: number, fn: (item: T, d2: number) => void): void {
    const cs = this.cellSize;
    const x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
    const z0 = Math.floor((z - r) / cs), z1 = Math.floor((z + r) / cs);
    const r2 = r * r;
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const arr = this.cells.get(this.key(cx, cz));
        if (!arr) continue;
        for (const it of arr) {
          const dx = it.x - x, dz = it.z - z;
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2) fn(it, d2);
        }
      }
  }
}
