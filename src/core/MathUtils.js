/** Small math helpers shared by every system. Pure functions only. */

export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value) {
  return clamp(value, 0, 1);
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function inverseLerp(a, b, value) {
  return a === b ? 0 : (value - a) / (b - a);
}

export function smoothstep(edge0, edge1, value) {
  const t = clamp01(inverseLerp(edge0, edge1, value));
  return t * t * (3 - 2 * t);
}

export function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Frame-rate independent exponential smoothing.
 * `lambda` is roughly "how many e-folds per second".
 */
export function damp(current, target, lambda, dt) {
  if (lambda <= 0) return target;
  const t = 1 - Math.exp(-lambda * dt);
  return current + (target - current) * t;
}

export function dampFactor(lambda, dt) {
  return 1 - Math.exp(-lambda * Math.max(0, dt));
}

/** Wrap an angle into [-PI, PI). */
export function wrapAngle(angle) {
  let a = angle % TAU;
  if (a >= Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** Constant-speed approach (for values that should not overshoot). */
export function moveTowards(current, target, maxDelta) {
  const diff = target - current;
  if (Math.abs(diff) <= maxDelta) return target;
  return current + Math.sign(diff) * maxDelta;
}

/** Map a value from one range to another. */
export function remap(value, inMin, inMax, outMin, outMax) {
  return outMin + (outMax - outMin) * inverseLerp(inMin, inMax, value);
}
