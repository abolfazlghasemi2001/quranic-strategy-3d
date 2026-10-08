/**
 * DayNightCycle — deterministic, frame-delta driven lighting clock.
 * No wall-clock reads and no rendering dependencies: the world layer decides
 * how the returned phase is painted. A paused game naturally pauses this clock.
 */

const TAU = Math.PI * 2;

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function sampleDayNight(phase, settings = {}) {
  const normalizedPhase = ((Number(phase) % 1) + 1) % 1;
  const angle = normalizedPhase * TAU;
  const elevation = Math.sin(angle);
  const azimuth = ((Number(settings.sunAzimuthDeg) || 0) + normalizedPhase * 360) * (Math.PI / 180);
  const horizontal = Math.cos(Math.asin(Math.max(-1, Math.min(1, elevation))));
  const daylight = smoothstep(-0.12, 0.2, elevation);
  const twilight = clamp01(1 - Math.abs(elevation) / 0.42);

  return {
    phase: normalizedPhase,
    elevation,
    daylight,
    twilight,
    sunDirection: {
      x: Math.sin(azimuth) * horizontal,
      y: elevation,
      z: Math.cos(azimuth) * horizontal,
    },
  };
}

export class DayNightCycle {
  constructor(settings = {}) {
    this.settings = settings;
    this.enabled = settings.enabled !== false;
    this.durationSeconds = Math.max(60, Number(settings.durationSeconds) || 900);
    this.phase = ((Number(settings.startPhase) || 0) % 1 + 1) % 1;
  }

  update(dt, { reducedMotion = false } = {}) {
    const elapsed = Number(dt);
    if (this.enabled && !reducedMotion && Number.isFinite(elapsed) && elapsed > 0) {
      this.phase = (this.phase + elapsed / this.durationSeconds) % 1;
    }
    return sampleDayNight(this.phase, this.settings);
  }

  setPhase(phase) {
    const numeric = Number(phase);
    if (Number.isFinite(numeric)) this.phase = ((numeric % 1) + 1) % 1;
    return this.sample();
  }

  sample() {
    return sampleDayNight(this.phase, this.settings);
  }
}
