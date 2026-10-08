#!/usr/bin/env node
/**
 * HUD screenshot set (phase 10).
 *
 * Captures the same viewports/states in one run so a PR can show a real
 * before/after pair:
 *
 *   node tools/hud-screenshots.mjs docs/hud-redesign/before   # on main
 *   node tools/hud-screenshots.mjs docs/hud-redesign/after    # on the branch
 *
 * Notes that matter for honesty:
 *   - Chromium runs with SwiftShader (software GL) in this sandbox, so these
 *     images prove LAYOUT and readability, never frame rate or GPU cost.
 *   - The day/night clock is pinned (`dayNight.setPhase`) and reduced motion is
 *     on, so the *world* is identical between the two runs; only the HUD moves.
 *
 * Usage: node tools/hud-screenshots.mjs <outDir> [--url http://127.0.0.1:5173/]
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outDir = args.find((arg) => !arg.startsWith('--')) || 'docs/hud-redesign/after';
const urlIndex = args.indexOf('--url');
const url = urlIndex >= 0 ? args[urlIndex + 1] : (process.env.HUD_URL || 'http://127.0.0.1:5173/');

const VIEWPORTS = [
  { name: 'portrait-360x740', width: 360, height: 740 },
  { name: 'portrait-390x844', width: 390, height: 844 },
  { name: 'portrait-412x915', width: 412, height: 915 },
  { name: 'tablet-768x1024', width: 768, height: 1024 },
  { name: 'landscape-844x390', width: 844, height: 390 },
];
/** `state` switches what the game shows behind the HUD. */
const VARIANTS = [
  { suffix: '', options: {} },
  { suffix: '-fontscale-max', options: { fontScale: 'larger' } },
  { suffix: '-queue', options: { state: 'queue' } },
  { suffix: '-selection', options: { state: 'selection' } },
];
const EXTRA_VARIANTS_FOR = ['portrait-412x915', 'landscape-844x390'];

async function resolveChromium() {
  if (process.env.HUD_CHROMIUM_PATH) {
    return { executablePath: process.env.HUD_CHROMIUM_PATH, launchEnv: { ...process.env } };
  }
  try {
    const { default: chromium, inflate } = await import('@sparticuz/chromium');
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(dirname(require.resolve('@sparticuz/chromium')));
    await inflate(join(packageRoot, 'bin', 'al2023.tar.br'));
    return {
      executablePath: await chromium.executablePath(),
      launchEnv: { ...process.env, LD_LIBRARY_PATH: [join(tmpdir(), 'al2023', 'lib'), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
    };
  } catch {
    return { executablePath: null, launchEnv: { ...process.env } };
  }
}

const { executablePath, launchEnv } = await resolveChromium();
const { chromium } = await import('@playwright/test');
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  env: launchEnv,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--disable-dev-shm-usage'],
});

/** Prepares a deterministic frame: fixed seed/world, pinned time of day. */
async function capture(viewport, variant, file) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.width < 900,
    hasTouch: viewport.width < 900,
    locale: 'fa-IR',
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.game-hud', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.ui-loading'), null, { timeout: 120000 });
  await page.evaluate(({ fontScale, state }) => {
    const nur = window.__NUR__;
    if (fontScale) nur.metaSystem.setSetting('fontScale', fontScale);
    nur.world.setReducedMotion(true);
    nur.world.dayNight.setPhase(0.18);      // fixed morning light for both runs
    nur.ftueGuide?.dispose?.();             // the onboarding overlay is not the HUD
    if (state === 'queue' || state === 'selection') {
      // enough budget for the fixture building the screenshot needs
      nur.game.state.resources.rizq = 900;
      nur.game.state.resources.nur = 700;
      nur.game.state.resources.hekmat = 500;
      nur.game.state.resources.gohar = 24;
      nur.game.emitState(Date.now(), true);
      const def = nur.buildings.byId.get('farm');
      nur.buildings.startPlacement('farm');   // must be active before moving the preview
      outer: for (let row = 2; row < nur.config.rows - def.size[1]; row += 1) {
        for (let col = 2; col < nur.config.cols - def.size[0]; col += 1) {
          if (nur.buildings.canPlace(def, col, row)) { nur.buildings._movePreview(col, row); break outer; }
        }
      }
      nur.buildings.confirmPlacement();
      nur.buildings.cancelPlacement?.();
      if (state === 'selection') {
        const farm = [...nur.game.state.entities.values()].find((entity) => entity.type === 'farm');
        if (farm) nur.buildings.select(farm);
      }
    }
    nur.game.emitState(Date.now(), true);   // stable numbers in the status bar
  }, { fontScale: variant.options.fontScale ?? null, state: variant.options.state ?? 'idle' });
  await page.waitForTimeout(900);
  mkdirSync(resolve(root, outDir), { recursive: true });
  await page.screenshot({ path: resolve(root, outDir, file) });
  await page.close();
  console.log(`  · ${outDir}/${file}`);
}

console.log(`HUD screenshots → ${outDir} (${url})`);
for (const viewport of VIEWPORTS) {
  for (const variant of VARIANTS) {
    if (variant.suffix && !EXTRA_VARIANTS_FOR.includes(viewport.name)) continue;
    await capture(viewport, variant, `${viewport.name}${variant.suffix}.png`);
  }
}
await browser.close();
console.log('done — SwiftShader layout proof, not a GPU benchmark.');
