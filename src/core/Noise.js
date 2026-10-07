/**
 * Tiny deterministic value-noise helpers (no external dependency).
 * Used for natural looking decor clusters (forests, rock fields) and for
 * texture speckle distribution.
 */
import { hash3i } from './RNG.js';

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lattice(x, y, seed) {
  return hash3i(x, y, seed) / 4294967295;
}

/** Value noise in [0,1]. */
export function valueNoise2D(x, y, seed = 0) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const v00 = lattice(xi, yi, seed);
  const v10 = lattice(xi + 1, yi, seed);
  const v01 = lattice(xi, yi + 1, seed);
  const v11 = lattice(xi + 1, yi + 1, seed);

  const u = fade(xf);
  const v = fade(yf);

  return lerp(lerp(v00, v10, u), lerp(v01, v11, u), v);
}

/** Fractal brownian motion built on the value noise; result normalized to [0,1]. */
export function fbm2D(x, y, { octaves = 3, seed = 0, lacunarity = 2, gain = 0.5 } = {}) {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;

  for (let i = 0; i < octaves; i += 1) {
    sum += amplitude * valueNoise2D(x * frequency, y * frequency, seed + i * 1013);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }

  return norm > 0 ? sum / norm : 0;
}
