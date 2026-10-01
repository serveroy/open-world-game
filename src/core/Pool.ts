/** Generic object pool. `create` builds a new item, `reset` prepares an item for reuse. */
export class Pool<T> {
  private free: T[] = [];
  readonly active = new Set<T>();
  constructor(private create: () => T, private reset?: (item: T) => void, prewarm = 0) {
    for (let i = 0; i < prewarm; i++) this.free.push(this.create());
  }
  acquire(): T {
    const item = this.free.pop() ?? this.create();
    this.active.add(item);
    return item;
  }
  release(item: T): void {
    if (!this.active.delete(item)) return;
    this.reset?.(item);
    this.free.push(item);
  }
  get size(): number {
    return this.active.size + this.free.length;
  }
}

/** Fixed-capacity ring buffer index allocator for particles/decals: oldest gets recycled. */
export class Ring {
  private i = 0;
  constructor(readonly capacity: number) {}
  next(): number {
    const v = this.i;
    this.i = (this.i + 1) % this.capacity;
    return v;
  }
}
