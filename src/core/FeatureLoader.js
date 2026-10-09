/** Single-flight lazy ownership. No panel/view may mount after terminal disposal. */
export class FeatureLoader {
  constructor() { this.features = new Map(); this.disposed = false; this.controller = new AbortController(); }
  register(key, factory) { this.features.set(key, { factory, value: null, promise: null }); return this; }
  get(key) { return this.features.get(key)?.value || null; }
  load(key) {
    if (this.disposed) return Promise.reject(new Error('feature-loader-disposed'));
    const entry = this.features.get(key);
    if (!entry) return Promise.reject(new Error(`unknown-feature:${key}`));
    if (entry.value) return Promise.resolve(entry.value);
    if (entry.promise) return entry.promise;
    entry.promise = Promise.resolve().then(() => entry.factory(this.controller.signal)).then((value) => {
      if (this.disposed) { value?.dispose?.(); throw new Error('feature-loader-disposed'); }
      entry.value = value; return value;
    }).finally(() => { entry.promise = null; });
    return entry.promise;
  }
  async loadAll() { return Promise.all([...this.features.keys()].map((key) => this.load(key))); }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.controller.abort();
    for (const entry of [...this.features.values()].reverse()) { entry.value?.dispose?.(); entry.value = null; }
  }
}
