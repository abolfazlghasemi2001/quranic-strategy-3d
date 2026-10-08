/**
 * PerfMonitor — stable FPS/ms measurement plus the renderer counters.
 * The UI reads it at ~4 Hz so the numbers are readable and the DOM is not
 * written to on every frame.
 *
 * Phase 9 optimization: the rolling frame window used to push a fresh
 * `{ t, dt }` object every frame and `shift()` it out (an O(n) memmove plus
 * ~60 small allocations per second). It is now a preallocated Float32Array
 * ring buffer — zero per-frame allocation, O(1) push/pop.
 */
export class PerfMonitor {
  constructor({ windowSeconds = 1.5, sampleInterval = 0.25, maxFps = 120 } = {}) {
    this.windowSeconds = windowSeconds;
    this.sampleInterval = sampleInterval;
    this.fps = 0;
    this.fpsMin = Infinity;
    this.fpsMax = 0;
    this.drawCalls = 0;
    this.triangles = 0;
    this.frameMs = 0;
    this.programs = 0;
    this.geometries = 0;
    this.textures = 0;
    this._elapsed = 0;
    this._sinceSample = 0;
    // Ring buffer of frame timestamps. Sized for the window at maxFps plus
    // headroom, so it never wraps mid-window under normal frame rates.
    this._capacity = Math.max(16, Math.ceil(windowSeconds * maxFps) + 2);
    this._times = new Float64Array(this._capacity);
    this._head = 0; // next write position; oldest entry is (_head - _count) mod capacity
    this._count = 0;
  }

  /** Number of frame timestamps currently inside the rolling window. */
  get frameCount() {
    return this._count;
  }

  _oldestIndex() {
    return (this._head - this._count + this._capacity) % this._capacity;
  }

  _newestIndex() {
    return (this._head - 1 + this._capacity) % this._capacity;
  }

  update(dt, stats) {
    this._elapsed += dt;

    // O(1) ring-buffer push — no per-frame object allocation.
    this._times[this._head] = this._elapsed;
    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) this._count += 1;

    // drop frames outside the rolling window (pop from the front)
    const cutoff = this._elapsed - this.windowSeconds;
    while (this._count > 2 && this._times[this._oldestIndex()] < cutoff) {
      this._count -= 1;
    }

    this._sinceSample += dt;
    if (this._sinceSample < this.sampleInterval) return null;
    this._sinceSample = 0;

    const span = Math.max(1e-4, this._times[this._newestIndex()] - this._times[this._oldestIndex()]);
    this.fps = (this._count - 1) / span;
    this.fpsMin = Math.min(this.fpsMin, this.fps);
    this.fpsMax = Math.max(this.fpsMax, this.fps);

    if (stats) {
      this.drawCalls = stats.drawCalls;
      this.triangles = stats.triangles;
      this.frameMs = stats.frameMs;
      this.programs = stats.programs;
      this.geometries = stats.geometries;
      this.textures = stats.textures;
    }

    return this.snapshot();
  }

  snapshot() {
    return {
      fps: this.fps,
      fpsMin: Number.isFinite(this.fpsMin) ? this.fpsMin : this.fps,
      fpsMax: this.fpsMax,
      drawCalls: this.drawCalls,
      triangles: this.triangles,
      frameMs: this.frameMs,
      programs: this.programs,
      geometries: this.geometries,
      textures: this.textures,
    };
  }

  /** Resets the min/max envelope (used after a quality change). */
  resetEnvelope() {
    this.fpsMin = Infinity;
    this.fpsMax = 0;
  }
}
