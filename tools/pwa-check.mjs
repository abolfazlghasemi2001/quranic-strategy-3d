#!/usr/bin/env node
/**
 * Phase 9 — PWA release gate (`npm run test:pwa`, runs after `npm run build`).
 *
 * This sandbox has no real browser, so this validates the *build artifacts*
 * that make the app installable and offline-capable:
 *   1. dist/index.html links the manifest and the icons,
 *   2. dist/manifest.webmanifest is valid (name, start_url, display, icons),
 *   3. both icons exist, are real PNGs and have the declared pixel sizes,
 *   4. dist/sw.js exists, precaches the app shell (index.html + hashed assets
 *      + icons + manifest) and implements install/activate/fetch handlers,
 *   5. every URL in the SW precache list exists on disk in dist/.
 *
 * It does NOT prove a real install/offline run — that needs a device test
 * (see PERFORMANCE_REPORT.md, "اهداف نیازمند اندازه‌گیری دستگاهی").
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, '../dist');

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${message}`);
  }
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...listFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

function pngSize(buffer) {
  // PNG: 8-byte signature, then IHDR — width/height are big-endian at 16/20.
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

console.log('PWA release check — dist/');

/* 1. index.html ---------------------------------------------------------- */
const indexPath = join(dist, 'index.html');
check(existsSync(indexPath), 'dist/index.html exists');
const indexHtml = readFileSync(indexPath, 'utf8');
check(indexHtml.includes('rel="manifest"'), 'index.html links the manifest');
check(/<html[^>]*lang="fa"[^>]*dir="rtl"/.test(indexHtml), 'index.html is fa/rtl');
check(indexHtml.includes('name="theme-color"'), 'index.html sets theme-color');

/* 2. manifest ------------------------------------------------------------ */
const manifestPath = join(dist, 'manifest.webmanifest');
check(existsSync(manifestPath), 'dist/manifest.webmanifest exists');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
check(Boolean(manifest.name) && Boolean(manifest.short_name), 'manifest has name + short_name');
check(manifest.lang === 'fa-IR' && manifest.dir === 'rtl', 'manifest lang/dir = fa-IR / rtl');
check(manifest.display === 'standalone', 'manifest display = standalone');
check(typeof manifest.start_url === 'string' && manifest.start_url.length > 0, 'manifest has start_url');
check(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'manifest declares >= 2 icons');

/* 3. icons --------------------------------------------------------------- */
for (const icon of manifest.icons || []) {
  const iconPath = join(dist, icon.src.replace(/^\.\//, ''));
  check(existsSync(iconPath), `icon exists: ${icon.src}`);
  if (!existsSync(iconPath)) continue;
  const size = pngSize(readFileSync(iconPath));
  check(Boolean(size), `icon is a real PNG: ${icon.src}`);
  if (!size) continue;
  const [declaredW, declaredH] = String(icon.sizes).split('x').map(Number);
  check(size.width === declaredW && size.height === declaredH,
    `icon ${icon.src} is ${declaredW}x${declaredH} px (got ${size.width}x${size.height})`);
}

/* 4. service worker ------------------------------------------------------ */
const swPath = join(dist, 'sw.js');
check(existsSync(swPath), 'dist/sw.js exists (registered by src/main.js in PROD)');
const sw = readFileSync(swPath, 'utf8');
for (const handler of ['install', 'activate', 'fetch']) {
  check(sw.includes(`addEventListener('${handler}'`), `service worker handles '${handler}'`);
}
check(sw.includes('cache.addAll') || sw.includes('cache.put'), 'service worker precaches the app shell');
check(sw.includes('caches.delete'), 'service worker cleans up old caches on activate');

const precacheMatch = sw.match(/PRECACHE_PATHS\s*=\s*(\[[^\]]*\])/);
check(Boolean(precacheMatch), 'service worker has an explicit precache list');
const precache = precacheMatch ? JSON.parse(precacheMatch[1]) : [];
check(precache.includes('./index.html'), 'precache list includes ./index.html');
check(precache.some((p) => p.startsWith('./assets/') && p.endsWith('.js')), 'precache list includes the JS bundle');
check(precache.some((p) => p.startsWith('./assets/') && p.endsWith('.css')), 'precache list includes the CSS bundle');
check(precache.includes('./manifest.webmanifest'), 'precache list includes the manifest');
check(precache.some((p) => p.includes('./icons/')), 'precache list includes icons');

/* 5. every precached URL exists on disk ---------------------------------- */
const distFiles = new Set(listFiles(dist).map((f) => `./${f.slice(dist.length + 1).split('\\').join('/')}`));
for (const path of precache) {
  check(distFiles.has(path), `precached file exists on disk: ${path}`);
}

/* summary ---------------------------------------------------------------- */
if (failures > 0) {
  console.error(`\nPWA check FAILED: ${failures} problem(s).`);
  process.exit(1);
}
console.log(`\nPWA check passed: the build is installable-shaped and precaches ${precache.length} offline files.`);
console.log('Remaining (needs a real device): install prompt, offline launch after install, Cache Storage size.');
