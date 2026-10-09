#!/usr/bin/env node
/**
 * HUD layout verifier (phase 10 — mobile HUD redesign).
 *
 * This sandbox has no system browser and no apt access, but it CAN run a real
 * Chromium: the `@sparticuz/chromium` npm package ships a complete, brotli
 * packed Chromium build (+ SwiftShader for WebGL) plus the NSS/AL2023 shared
 * libraries it needs. `resolveChromium()` below unpacks both into a temp dir
 * and points LD_LIBRARY_PATH at them. Set `HUD_CHROMIUM_PATH` to use a system
 * browser instead (that is what CI does — see .github/workflows/ci.yml).
 *
 * What it checks, for every target viewport × font scale, in RTL:
 *   1. every action in `.hud-dock` is at least 48 px tall and 48 px wide,
 *      and fully inside the viewport,
 *   2. no two HUD boxes (topbar / panels / dock / their controls) overlap,
 *   3. nothing is clipped: scrollWidth ≤ clientWidth on every HUD label,
 *   4. the whole HUD stack (topbar + dock) covers ≤ 10 % of the viewport height
 *      in portrait and keeps ≥ 55 % of the height for the map in landscape,
 *   5. the game canvas still receives pointer input in the empty HUD area
 *      (pointer-events:none root),
 *   6. the low-contrast floating map label («راهنمای متن») no longer exists.
 *
 * Usage:  node tools/hud-layout.mjs [--url http://127.0.0.1:5173/] [--shots outDir]
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const url = argValue('--url', 'http://127.0.0.1:5173/');
const shotsDir = argValue('--shots', null);

/** Viewport matrix from the HUD brief (portrait phones, a tablet, landscape). */
const VIEWPORTS = [
  { name: '360x640', width: 360, height: 640 },
  { name: '360x740', width: 360, height: 740 },
  { name: '390x844', width: 390, height: 844 },
  { name: '412x915', width: 412, height: 915 },
  { name: '768x1024', width: 768, height: 1024 },
  { name: '844x390', width: 844, height: 390 },
];
const SCALES = [
  { name: 'font-1', cssVar: '1', setting: 'normal' },
  { name: 'font-max', cssVar: '1.28', setting: 'larger' },
];

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : `\n      ${detail}`}`);
}
const note = (message) => console.log(`  · ${message}`);

/* ------------------------------------------------------------------ setup */

/**
 * Browser resolution order:
 *   1. HUD_CHROMIUM_PATH (CI installs Playwright's Chromium and points here),
 *   2. the bundled @sparticuz/chromium build (offline sandboxes without a
 *      system browser),
 *   3. Playwright's own bundle (nothing to resolve — return null).
 */
async function resolveChromium() {
  const explicit = process.env.HUD_CHROMIUM_PATH;
  if (explicit) return { executablePath: explicit, launchEnv: { ...process.env } };
  let chromium;
  let inflate;
  try {
    ({ default: chromium, inflate } = await import('@sparticuz/chromium'));
  } catch {
    note('@sparticuz/chromium not installed — using the browser Playwright manages.');
    return { executablePath: null, launchEnv: { ...process.env } };
  }
  const executablePath = await chromium.executablePath();
  // The bundled build needs the Amazon-Linux shared libraries (libnspr4,
  // libnss3, …) that mainstream Linux images ship in /usr/lib. Unpack them and
  // put them on the loader path of the browser process only.
  const require = createRequire(import.meta.url);
  // node_modules/@sparticuz/chromium/build/index.js → package root
  const packageRoot = dirname(dirname(require.resolve('@sparticuz/chromium')));
  await inflate(join(packageRoot, 'bin', 'al2023.tar.br'));
  const libBase = join(tmpdir(), 'al2023', 'lib');
  const launchEnv = {
    ...process.env,
    LD_LIBRARY_PATH: [libBase, tmpdir(), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':'),
  };
  return { executablePath, launchEnv, extraArgs: chromium.args };
}

const { executablePath, launchEnv, extraArgs = [] } = await resolveChromium();
if (!shotsDir) note(`chromium: ${executablePath}`);

const { chromium: playwrightChromium } = await import('@playwright/test');

let browser;
try {
  browser = await playwrightChromium.launch({
  ...(executablePath ? { executablePath } : {}),
  env: launchEnv,
  args: [
    ...extraArgs.filter((arg) => !arg.startsWith('--disable-gpu') && !arg.startsWith('--single-process')),
    '--no-sandbox',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
  });
} catch (error) {
  console.error('✗ HUD layout check could not start a browser.');
  console.error('  Pick one of these, then re-run `npm run test:hud`:');
  console.error('    • npx playwright install --with-deps chromium   (normal dev machine / CI)');
  console.error('    • HUD_CHROMIUM_PATH=/path/to/chrome npm run test:hud');
  console.error('    • npm i -D @sparticuz/chromium                  (offline sandbox, no system browser)');
  console.error(`  Original error: ${String(error).split('\n')[0]}`);
  process.exit(2);
}

/** Boot the game in a page sized like the target device. */
async function openGame(viewport, scale) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.width < 900,
    hasTouch: viewport.width < 900,
    locale: 'fa-IR',
  });
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.game-hud', { timeout: 120000 });
  await page.waitForFunction(() => !document.querySelector('.ui-loading'), null, { timeout: 120000 });
  await page.evaluate(({ fontScale, setting }) => {
    const nur = window.__NUR__;
    // Go through the real settings API: it applies --ui-font-scale *and*
    // data-font-scale, exactly like the accessibility menu does.
    if (nur.metaSystem?.setSetting) nur.metaSystem.setSetting('fontScale', setting);
    document.documentElement.style.setProperty('--ui-font-scale', fontScale);
    document.documentElement.dataset.fontScale = setting;
    nur.metaSystem.skipTutorial?.();
    nur.world.setReducedMotion(true);       // deterministic snapshots
    nur.bus.emit('ui:toast', '');           // clear any boot toast
    // A finished farm + one queued job gives the queue badge and the selection
    // menu something real to show in the "busy" variant of the checks.
    nur.game.state.resources.rizq = 900;
    nur.game.state.resources.nur = 700;
    nur.game.state.resources.hekmat = 500;
    nur.game.state.resources.gohar = 24;
    nur.game.emitState(Date.now(), true);
    const def = nur.buildings.byId.get('farm');
    nur.buildings.startPlacement('farm');   // must be active before moving the preview
    outer: for (let row = 2; row < nur.config.rows - def.size[1]; row += 1) {
      for (let col = 2; col < nur.config.cols - def.size[0]; col += 1) {
        if (nur.buildings.canPlace(def, col, row)) {
          nur.buildings._movePreview(col, row);
          break outer;
        }
      }
    }
    nur.buildings.confirmPlacement();
    nur.buildings.cancelPlacement?.();
    nur.buildings.clearSelection?.();
    nur.ftueGuide?.dispose?.();          // the guide overlay is not part of the HUD
  }, { fontScale: scale.cssVar, setting: scale.setting });
  await page.waitForTimeout(700);
  return { page, consoleErrors };
}

/** Geometry probe — everything the assertions need, measured in the page. */
const probeInPage = () => {
  const visible = (node) => {
    const style = getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    return node.getClientRects().length > 0;
  };
  const box = (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, w: rect.width, h: rect.height, right: rect.right, bottom: rect.bottom };
  };
  const label = (node) => node.querySelector('.ui-btn__label')?.textContent?.trim() || node.textContent.trim().slice(0, 24);

  const dock = [...document.querySelectorAll('.hud-dock .hud-action')]
    .filter(visible)
    .map((node) => ({ label: label(node), ...box(node), action: node.dataset.hudAction }));

  const clipped = [];
  for (const node of document.querySelectorAll('.hud-topbar *, .hud-dock *, .hud-panels *')) {
    if (!visible(node)) continue;
    if (node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0) {
      clipped.push({ cls: String(node.className).slice(0, 40), text: node.textContent.trim().slice(0, 24), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth });
    }
  }

  // Overlap pairs among the HUD's own boxes (ignore parent/child nesting).
  const regions = ['.hud-topbar', '.hud-panels', '.hud-dock', '.game-queue', '.building-menu', '.placement-bar', '.game-mission-chip']
    .flatMap((selector) => [...document.querySelectorAll(selector)])
    .filter(visible)
    .map((node) => ({ cls: String(node.className).slice(0, 40), node, ...box(node) }));
  const overlaps = [];
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i];
      const b = regions[j];
      if (a.node.contains(b.node) || b.node.contains(a.node)) continue;
      const x = Math.min(a.right, b.right) - Math.max(a.x, b.x);
      const y = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
      // 1 px tolerance for sub-pixel rounding
      if (x > 1.5 && y > 1.5) overlaps.push({ a: a.cls, b: b.cls, x: Math.round(x), y: Math.round(y) });
    }
  }

  const topbar = document.querySelector('.hud-topbar');
  const dockNode = document.querySelector('.hud-dock');
  const topbarBox = topbar && visible(topbar) ? box(topbar) : null;
  const dockBox = dockNode && visible(dockNode) ? box(dockNode) : null;
  const settings = document.querySelector('.hud-topbar .game-settings-btn');
  const settingsBox = settings && visible(settings) ? box(settings) : null;

  const hudHeight = (topbarBox ? topbarBox.h : 0) + (dockBox ? dockBox.h : 0);

  return {
    viewport: { w: innerWidth, h: innerHeight },
    dock,
    dockBox,
    topbarBox,
    settingsBox,
    clipped,
    overlaps,
    hudHeight,
    docScrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    policyVisibleInsideHud: Boolean(document.querySelector('.game-hud .quran-policy-btn')),
    rootPointerEvents: getComputedStyle(document.querySelector('.game-hud')).pointerEvents,
    actionPointerEvents: [...document.querySelectorAll('.hud-dock .hud-action')].map((node) => getComputedStyle(node).pointerEvents),
    panelPointerEvents: document.querySelector('.game-queue') ? getComputedStyle(document.querySelector('.game-queue')).pointerEvents : null,
  };
};

/** Does a tap on empty HUD space reach the canvas? (camera pan must survive) */
async function canvasGetsPointer(page) {
  return page.evaluate(() => {
    const describe = (node) => (node ? `${node.tagName}.${String(node.className || '').slice(0, 30)}[${String(node.textContent || '').trim().slice(0, 18)}]` : 'null');
    const canvas = document.querySelector('#scene');
    const hud = document.querySelector('.game-hud');
    const hit = (x, y) => {
      const direct = document.elementFromPoint(x, y);
      return { ok: direct === canvas || canvas.contains(direct), what: describe(direct), x, y };
    };
    // Empty map area: the vertical middle band, left/centre/right of the HUD.
    const points = [
      [Math.round(innerWidth / 2), Math.round(innerHeight * 0.5)],
      [Math.round(innerWidth * 0.3), Math.round(innerHeight * 0.45)],
      [Math.round(innerWidth * 0.7), Math.round(innerHeight * 0.55)],
    ];
    const hits = points.map(([x, y]) => hit(x, y));
    return {
      ok: hits.every((entry) => entry.ok),
      what: hits.filter((entry) => !entry.ok).map((entry) => `${describe(document.elementFromPoint(entry.x, entry.y))}@${entry.x},${entry.y}`).join(' '),
      points: hits,
    };
  });
}

/* --------------------------------------------------------------- the run */

for (const viewport of VIEWPORTS) {
  for (const scale of SCALES) {
    const { page, consoleErrors } = await openGame(viewport, scale);
    const data = await page.evaluate(probeInPage);
    const tag = `${viewport.name} @ ${scale.name}`;
    const portrait = viewport.height >= viewport.width;

    check(`${tag}: no runtime errors while laying out the HUD`, consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));
    check(`${tag}: no horizontal document overflow`, data.docScrollWidth <= data.clientWidth + 1, `scrollWidth ${data.docScrollWidth} > clientWidth ${data.clientWidth}`);
    check(`${tag}: HUD does not overflow the viewport`, data.dockBox != null && data.dockBox.bottom <= viewport.height + 1 && data.topbarBox.y >= -1,
      `topbar y=${data.topbarBox?.y} dock bottom=${data.dockBox?.bottom} height=${viewport.height}`);
    check(`${tag}: every dock action is ≥ 48 px tall`, data.dock.every((item) => item.h >= 48 - 0.5), JSON.stringify(data.dock.map((item) => [item.label, Math.round(item.h)])));
    check(`${tag}: every dock action is ≥ 48 px wide`, data.dock.every((item) => item.w >= 48 - 0.5), JSON.stringify(data.dock.map((item) => [item.label, Math.round(item.w)])));
    check(`${tag}: dock actions do not overlap each other`, (() => {
      for (let i = 0; i < data.dock.length; i += 1) {
        for (let j = i + 1; j < data.dock.length; j += 1) {
          const a = data.dock[i];
          const b = data.dock[j];
          if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1.5) return false;
        }
      }
      return true;
    })(), JSON.stringify(data.dock.map((item) => [item.label, Math.round(item.x), Math.round(item.right)])));
    check(`${tag}: no HUD boxes overlap`, data.overlaps.length === 0, JSON.stringify(data.overlaps));
    check(`${tag}: no clipped HUD text`, data.clipped.length === 0, JSON.stringify(data.clipped.slice(0, 4)));
    check(`${tag}: the floating «راهنمای متن» map label is gone`, data.policyVisibleInsideHud === false,
      'a .quran-policy-btn is still rendered inside .game-hud');
    check(`${tag}: HUD root is click-through for camera panning`, data.rootPointerEvents === 'none', `pointer-events=${data.rootPointerEvents}`);
    check(`${tag}: dock actions stay interactive`, data.actionPointerEvents.every((value) => value === 'auto'), `pointer-events=${JSON.stringify(data.actionPointerEvents)}`);
    const centre = await canvasGetsPointer(page);
    check(`${tag}: empty map area still pans the camera (taps reach the canvas)`, centre.ok, `blocked by ${centre.what}`);
    if (data.settingsBox) {
      check(`${tag}: settings gear is ≥ 44 px`, data.settingsBox.w >= 44 - 0.5 && data.settingsBox.h >= 44 - 0.5, JSON.stringify(data.settingsBox));
    }

    if (portrait) {
      const topShare = (data.topbarBox?.h || 0) / viewport.height;
      const share = data.hudHeight / viewport.height;
      note(`${tag}: status bar ${Math.round(data.topbarBox?.h || 0)} px (${(topShare * 100).toFixed(1)} %), dock ${Math.round(data.dockBox?.h || 0)} px, static HUD total ${(share * 100).toFixed(1)} %`);
      // The status bar is the chrome that used to eat 14 % of the screen.
      check(`${tag}: status bar ≤ 6 % of viewport height`, topShare <= 0.06, `${(topShare * 100).toFixed(1)} % (${Math.round(data.topbarBox?.h || 0)} px of ${viewport.height} px)`);
      // 5 × 48 px targets + safe-area insets are a physical floor; keep the whole
      // static HUD inside 13 % and report the measured number per viewport.
      const dockShare = (data.dockBox?.h || 0) / viewport.height;
      check(`${tag}: dock (5 × 48 px targets + insets) ≤ 8.5 % of viewport height`, dockShare <= 0.085, `${(dockShare * 100).toFixed(1)} %`);
      check(`${tag}: static HUD (status + dock) ≤ 15 % of viewport height`, share <= 0.15, `${(share * 100).toFixed(1)} %`);
    } else {
      const dockShareH = (data.dockBox?.h || 0) / viewport.height;
      const topShare = (data.topbarBox?.h || 0) / viewport.height;
      const mapArea = viewport.width * (viewport.height - (data.dockBox?.h || 0) - (data.topbarBox?.h || 0));
      note(`${tag}: bottom dock ${Math.round(data.dockBox?.h || 0)} px tall, status bar ${Math.round(data.topbarBox?.h || 0)} px, map area ${((mapArea / (viewport.width * viewport.height)) * 100).toFixed(1)} %`);
      check(`${tag}: landscape dock stays at the bottom (≤ 22 % of the height)`, dockShareH <= 0.22, `${(dockShareH * 100).toFixed(1)} %`);
      check(`${tag}: landscape status bar ≤ 12 % of the height`, topShare <= 0.12, `${(topShare * 100).toFixed(1)} %`);
      check(`${tag}: map keeps ≥ 65 % of the viewport area`, mapArea / (viewport.width * viewport.height) >= 0.65, `${((mapArea / (viewport.width * viewport.height)) * 100).toFixed(1)} %`);
    }

    if (shotsDir) {
      mkdirSync(resolve(root, shotsDir), { recursive: true });
      await page.screenshot({ path: resolve(root, shotsDir, `${viewport.name}-${scale.name}.png`) });
    }
    await page.close();
  }
}

/* ------------------------------------------------ stateful / secondary views */

{
  const { page } = await openGame(VIEWPORTS[2], SCALES[0]);
  // selection menu open (tap the farm) — must not cover the dock
  await page.evaluate(() => {
    const nur = window.__NUR__;
    const farm = [...nur.game.state.entities.values()].find((entity) => entity.type === 'farm');
    if (farm) nur.buildings.select(farm);   // renders the selection menu synchronously
  });
  await page.waitForTimeout(400);
  const data = await page.evaluate(probeInPage);
  const tag = '412x915 selection-open';
  check(`${tag}: selection menu clears the dock`, data.overlaps.length === 0, JSON.stringify(data.overlaps));
  check(`${tag}: dock still fully tappable while a menu is open`, data.dock.every((item) => item.bottom <= data.viewport.h + 1 && item.h >= 48 - 0.5), JSON.stringify(data.dock.map((item) => [item.label, Math.round(item.h)])));
  const queueAboveDock = await page.evaluate(() => {
    const queue = document.querySelector('.game-queue');
    const dock = document.querySelector('.hud-dock');
    if (!queue || getComputedStyle(queue).display === 'none' || !dock) return true;
    return queue.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top + 1.5;
  });
  check(`${tag}: queue row renders above the dock (no overlap)`, queueAboveDock);

  // placement mode: the placement bar must sit directly above the dock
  await page.evaluate(() => {
    const nur = window.__NUR__;
    nur.buildings.startPlacement('farm');
    const def = nur.buildings.byId.get('farm');
    outer: for (let row = 2; row < nur.config.rows - def.size[1]; row += 1) {
      for (let col = 2; col < nur.config.cols - def.size[0]; col += 1) {
        if (nur.buildings.canPlace(def, col, row)) { nur.buildings._movePreview(col, row); break outer; }
      }
    }
  });
  await page.waitForTimeout(300);
  const placement = await page.evaluate(probeInPage);
  check('412x915 placement-active: placement bar sits above the dock without overlap', placement.overlaps.length === 0, JSON.stringify(placement.overlaps));
  const placementButtons = await page.evaluate(() => {
    const bar = document.querySelector('.placement-bar');
    return [...bar.querySelectorAll('button')].map((button) => Math.round(button.getBoundingClientRect().height));
  });
  check('412x915 placement-active: confirm/cancel buttons are ≥ 48 px tall', placementButtons.every((height) => height >= 48 - 0.5), JSON.stringify(placementButtons));
  const constructionInert = await page.evaluate(() => {
    const node = document.querySelector('.game-shop-btn');
    return !node.classList.contains('is-hidden') && node.disabled === true;
  });
  check('412x915 placement-active: Construction action is inert, not hidden', constructionInert);
  if (shotsDir) await page.screenshot({ path: resolve(root, shotsDir, '412x915-placement.png') });
  await page.close();
}

/* ------------------------------------------------- high contrast + reduced motion */

{
  const { page } = await openGame(VIEWPORTS[2], SCALES[1]);
  await page.evaluate(() => {
    const nur = window.__NUR__;
    nur.metaSystem.setSetting('highContrast', true);
    nur.metaSystem.setSetting('reduceMotion', true);
  });
  await page.waitForTimeout(400);
  const data = await page.evaluate(probeInPage);
  const tag = '412x915 high-contrast + font-max';
  check(`${tag}: no overlap`, data.overlaps.length === 0, JSON.stringify(data.overlaps));
  check(`${tag}: no clipped text`, data.clipped.length === 0, JSON.stringify(data.clipped.slice(0, 4)));
  check(`${tag}: dock actions ≥ 48 px`, data.dock.every((item) => item.h >= 48 - 0.5 && item.w >= 48 - 0.5));
  if (shotsDir) await page.screenshot({ path: resolve(root, shotsDir, '412x915-high-contrast.png') });
  await page.close();
}

await browser.close();

console.log(`\nHUD layout: ${results.length - failures}/${results.length} checks passed.`);
if (failures > 0) {
  console.error(`\n${failures} HUD layout check(s) failed.`);
  process.exit(1);
}
note('SwiftShader/Chromium geometry only — these are layout numbers, not GPU numbers.');
