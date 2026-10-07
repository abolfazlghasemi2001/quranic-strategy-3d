/**
 * PerfMonitor — stable FPS/ms measurement plus the renderer counters.
 * The UI reads it at ~4 Hz so the numbers are readable and the DOM is not
 * written to on every frame.
 */
export class PerfMonitor {
  constructor({ windowSeconds = 1.5, sampleInterval = 0.25 } = {}) {
    this.windowSeconds = windowSeconds;
    this.sampleInterval = sampleInterval;
    this.frames = [];
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
  }

  update(dt, stats) {
    this._elapsed += dt;
    this.frames.push({ t: this._elapsed, dt });

    // drop frames outside the rolling window
    const cutoff = this._elapsed - this.windowSeconds;
    while (this.frames.length > 2 && this.frames[0].t < cutoff) this.frames.shift();

    this._sinceSample += dt;
    if (this._sinceSample < this.sampleInterval) return null;
    this._sinceSample = 0;

    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    const span = Math.max(1e-4, last.t - first.t);
    this.fps = (this.frames.length - 1) / span;
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
