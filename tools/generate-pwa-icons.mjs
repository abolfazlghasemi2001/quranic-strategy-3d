#!/usr/bin/env node
/**
 * Build the small PWA PNG icons from code only (no downloaded artwork).
 * Output is deterministic and deliberately contains no text or figures.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'public/icons');
mkdirSync(output, { recursive: true });

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const color = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
const mix = (a, b, t) => a.map((value, index) => Math.round(value + (b[index] - value) * t));

function roundedBoxDistance(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function circleDistance(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius;
}

function paint(pixels, size, distance, hex, { stroke = 0, alpha = 1 } = {}) {
  const rgb = color(hex);
  const antialias = 0.85 / size;
  for (let py = 0; py < size; py += 1) {
    const y = (py + 0.5) / size;
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const d = distance(x, y);
      const signed = stroke > 0 ? Math.abs(d) - stroke * 0.5 : d;
      const coverage = clamp(0.5 - signed / antialias) * alpha;
      if (coverage <= 0) continue;
      const index = (py * size + px) * 4;
      pixels[index] = Math.round(pixels[index] + (rgb[0] - pixels[index]) * coverage);
      pixels[index + 1] = Math.round(pixels[index + 1] + (rgb[1] - pixels[index + 1]) * coverage);
      pixels[index + 2] = Math.round(pixels[index + 2] + (rgb[2] - pixels[index + 2]) * coverage);
      pixels[index + 3] = 255;
    }
  }
}

function renderIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const edge = [5, 24, 29];
  const center = [20, 91, 77];
  for (let py = 0; py < size; py += 1) {
    const y = (py + 0.5) / size;
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const radius = Math.hypot((x - 0.5) * 0.96, (y - 0.43) * 0.88);
      const glow = Math.pow(clamp(1 - radius * 1.75), 1.4);
      const vignette = clamp(1 - Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) * 0.38);
      const rgb = mix(edge, center, glow * 0.9).map((channel) => Math.round(channel * vignette));
      const index = (py * size + px) * 4;
      pixels[index] = rgb[0];
      pixels[index + 1] = rgb[1];
      pixels[index + 2] = rgb[2];
      pixels[index + 3] = 255;
    }
  }

  const rounded = (cx, cy, halfW, halfH, radius) => (x, y) => roundedBoxDistance(x, y, cx, cy, halfW, halfH, radius);
  const circle = (cx, cy, radius) => (x, y) => circleDistance(x, y, cx, cy, radius);
  const gold = '#ffd77a';
  const pale = '#ffeab7';
  const teal = '#2a7469';
  const deep = '#0b3539';

  // Thin framed medallion, sized for the maskable safe zone.
  paint(pixels, size, rounded(0.5, 0.47, 0.375, 0.375, 0.115), '#ffd77a', { stroke: 0.009, alpha: 0.52 });
  paint(pixels, size, circle(0.5, 0.405, 0.245), '#a9dfbb', { stroke: 0.0045, alpha: 0.42 });

  // Geometric skyline: two simple watchtowers and a central civic hall.
  paint(pixels, size, rounded(0.305, 0.565, 0.046, 0.143, 0.018), teal);
  paint(pixels, size, rounded(0.695, 0.565, 0.046, 0.143, 0.018), teal);
  paint(pixels, size, rounded(0.305, 0.432, 0.035, 0.035, 0.03), gold);
  paint(pixels, size, rounded(0.695, 0.432, 0.035, 0.035, 0.03), gold);
  paint(pixels, size, rounded(0.305, 0.414, 0.006, 0.029, 0.003), pale);
  paint(pixels, size, rounded(0.695, 0.414, 0.006, 0.029, 0.003), pale);

  paint(pixels, size, rounded(0.5, 0.615, 0.205, 0.12, 0.035), teal);
  paint(pixels, size, circle(0.5, 0.495, 0.12), gold);
  paint(pixels, size, rounded(0.5, 0.592, 0.155, 0.12, 0.035), '#18574f');

  // Bright central arch/window: purely abstract geometry, no lettering.
  paint(pixels, size, rounded(0.5, 0.625, 0.052, 0.086, 0.05), gold);
  paint(pixels, size, rounded(0.5, 0.65, 0.032, 0.06, 0.03), deep);
  paint(pixels, size, rounded(0.5, 0.688, 0.12, 0.008, 0.006), pale, { alpha: 0.8 });

  // Small light point above the roof gives the mark a calm day/night identity.
  paint(pixels, size, circle(0.5, 0.265, 0.04), pale);
  paint(pixels, size, circle(0.5, 0.265, 0.075), gold, { stroke: 0.006, alpha: 0.72 });

  return encodePng(size, pixels);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const label = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([label, data])), 0);
  return Buffer.concat([length, label, data, checksum]);
}

function encodePng(size, pixels) {
  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    const target = row * (stride + 1);
    scanlines[target] = 0; // PNG filter: None
    Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(scanlines, target + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const file = resolve(output, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`Generated ${file}`);
}
