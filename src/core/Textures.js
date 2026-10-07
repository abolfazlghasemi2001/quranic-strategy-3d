/**
 * Procedural Canvas textures — the only texture source in the project.
 * Everything is drawn from data (palette + density) with a seeded RNG, so the
 * same seed always produces the same look and nothing binary ships with the game.
 */
import * as THREE from 'three';
import { Rng } from './RNG.js';

function createCanvas(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function fillBase(ctx, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);
}

/** Large soft blotches => the ground does not look like a flat colour field. */
function drawBlotches(ctx, size, rng, colors, count = 26) {
  ctx.save();
  for (let i = 0; i < count; i += 1) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const radius = rng.range(size * 0.08, size * 0.34);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    const color = rng.pick(colors);
    gradient.addColorStop(0, `${color}${Math.round(rng.range(0.18, 0.4) * 255).toString(16).padStart(2, '0')}`);
    gradient.addColorStop(1, `${color}00`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSpeckles(ctx, size, rng, colors, count, { minRadius = 0.6, maxRadius = 2.2, minAlpha = 0.06, maxAlpha = 0.22 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const radius = rng.range(minRadius, maxRadius);
    ctx.globalAlpha = rng.range(minAlpha, maxAlpha);
    ctx.fillStyle = rng.pick(colors);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Short strokes that read as grass blades / dirt scratches from the game camera. */
function drawStrokes(ctx, size, rng, colors, count, { minLength = 3, maxLength = 8, width = 1 } = {}) {
  ctx.lineWidth = width;
  for (let i = 0; i < count; i += 1) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const length = rng.range(minLength, maxLength);
    const angle = rng.range(-0.6, 0.6) + (rng.chance(0.5) ? 0 : Math.PI / 2);
    ctx.globalAlpha = rng.range(0.08, 0.24);
    ctx.strokeStyle = rng.pick(colors);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPebbles(ctx, size, rng, colors, count, { minRadius = 1.4, maxRadius = 3.4 } = {}) {
  for (let i = 0; i < count; i += 1) {
    const x = rng.range(0, size);
    const y = rng.range(0, size);
    const radius = rng.range(minRadius, maxRadius);
    ctx.globalAlpha = rng.range(0.25, 0.6);
    ctx.fillStyle = rng.pick(colors);
    ctx.beginPath();
    ctx.ellipse(x, y, radius, radius * rng.range(0.6, 1), rng.range(0, Math.PI), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x - radius * 0.25, y - radius * 0.3, radius * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/** Per pixel grain — cheap way to remove the "flat vector" feel of canvas textures. */
function applyGrain(ctx, size, rng, amount = 12) {
  const image = ctx.getImageData(0, 0, size, size);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (rng.next() * 2 - 1) * amount;
    data[i] = Math.max(0, Math.min(255, data[i] + noise));
    data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
    data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
  }
  ctx.putImageData(image, 0, 0);
}

function toTexture(canvas, { anisotropy = 1, repeat = 1, srgb = true } = {}) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat, repeat);
  if (srgb) texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = anisotropy;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Ground texture factory.
 * @param {'grass'|'dirt'|'sand'} kind
 * @param {import('./Config.js').Config} config
 * @param {number} seed
 */
export function createGroundTexture(kind, config, seed = 1) {
  const spec = config.terrain.textures[kind];
  if (!spec) throw new Error(`Unknown ground texture kind: ${kind}`);

  const size = config.quality.textureSize || config.terrain.textures.size || 256;
  const rng = new Rng(seed >>> 0);
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const variants = spec.variants && spec.variants.length ? spec.variants : [spec.base];

  fillBase(ctx, size, spec.base);
  drawBlotches(ctx, size, rng, variants, kind === 'grass' ? 30 : 22);
  drawSpeckles(ctx, size, rng, variants, Math.round((spec.speckleCount || 2000) * (size / 256)), {
    minRadius: 0.5,
    maxRadius: kind === 'sand' ? 1.4 : 2.0,
  });

  if (kind === 'grass') {
    drawStrokes(ctx, size, rng, [variants[1] || spec.base, variants[0], '#94b872'], Math.round((spec.bladeCount || 800) * (size / 256)));
  }

  if (spec.pebbleCount) {
    drawPebbles(ctx, size, rng, [variants[0], variants[2] || spec.base, '#e6d6b8'], Math.round(spec.pebbleCount * (size / 256)));
  }

  applyGrain(ctx, size, rng, kind === 'grass' ? 10 : 8);

  const texture = toTexture(canvas, { anisotropy: config.quality.textureAnisotropy, repeat: 1 });
  texture.name = `ground-${kind}`;
  // NOTE: the canvas stays referenced by the texture (Three.js uploads it lazily on
  // the first render), so it must not be resized or cleared here.
  return texture;
}

/** Lightweight 3-stop vertical gradient texture (currently unused, kept for later UI/sky work). */
export function createGradientTexture(stops, { size = 64 } = {}) {
  const canvas = createCanvas(size);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, size);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = toTexture(canvas, { repeat: 1 });
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}
