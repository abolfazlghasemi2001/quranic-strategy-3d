/**
 * Deterministic pseudo random helpers.
 * Everything that is "generated content" (decor placement, textures, jitter)
 * must go through these functions so a given seed always rebuilds the same world.
 */

/** 32-bit integer hash (xorshift-ish mix, integer only => identical on every device). */
export function hashUint32(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x = x ^ (x >>> 16);
  return x >>> 0;
}

/** Stable hash of a 2D integer coordinate plus a seed. */
export function hash2i(x, y, seed = 0) {
  let h = (seed | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (x | 0), 0x85ebca6b);
  h = Math.imul(h ^ (y | 0), 0xc2b2ae35);
  return hashUint32(h);
}

/** 3D integer hash (used by the value noise). */
export function hash3i(x, y, z) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  return hashUint32(h);
}

/** Classic mulberry32 generator: small, fast, deterministic. Returns a function -> [0,1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash based generator for one specific grid cell (so cells can be built in any order). */
export function rngAt2i(x, y, seed = 0) {
  return mulberry32(hash2i(x, y, seed));
}

/** Small convenience wrapper around a generator function. */
export class Rng {
  constructor(seed = 1) {
    this.seed = seed >>> 0;
    this._next = mulberry32(this.seed);
  }

  /** float in [0,1) */
  next() {
    return this._next();
  }

  /** float in [min,max) */
  range(min, max) {
    return min + (max - min) * this._next();
  }

  /** integer in [min,max] */
  int(min, max) {
    return Math.floor(min + (max - min + 1) * this._next());
  }

  /** true with probability p */
  chance(p) {
    return this._next() < p;
  }

  /** centered float in [-amount, amount] */
  centered(amount = 1) {
    return (this._next() * 2 - 1) * amount;
  }

  pick(array) {
    return array[Math.floor(this._next() * array.length) % array.length];
  }
}
