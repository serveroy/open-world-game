/** Minimal strongly-typed event bus. Event map is declared in `GameEvents`. */
export type Listener<T> = (payload: T) => void;

export class EventBus<M extends object> {
  private map = new Map<keyof M, Set<Listener<never>>>();

  on<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    let set = this.map.get(type);
    if (!set) this.map.set(type, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => this.off(type, fn);
  }
  once<K extends keyof M>(type: K, fn: Listener<M[K]>): () => void {
    const off = this.on(type, (p) => {
      off();
      fn(p);
    });
    return off;
  }
  off<K extends keyof M>(type: K, fn: Listener<M[K]>): void {
    this.map.get(type)?.delete(fn as Listener<never>);
  }
  emit<K extends keyof M>(type: K, payload: M[K]): void {
    const set = this.map.get(type);
    if (!set) return;
    for (const fn of Array.from(set)) (fn as Listener<M[K]>)(payload);
  }
  clear(): void {
    this.map.clear();
  }
}
