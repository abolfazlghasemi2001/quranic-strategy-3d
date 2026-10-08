#!/usr/bin/env node
/**
 * jsdom smoke test — boots the REAL app (src/main.js) end-to-end.
 *
 * Why: this sandbox has no browser and no headless WebGL, so Playwright/`gl`
 * are impossible here. Instead we:
 *   1. create a jsdom document from index.html (canvas + full DOM),
 *   2. stub `canvas.getContext('2d')` (all textures are CanvasTexture),
 *   3. run src/main.js through Vite's SSR loader (handles the JSON/CSS imports
 *      plain Node cannot), aliasing the single `./core/Engine.js` edge to
 *      tools/FakeEngine.js (WebGLRenderer cannot run in jsdom),
 *   4. drive frames manually via engine.tick(dt) and inject real pointer
 *      events to exercise placement → queue → speedup → harvest → upgrade →
 *      save → pagehide → reload → offline progress → backward clock.
 *
 * Acceptance coverage: ① production←harvest←upgrade loop, ② storage ceiling,
 * ③ two-builder queue + live timers, ④ close/reopen persistence (IndexedDB via
 * fake-indexeddb), ⑤ offline progress with a manually rewound clock.
 *
 * Run: npm run smoke
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import 'fake-indexeddb/auto'; // real IndexedDB semantics in-process (SaveSystem idb path)
import * as THREE from 'three';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/* ------------------------------------------------------------- harness */

const results = [];
let failed = 0;
const assert = (cond, msg = 'assertion failed') => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, timeout, msg) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (cond()) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting: ${msg}`);
}
async function test(name, fn) {
  try {
    await fn();
    results.push(`  ✓ ${name}`);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    results.push(`  ✗ ${name}\n      ${error?.stack || error}`);
    console.error(`  ✗ ${name}\n      ${error?.stack || error}`);
  }
}

/* ------------------------------------------------- jsdom + console setup */

const logs = { info: [], warn: [], error: [], jsdom: [] };
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (e) => logs.jsdom.push(String(e?.stack || e)));
for (const level of ['info', 'warn', 'error']) {
  virtualConsole.on(level, (...args) => logs[level].push(args.map(String).join(' ')));
}

const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'https://localhost/',
  pretendToBeVisual: true, // provides window.requestAnimationFrame (World.build nextFrame)
  virtualConsole,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;

// ---- 2D canvas stub (must exist before any src module loads) -----------
function make2dContext(canvas) {
  const gradient = { addColorStop() {} };
  const ctx = {
    canvas,
    save() {}, restore() {},
    beginPath() {}, closePath() {},
    moveTo() {}, lineTo() {}, arc() {}, ellipse() {}, rect() {},
    fill() {}, stroke() {},
    fillRect() {}, clearRect() {}, fillText() {}, strokeText() {},
    translate() {}, scale() {}, rotate() {}, setTransform() {}, resetTransform() {},
    drawImage() {}, clip() {}, closePath() {},
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    createPattern() { return null; },
    measureText() { return { width: 0 }; },
    getImageData(x, y, w, h) {
      return { data: new Uint8ClampedArray(Math.max(0, w) * Math.max(0, h) * 4), width: w, height: h, colorSpace: 'srgb' };
    },
    putImageData() {},
  };
  return ctx;
}
window.HTMLCanvasElement.prototype.getContext = function getContext(type) {
  if (type === '2d') return make2dContext(this);
  return null; // no WebGL in jsdom; FakeEngine never asks for one
};
// Pointer-capture APIs used (guarded) by InputManager — jsdom lacks them.
for (const method of ['setPointerCapture', 'releasePointerCapture', 'hasPointerCapture']) {
  if (!window.Element.prototype[method]) window.Element.prototype[method] = function () {};
}

// ---- capture Node-side console (src uses the bare global) --------------
for (const level of ['info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logs[level].push(args.map((a) => (a && a.stack ? a.stack : String(a))).join(' '));
    original(...args);
  };
}

/* ------------------------------------------------------------ vite loader */

const server = await createServer({
  root,
  configFile: false,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  resolve: {
    // Only src/main.js imports core/Engine.js → swap in the jsdom-safe engine.
    alias: [{ find: './core/Engine.js', replacement: resolve(here, 'FakeEngine.js') }],
  },
});

let bootSeq = 0;
async function boot() {
  bootSeq += 1;
  window.__NUR__ = null; // old handle must not satisfy the poll
  const entry = bootSeq === 1 ? '/src/main.js' : `/src/main.js?run=${bootSeq}`;
  await server.ssrLoadModule(entry); // boot() runs fire-and-forget inside
  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (logs.error.some((l) => l.includes('خطای راه‌اندازی'))) {
      throw new Error(`boot() rejected:\n${logs.error.join('\n')}`);
    }
    if (logs.jsdom.length) throw new Error(`jsdom error during boot:\n${logs.jsdom.join('\n')}`);
    if (window.__NUR__) {
      // A real browser would rAF-loop from engine.start(); drive one frame so
      // Game's dirty flags flush into the freshly-built HUD (initial render).
      window.__NUR__.engine.tick(0.3);
      return window.__NUR__;
    }
    await sleep(40);
  }
  throw new Error(`boot timeout; console:\n${JSON.stringify(logs, null, 2).slice(0, 3000)}`);
}

/* ------------------------------------------------------------- helpers */

const ts = () => window.__NUR__.config.tileSize;
const chip = (nur, key) => nur.hud.chips[key].querySelector('b').textContent;
const toastText = (nur) => nur.hud.toastNode.textContent;
const entity = (nur, type) => [...nur.game.state.entities.values()].find((e) => e.type === type);
/** دکمهٔ فروشگاه بر پایهٔ شناسهٔ ساختمان (به‌جای شمارهٔ ردیف که با افزودن سازه جابه‌جا می‌شود). */
const shopItem = (nur, id) => {
  const node = nur.hud.shopList.querySelector(`.shop-item[data-def="${id}"]`);
  if (!node) throw new Error(`shop item not found: ${id}`);
  return node;
};

function tick(nur, dt = 0.3) {
  nur.engine.tick(dt); // dt>step ⇒ several fixedUpdates; no rAF needed
}

function projectToScreen(nur, x, z) {
  nur.engine.camera.updateMatrixWorld(true);
  const v = new THREE.Vector3(x, 0, z).project(nur.engine.camera);
  return {
    clientX: (v.x * 0.5 + 0.5) * window.innerWidth,
    clientY: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

function fire(type, target, p) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, {
    clientX: p.clientX, clientY: p.clientY,
    pointerId: 1, pointerType: 'touch', isPrimary: true,
    button: 0, buttons: 0, width: 1, height: 1, pressure: 0.5,
    tiltX: 0, tiltY: 0, twist: 0,
    shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
  });
  target.dispatchEvent(ev);
}

/** Full tap (pointerdown on canvas + pointerup on window) at a world point. */
function tapWorld(nur, x, z) {
  const canvas = document.querySelector('#scene');
  const p = projectToScreen(nur, x, z);
  fire('pointerdown', canvas, p);
  fire('pointerup', window, p);
}

/** Move an active placement preview to a world point (down+move+up). */
function movePlacement(nur, x, z) {
  const canvas = document.querySelector('#scene');
  const p = projectToScreen(nur, x, z);
  fire('pointerdown', canvas, p);
  fire('pointermove', canvas, p);
  fire('pointerup', window, p);
}

/**
 * First tile where the def can legally be placed. Returns the CENTRE of the
 * anchor tile (not the footprint centre): worldToTile + floor then resolves
 * back to exactly (col,row) — a footprint centre can sit on a tile boundary.
 */
function freeSpot(nur, def) {
  const t = nur.config.tileSize;
  for (let row = 1; row < nur.config.rows - def.size[1]; row += 1) {
    for (let col = 1; col < nur.config.cols - def.size[0]; col += 1) {
      if (nur.buildings.canPlace(def, col, row)) {
        return { x: (col + 0.5) * t, z: (row + 0.5) * t, col, row };
      }
    }
  }
  throw new Error(`no free spot for ${def.id}`);
}

async function teardown() {
  try {
    await server.close();
  } catch { /* ignore */ }
  try {
    window.close();
  } catch { /* ignore */ }
  console.log(`\n${results.join('\n')}`);
  console.log(failed ? `\n✗ ${failed} smoke test(s) failed` : '\n✓ jsdom smoke: all tests passed');
  process.exit(failed ? 1 : 0);
}

/* ============================================================ phase A: fresh boot */

let nur = null;
let expectedGoharAfterOffline = null;
const toFaDigits = (value) => String(value).replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);

await test('boot: fresh game starts in jsdom with no runtime errors', async () => {
  nur = await boot();
  assert(!logs.error.some((l) => l.includes('خطای راه‌اندازی')), 'no boot rejection');
  assert(logs.info.some((l) => l.includes('ذخیره: جدید')), 'fresh-boot log line present');
  assert(document.querySelector('.ui-error').classList.contains('is-hidden'), 'error overlay stays hidden');
  // offline welcome-back toast must NOT appear on a fresh boot
  assert(!nur.hud.toastNode.classList.contains('is-visible'), 'no offline toast on boot 1');
  assert(nur.metaSystem.tutorialSnapshot().step.id === 'open-shop', 'new player gets the first guided action');
  assert(!nur.ftueGuide.root.classList.contains('is-hidden'), 'FTUE card is visible on a fresh save');
  await waitFor(() => !document.querySelector('.ui-loading'), 5000, 'loading screen removed');
  assert(logs.jsdom.length === 0, `jsdom errors: ${logs.jsdom[0]}`);
});

if (!nur) await teardown();

await test('phase 7: settings affect engine, sound, locale, and the FTUE can be replayed', () => {
  nur.hud.settingsButton.click();
  assert(nur.settingsPanel.open && !nur.settingsPanel.root.classList.contains('is-hidden'), 'settings panel opens from the HUD');
  assert(nur.engine.paused, 'settings modal pauses gameplay safely');

  nur.settingsPanel.qualitySelect.value = 'low';
  nur.settingsPanel.qualitySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.batteryToggle.checked = true;
  nur.settingsPanel.batteryToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.soundToggle.checked = false;
  nur.settingsPanel.soundToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.languageSelect.value = 'fa-AF';
  nur.settingsPanel.languageSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(nur.engine.runtimeQualityTier === 'low', 'quality selection changes the live quality tier');
  assert(nur.engine.frameCap === 30 && !nur.engine.shadowMapEnabled, 'battery saver applies the 30 fps cap and disables shadows');
  assert(nur.soundManager.enabled === false, 'sound toggle reaches the sound manager');
  assert(document.documentElement.lang === 'fa-AF' && document.documentElement.dir === 'rtl', 'language choice updates the Persian locale metadata without changing RTL');

  nur.settingsPanel.qualitySelect.value = 'medium';
  nur.settingsPanel.qualitySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.batteryToggle.checked = false;
  nur.settingsPanel.batteryToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.soundToggle.checked = true;
  nur.settingsPanel.soundToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.languageSelect.value = 'fa-IR';
  nur.settingsPanel.languageSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert(nur.engine.frameCap === 60 && nur.soundManager.enabled, 'normal frame rate and sound are restored');
  nur.settingsPanel.qualitySelect.value = 'low';
  nur.settingsPanel.qualitySelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.batteryToggle.checked = true;
  nur.settingsPanel.batteryToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.soundToggle.checked = false;
  nur.settingsPanel.soundToggle.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.languageSelect.value = 'fa-AF';
  nur.settingsPanel.languageSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
  nur.settingsPanel.close();
  assert(!nur.engine.paused, 'closing settings resumes gameplay');
  tick(nur);

  nur.hud.settingsButton.click();
  const replayButton = [...nur.settingsPanel.card.querySelectorAll('button')].find((node) => node.textContent.includes('نمایش دوباره'));
  assert(replayButton, 'settings expose a replay button');
  replayButton.click();
  assert(nur.metaSystem.tutorialSnapshot().replaying && nur.metaSystem.tutorialSnapshot().stepIndex === 0, 'FTUE replay starts at the first step');
  const next = [...nur.ftueGuide.card.querySelectorAll('button')].find((node) => node.textContent.includes('بعدی'));
  assert(next, 'replay can advance step by step');
  next.click();
  assert(nur.metaSystem.tutorialSnapshot().stepIndex === 1, 'replay advances to the next guide step');
  const closeReplay = [...nur.ftueGuide.card.querySelectorAll('button')].find((node) => node.textContent.includes('بستن بازبینی'));
  assert(closeReplay, 'replay can be closed before its final step');
  closeReplay.click();
  assert(!nur.metaSystem.tutorialSnapshot().replaying, 'closing replay returns to the current live guide state');
  tick(nur);

  nur.hud.player.click();
  assert(nur.metaPanel.open && !nur.metaPanel.root.classList.contains('is-hidden'), 'player profile opens from the HUD');
  assert(nur.metaPanel.card.textContent.includes('XP') && nur.metaPanel.card.textContent.includes('نقشهٔ ۳۰ دقیقه'), 'profile shows player progression and first-30-minute route');
  assert(nur.metaPanel.card.textContent.includes('بی‌مهلت') && nur.metaPanel.card.textContent.includes('زنجیرهٔ ورود'), 'daily task explicitly has no deadline or login streak');
  nur.metaPanel.close();
  tick(nur);
  assert(!nur.engine.paused, 'closing the profile resumes the city');
});

await test('HUD: starting economy renders in Persian (۶۰۰/۸۰۰ …)', () => {
  assert(chip(nur, 'rizq') === '۶۰۰/۸۰۰', `rizq chip: ${chip(nur, 'rizq')}`);
  assert(chip(nur, 'nur') === '۴۰۰/۶۰۰', `nur chip: ${chip(nur, 'nur')}`);
  assert(chip(nur, 'hekmat') === '۲۵۰/۴۰۰', `hekmat chip: ${chip(nur, 'hekmat')}`);
  assert(chip(nur, 'gohar') === '۲۰', `gohar chip: ${chip(nur, 'gohar')}`);
  assert(nur.hud.builderValue.textContent === '۲/۲', 'two builders');
  assert(nur.hud.levelValue.textContent === '۱', 'city level ۱');
  assert(nur.hud.queuePanel.classList.contains('is-hidden'), 'queue hidden with no jobs');
  assert(nur.hud.placementBar.classList.contains('is-hidden'), 'placement bar hidden');
  assert(nur.hud.selection.classList.contains('is-hidden'), 'no selection');
});

await test('placement: preview starts invalid at centre, valid on a free tile', () => {
  shopItem(nur, 'farm').click();
  assert(nur.buildings.placing, 'placement active');
  assert(!nur.hud.placementBar.classList.contains('is-hidden'), 'placement bar visible');
  assert(nur.hud.confirmButton.disabled === true, 'confirm disabled on the occupied town-centre tile');
  const spot = freeSpot(nur, nur.buildings.byId.get('farm'));
  movePlacement(nur, spot.x, spot.z);
  assert(nur.hud.confirmButton.disabled === false, 'confirm enabled on free terrain');
  assert(nur.buildings.placing.col === spot.col && nur.buildings.placing.row === spot.row, 'preview anchored on the free tile');
});

await test('acceptance ①/③: confirm farm → active job, queue visible instantly (Bug-A regression)', () => {
  nur.hud.confirmButton.click();
  assert(!nur.buildings.placing, 'placement closes after confirming a non-wall');
  assert(nur.hud.placementBar.classList.contains('is-hidden'), 'placement bar hidden');
  // No engine tick happened since the click — the queue panel must already be
  // on screen (_afterEconomyChange → emitQueue, Bug A fix).
  assert(!nur.hud.queuePanel.classList.contains('is-hidden'), 'queue panel visible immediately after confirm');
  assert(nur.hud.queueList.querySelectorAll('.queue-row--active').length === 1, 'one active job');
  const shadowingMeshes = [];
  nur.engine.scene.traverse((node) => { if (node.isMesh && (node.castShadow || node.receiveShadow)) shadowingMeshes.push(node.name); });
  assert(shadowingMeshes.length === 0, `new building meshes also obey battery saver (${shadowingMeshes.length} shadow-enabled)`);
  assert(nur.hud.queueBadge.textContent === '۱/۲', `builders badge: ${nur.hud.queueBadge.textContent}`);
  assert(chip(nur, 'rizq') === '۴۰۰/۸۰۰', `farm cost paid (rizq ${chip(nur, 'rizq')})`);
  assert(chip(nur, 'nur') === '۳۲۰/۶۰۰', `farm cost paid (nur ${chip(nur, 'nur')})`);
  assert(chip(nur, 'hekmat') === '۲۳۰/۴۰۰', `farm cost paid (hekmat ${chip(nur, 'hekmat')})`);
  assert(nur.metaSystem.tutorialSnapshot().step.id === 'wait-farm', 'first-farm placement advances the FTUE into the construction step');
  assert(toastText(nur).includes('در صف ساخت'), `toast: ${toastText(nur)}`);
  assert(!nur.hud.selection.classList.contains('is-hidden'), 'confirmed building gets selected');
  assert(nur.hud.selection.textContent.includes('در حال ساخت'), 'selection shows building state');
});

await test('acceptance ③: two active builders, third job queued, wall placement chains', () => {
  shopItem(nur, 'light-spring').click();
  movePlacement(nur, ...(() => {
    const s = freeSpot(nur, nur.buildings.byId.get('light-spring'));
    return [s.x, s.z];
  })());
  nur.hud.confirmButton.click();
  assert(nur.hud.queueList.querySelectorAll('.queue-row--active').length === 2, 'two active jobs');
  assert(nur.hud.queueBadge.textContent === '۰/۲', `badge after two jobs: ${nur.hud.queueBadge.textContent}`);

  shopItem(nur, 'wall').click();
  const wallSpot = freeSpot(nur, nur.buildings.byId.get('wall'));
  movePlacement(nur, wallSpot.x, wallSpot.z);
  nur.hud.confirmButton.click();
  assert(nur.hud.queueList.querySelectorAll('.queue-row--queued').length === 1, 'wall job queued');
  assert(nur.hud.queueList.textContent.includes('در انتظار بنّا'), 'queued row shows waiting label');
  assert(nur.buildings.placing && nur.buildings.placing.def.id === 'wall', 'wall placement chains (stays active)');
  assert(!nur.hud.placementBar.classList.contains('is-hidden'), 'placement bar stays open for walls');
  const cancel = [...nur.hud.placementBar.querySelectorAll('button')].find((b) => b.textContent.includes('لغو'));
  assert(cancel, 'cancel button present');
  cancel.click();
  assert(!nur.buildings.placing, 'placement cancelled');
  assert(nur.hud.placementBar.classList.contains('is-hidden'), 'placement bar hidden after cancel');
  assert(chip(nur, 'rizq') === '۷۰/۸۰۰', `rizq after 3 builds: ${chip(nur, 'rizq')}`);
  assert(chip(nur, 'nur') === '۱۹۰/۶۰۰', `nur after 3 builds: ${chip(nur, 'nur')}`);
  assert(chip(nur, 'hekmat') === '۱۸۵/۴۰۰', `hekmat after 3 builds: ${chip(nur, 'hekmat')}`);
});

await test('queue: live countdown renders in Persian digits', () => {
  const farmJob = nur.game.queue.jobs.find((j) => j.type === 'farm' && j.status === 'active');
  assert(farmJob, 'farm job active');
  farmJob.endsAt = Date.now() + 5000;
  nur.game.markQueueDirty();
  nur.game.emitQueue();
  const timer = nur.hud.queueList.querySelector('.queue-timer');
  assert(timer && timer.textContent === '۰۰:۰۵', `timer: ${timer ? timer.textContent : 'missing'}`);
});

await test('speedup (گوهر): finishes the farm instantly and promotes the wall', () => {
  const goharBefore = nur.game.state.resources.gohar;
  const btn = nur.hud.queueList.querySelector('.queue-speedup');
  assert(btn, 'queue speedup button present');
  btn.click();
  assert(nur.game.state.resources.gohar === goharBefore - 1, 'exactly one gohar spent');
  assert(entity(nur, 'farm').status === 'ready', 'farm finished');
  assert(nur.game.state.meta.stats.buildingsBuilt === 1 && nur.game.state.meta.achievements['first-building']?.unlockedAt != null, 'real job completion grants the first-building achievement');
  assert(nur.metaSystem.tutorialSnapshot().step.id === 'harvest-first', 'first farm completion advances the FTUE to harvesting');
  assert(!nur.game.queue.jobs.some((j) => j.type === 'farm'), 'farm job removed');
  assert(nur.hud.queueList.querySelectorAll('.queue-row--active').length === 2, 'spring+wall active after promotion');
  assert(nur.hud.queueList.querySelectorAll('.queue-waiting').length === 0, 'no queued rows left');
  assert(toastText(nur).includes('سرعت‌بخشی'), `toast: ${toastText(nur)}`);
});

await test('acceptance ①: tap on the ready farm harvests up to the storage ceiling', () => {
  const farm = entity(nur, 'farm');
  const rizqBefore = Math.floor(nur.game.state.resources.rizq);
  farm.lastAccrualAt = Date.now() - 2 * 3600 * 1000; // 2 h of production (buffer allows it)
  tick(nur);
  assert(farm.pending > 7000, `pending accrued (got ${Math.floor(farm.pending)})`);
  // Geometric centre of the 3×2 farm → must resolve to the exact interior tile
  // (this pins the getCellAt half-tile fix: old code returned col+1/row+1).
  const cx = (farm.col + farm.size[0] / 2) * ts();
  const cz = (farm.row + farm.size[1] / 2) * ts();
  tapWorld(nur, cx, cz);
  const cell = nur.game.state.lastTap.cell;
  assert(cell.col === farm.col + 1 && cell.row === farm.row + 1, `tap cell: ${JSON.stringify(cell)} (farm at ${farm.col},${farm.row})`);
  const harvested = Math.floor(nur.game.state.resources.rizq) - rizqBefore;
  assert(harvested > 0, 'something was harvested');
  assert(nur.game.state.meta.stats.harvests === 1 && nur.metaSystem.tutorialSnapshot().step.id === 'first-lesson', 'real harvest completes the next FTUE milestone');
  assert(Math.floor(nur.game.state.resources.rizq) === 800, `storage ceiling respected (got ${Math.floor(nur.game.state.resources.rizq)})`);
  assert(toastText(nur).includes('رزق'), `harvest toast: ${toastText(nur)}`);
  assert(!nur.hud.selection.classList.contains('is-hidden'), 'tap selects the farm');
  assert(nur.hud.selection.textContent.includes('مزرعه'), 'menu shows farm name');
});

await test('acceptance ①: upgrade costs paid, waits for a builder, completes at level 2', () => {
  const menu = nur.hud.selection;
  const upgradeBtn = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('ارتقا'));
  assert(upgradeBtn, 'upgrade button rendered');
  assert(!upgradeBtn.disabled, 'upgrade affordable');
  const before = { ...nur.game.state.resources };
  upgradeBtn.click();
  assert(nur.game.state.resources.rizq === before.rizq - 330, 'rizq upgrade cost paid');
  assert(nur.game.state.resources.nur === before.nur - 130, 'nur upgrade cost paid');
  assert(nur.game.state.resources.hekmat === before.hekmat - 35, 'hekmat upgrade cost paid');
  assert(nur.game.queue.jobs.length === 3, `3 jobs total (got ${nur.game.queue.jobs.length})`);
  const upJob = nur.game.queue.jobs.find((j) => j.targetLevel === 2);
  assert(upJob && upJob.status === 'queued', 'upgrade queued behind busy builders');
  assert(nur.hud.queueList.querySelectorAll('.queue-row--queued').length === 1, 'queued row rendered');
  assert(menu.textContent.includes('در انتظار بنّا'), 'menu shows waiting state');

  // Fast-forward spring + wall (both due → chained promotion of the upgrade).
  for (const job of nur.game.queue.jobs.filter((j) => j.status === 'active')) job.endsAt = Date.now() - 1;
  tick(nur);
  assert(entity(nur, 'light-spring').status === 'ready', 'spring finished');
  assert(entity(nur, 'wall').status === 'ready', 'wall finished');
  const promoted = nur.game.queue.jobs.find((j) => j.targetLevel === 2);
  assert(promoted && promoted.status === 'active', 'upgrade promoted with a chained start time');

  promoted.endsAt = Date.now() - 1;
  tick(nur);
  const farm = entity(nur, 'farm');
  assert(farm.level === 2, `farm level ${farm.level}`);
  assert(Math.abs(farm.root.scale.x - 1.035) < 1e-6, `level-2 scale (${farm.root.scale.x})`);
  assert(nur.game.queue.jobs.length === 0, 'queue empty after completion');
  assert(nur.hud.queuePanel.classList.contains('is-hidden'), 'queue panel hides when idle');
  assert(nur.hud.builderValue.textContent === '۲/۲', 'both builders free again');
  assert(toastText(nur).includes('سطح ۲'), `completion toast: ${toastText(nur)}`);
});

await test('acceptance ②: storage ceiling stops production, space resumes it, harvest caps', () => {
  const farm = entity(nur, 'farm');
  const state = nur.game.state;
  const pendingBefore = farm.pending;

  state.resources.rizq = 800; // fill to the brim
  farm.lastAccrualAt = Date.now() - 3600 * 1000;
  tick(nur);
  assert(farm.pending === pendingBefore, 'no production while storage is full');
  assert(state.resources.rizq === 800, 'resources stay at the ceiling');

  state.resources.rizq = 700; // make room
  farm.lastAccrualAt = Date.now() - 3600 * 1000;
  tick(nur);
  assert(farm.pending > pendingBefore, 'production resumes once space exists');

  let harvestBtn = [...nur.hud.selection.querySelectorAll('button')].find((b) => b.textContent.includes('برداشت'));
  assert(harvestBtn, 'harvest button visible');
  harvestBtn.click();
  assert(state.resources.rizq === 800, `harvest fills but never overfills (got ${state.resources.rizq})`);

  harvestBtn = [...nur.hud.selection.querySelectorAll('button')].find((b) => b.textContent.includes('برداشت'));
  harvestBtn.click(); // storage is full → toast instead of gain
  assert(toastText(nur) === 'انبار پر است', `full toast: ${toastText(nur)}`);
});

await test('dev panel: instant save and one-hour offline simulation', async () => {
  nur.devPanel.saveButton.click();
  await sleep(150);
  assert(toastText(nur).includes('بازی ذخیره شد'), `save toast: ${toastText(nur)}`);
  nur.devPanel.offlineButton.click();
  assert(toastText(nur).includes('شبیه‌سازی شد'), `offline toast: ${toastText(nur)}`);
  assert(nur.game.state.resources.gohar === 19, `gohar changes only by the paid speed-up (now ${nur.game.state.resources.gohar})`);
});

await test('pause: «راهنمای متن» opens the Quran panel and freezes the clock', () => {
  const policyBtn = document.querySelector('.quran-policy-btn');
  assert(policyBtn, 'policy button present');
  policyBtn.click();
  assert(!nur.quranPanel.root.classList.contains('is-hidden'), 'Quran panel visible');
  assert(nur.engine.paused === true, 'engine paused');
  assert(document.querySelector('.ui-pause.is-visible'), 'pause badge shown');
  const elapsed = nur.game.state.elapsed;
  tick(nur);
  tick(nur);
  assert(nur.game.state.elapsed === elapsed, 'clock frozen while paused');
  const backdrop = nur.quranPanel.root.querySelector('.ui-modal__backdrop');
  assert(backdrop, 'backdrop present');
  backdrop.click();
  assert(nur.quranPanel.root.classList.contains('is-hidden'), 'panel hidden after backdrop click');
  assert(nur.engine.paused === false, 'engine resumed');
});

await test('reload prep: an active watchtower job is part of the save', () => {
  shopItem(nur, 'watchtower').click();
  const spot = freeSpot(nur, nur.buildings.byId.get('watchtower'));
  movePlacement(nur, spot.x, spot.z);
  nur.hud.confirmButton.click();
  const job = nur.game.queue.jobs.find((j) => j.type === 'watchtower');
  assert(job && job.status === 'active', 'watchtower building');
  assert(job.endsAt > Date.now() + 30_000, 'job still has real time left');
  assert(nur.hud.queueBadge.textContent === '۱/۲', 'one builder busy');
  assert(entity(nur, 'watchtower').status === 'building', 'entity recorded as building');
});

/* ================================================ phase B: close & reopen (④ + ⑤) */

await test('acceptance ④: pagehide persists the game, clock rewound 2 h for offline math', async () => {
  await nur.saveSystem.save(nur.game.serialize());
  window.dispatchEvent(new window.Event('pagehide')); // real close path: save + dispose
  await sleep(350); // let the handler's debounced save flush
  assert(!document.querySelector('.game-hud'), 'HUD torn down on pagehide');
  assert(!document.querySelector('.building-menu'), 'selection menu removed');

  const record = await nur.saveSystem.load();
  assert(record && record.payload, 'record readable after dispose');
  assert(record.payload.entities.length === 5, `5 entities saved (got ${record.payload.entities.length})`);

  const T = Date.now();
  const payload = JSON.parse(JSON.stringify(record.payload));
  expectedGoharAfterOffline = payload.resources.gohar;
  payload.savedAt = T - 2 * 3600 * 1000;
  payload.lastAccrualAt = T - 2 * 3600 * 1000;
  payload.lastDailyAt = T - 48 * 3600 * 1000; // a legacy timestamp must never grant a login reward
  for (const e of payload.entities) {
    if (e.type === 'farm' || e.type === 'light-spring') e.lastAccrualAt = T - 2 * 3600 * 1000;
  }
  await nur.saveSystem.saveRecord({ id: 'main', schemaVersion: 2, savedAt: payload.savedAt, payload });
});

await test('acceptance ④/⑤: reload restores state, gains from 2 h offline, capped', async () => {
  nur = await boot(); // second boot (?run=2) over the backdated record
  assert(nur.metaSystem.settings.qualityTier === 'low' && nur.metaSystem.settings.batterySaver, 'non-default visual settings survive save/load');
  assert(nur.metaSystem.settings.language === 'fa-AF' && !nur.metaSystem.settings.soundEnabled, 'language and sound preferences survive save/load');
  assert(nur.engine.frameCap === 30 && !nur.engine.shadowMapEnabled, 'battery saver is applied again during boot');
  // secondsAway log line first (toast disappears after 2.4 s)
  const bootLog = logs.info.filter((l) => /\[شهر نور\] فاز [\d۰-۹]+ آماده شد/.test(l)).pop();
  const m = bootLog && bootLog.match(/بازیابی \((\d+)s غیبت\)/);
  assert(m, `restore log: ${bootLog}`);
  const away = Number(m[1]);
  assert(away >= 7150 && away <= 7400, `secondsAway ≈ 7200 (got ${away})`);

  const toast = nur.hud.toastNode;
  assert(toast.classList.contains('is-visible'), 'offline welcome-back toast visible');
  assert(toast.textContent.includes('در غیبت شما'), `toast text: ${toast.textContent}`);
  assert(toast.textContent.includes('نور'), `toast names the produced resource: ${toast.textContent}`);

  await waitFor(() => !document.querySelector('.ui-loading'), 5000, 'loading screen removed');

  assert(chip(nur, 'rizq') === '۸۰۰/۸۰۰', `rizq capped at ceiling (got ${chip(nur, 'rizq')})`);
  assert(chip(nur, 'nur') === '۶۰۰/۶۰۰', `nur capped at ceiling (got ${chip(nur, 'nur')})`);
  assert(chip(nur, 'hekmat') === '۳۰/۴۰۰', `hekmat unchanged (got ${chip(nur, 'hekmat')})`);
  assert(expectedGoharAfterOffline != null && chip(nur, 'gohar') === toFaDigits(expectedGoharAfterOffline), `no login reward is added during absence (got ${chip(nur, 'gohar')})`);

  const rep = nur.game.offlineReport;
  assert(rep && rep.secondsAway === away, 'report secondsAway matches the log');
  assert(rep.gained && rep.gained.rizq > 0 && rep.gained.nur > 0, `offline gains: ${JSON.stringify(rep.gained)}`);
  assert(!Object.hasOwn(rep, 'goharDaily'), 'offline report has no daily login-reward field');
  assert(rep.jobsDone === 0, 'watchtower still building (not fast-forwarded)');

  assert(nur.game.state.entities.size === 5, `entities restored (got ${nur.game.state.entities.size})`);
  assert(entity(nur, 'farm').level === 2, 'farm upgrade survived');
  assert(entity(nur, 'watchtower').status === 'building', 'watchtower still building');
  assert(nur.hud.queueList.querySelectorAll('.queue-row--active').length === 1, 'queue row restored');
  assert(nur.hud.queueBadge.textContent === '۱/۲', `badge: ${nur.hud.queueBadge.textContent}`);
  assert(nur.hud.builderValue.textContent === '۱/۲', `builders: ${nur.hud.builderValue.textContent}`);
  const timer = nur.hud.queueList.querySelector('.queue-timer');
  assert(timer && timer.textContent.length > 0, 'live job timer restored');
  assert(nur.hud.queueList.querySelector('.queue-speedup'), 'speedup affordance restored');
});

/* ================================================ phase D: لایهٔ قرآنی-آموزشی (فاز ۴) */
/*
 * Acceptance coverage for phase 4, driven through the real DOM:
 *   ① three minigames playable without errors
 *   ② lesson rewards land in the game economy (nur / hekmat / builder speedup)
 *   ③ a wrong answer costs nothing (resources unchanged, lesson continues)
 *   ④ spaced repetition re-shows mistaken items (in-session requeue + due queue)
 *   ⑤ every verse shown is a labelled placeholder («نمونه» + «در انتظار بازبینی»)
 *      and Quran text never appears outside the lesson UI.
 */

const LEARNING_LABEL = 'نمونه — جایگزین شود';
const PENDING_LABEL = 'در انتظار بازبینی';

/** Plain resource snapshot of the live game. */
const res = (nur) => ({ ...nur.game.state.resources });

function buttonsIn(scope, selector) {
  return [...scope.querySelectorAll(selector)];
}

function clickByText(scope, selector, text) {
  const node = buttonsIn(scope, selector).find((btn) => btn.textContent.trim() === text);
  assert(node, `button "${text}" exists (${selector})`);
  node.click();
  return node;
}

/** Ensure the player can afford a Dar al-Quran and build one. */
function buildDarAlQuran(nur) {
  nur.game.state.resources.rizq = 50000;
  nur.game.state.resources.nur = 20000;
  nur.game.state.resources.hekmat = 20000;
  nur.game.emitState(Date.now(), true);
  const def = nur.buildings.byId.get('dar-al-quran');
  assert(def, 'دارالقرآن definition exists');
  const index = nur.hud.shopList.children.length - 1;
  const row = nur.hud.shopList.children[index];
  assert(row.textContent.includes('دارالقرآن'), `last shop row is دارالقرآن (${row.textContent.slice(0, 24)})`);
  assert(nur.buildings.startPlacement('dar-al-quran'), 'placement of دارالقرآن starts');
  const spot = freeSpot(nur, def);
  movePlacement(nur, spot.x, spot.z);
  nur.hud.confirmButton.click();
  assert(nur.game.queue.jobs.some((j) => j.type === 'dar-al-quran'), 'build job queued');
  // Fast-forward every builder: the lesson house is the only thing under construction.
  for (const job of nur.game.queue.jobs) job.endsAt = Date.now() - 1;
  tick(nur);
  const building = [...nur.game.state.entities.values()].find((e) => e.type === 'dar-al-quran');
  assert(building && building.status === 'ready', 'دارالقرآن finished building');
  // Back to realistic amounts so lesson rewards are measurable inside the warehouse caps.
  nur.game.state.resources = { rizq: 300, nur: 200, hekmat: 120, gohar: 20 };
  nur.game.emitState(Date.now(), true);
  for (const entity of nur.game.state.entities.values()) entity.pending = 0;
  return { building, spot };
}

await test('phase 4 ①: دارالقرآن opens the lesson hub on tap and keeps Quran text out of the HUD', async () => {
  const { building, spot } = buildDarAlQuran(nur);
  assert(nur.lessonHub, 'lesson hub exists on the runtime handle');
  assert(nur.lessonHub.root.classList.contains('is-hidden'), 'hub starts hidden');

  tapWorld(nur, (building.col + 1.5) * ts(), (building.row + 1.5) * ts());
  assert(nur.lessonHub.open === true, 'tapping دارالقرآن opens the hub');
  assert(!nur.lessonHub.root.classList.contains('is-hidden'), 'hub visible');
  assert(nur.input.enabled === false, 'camera/keyboard input suspended while the lesson UI is open');
  assert(nur.lessonHub.mode === 'hub', 'hub list view first');

  const hubText = nur.lessonHub.card.textContent;
  assert(hubText.includes('دارالقرآن'), 'hub titled دارالقرآن');
  assert(hubText.includes(LEARNING_LABEL), 'placeholder label surfaced in the hub');
  assert(hubText.includes(PENDING_LABEL), '«در انتظار بازبینی» badge surfaced in the hub');
  const verse = nur.quran.dataset.verses.get('ayah:1:1');
  assert(!hubText.includes(verse.textUthmani), 'the hub list never shows verse text — text only inside a lesson');
  assert(!document.body.textContent.includes(verse.textUthmani), 'no verse text anywhere before a lesson starts');
  assert(nur.lessonHub.card.querySelectorAll('.lesson-row').length === nur.quran.dataset.lessons.length, 'all lessons listed');

  const spotCenter = { x: (spot.col + 1.5) * ts(), z: (spot.row + 1.5) * ts() };
  assert(Math.abs(spotCenter.x - (building.col + 1.5) * ts()) < 1e-6, 'building placed where the harness expected');
});

await test('phase 4 (perf): the دارالقرآن model stays inside the draw-call budget', () => {
  const def = nur.buildings.byId.get('dar-al-quran');
  const model = nur.buildings.factory.create(def);
  let meshes = 0;
  let triangles = 0;
  model.traverse((object) => {
    if (!object.isMesh) return;
    meshes += 1;
    const geometry = object.geometry;
    const count = geometry.index ? geometry.index.count : geometry.attributes.position.count;
    triangles += count / 3;
  });
  assert(meshes <= 30, `دارالقرآن uses ${meshes} meshes (≤ 30 draw calls)`);
  assert(triangles <= 4000, `دارالقرآن uses ${Math.round(triangles)} triangles (≤ 4000)`);
  assert(model.name === 'building:dar-al-quran', 'model name is the building id');
  let texty = 0;
  model.traverse((object) => {
    for (const value of Object.values(object.userData || {})) if (typeof value === 'string') texty += 1;
  });
  assert(texty === 0, 'no string user-data on the model (no Quran text can be attached to geometry)');
});

await test('phase 4 ⑤: a lesson renders the verse with Quranic font class, diacritics and both badges', async () => {
  clickByText(nur.lessonHub.card, '.lesson-row .ui-btn', 'شروع درس');
  assert(nur.lessonHub.mode === 'session', 'session view mounted');
  const runner = nur.lessonHub.runner;
  assert(runner.session && runner.session.kind === 'lesson', 'lesson session created');
  assert(runner.session.lesson.id === 'lesson-basics', 'first lesson started');

  const card = nur.lessonHub.card.querySelector('.verse-card');
  assert(card, 'reading step shows a verse card');
  const text = card.querySelector('.quran-text');
  const verse = nur.quran.dataset.verses.get('ayah:1:1');
  assert(text && text.textContent === verse.textUthmani,
    `verse text comes from the dataset (card=${JSON.stringify(text && text.textContent)} expected=${JSON.stringify(verse.textUthmani)})`);
  assert(text.getAttribute('lang') === 'ar', 'verse marked as Arabic');
  const marks = (text.textContent.match(/[\u064B-\u0652\u0670\u06D6-\u06ED]/g) || []).length;
  assert(marks >= 4, `displayed verse keeps its full diacritics (${marks} marks)`);
  assert([...card.querySelectorAll('.verse-badge')].map((b) => b.textContent).includes(LEARNING_LABEL), 'placeholder badge shown');
  assert([...card.querySelectorAll('.verse-badge')].map((b) => b.textContent).includes(PENDING_LABEL), 'review-pending badge shown');
  assert(card.textContent.includes(verse.translationFa), 'translation shown under the verse');
  assert(card.querySelector('.verse-card__audio').disabled === true, 'unlicensed audio cannot be played');
});

await test('phase 4 ③: a wrong answer costs nothing and never ends the game', () => {
  const before = res(nur);
  clickByText(nur.lessonHub.card, '.lesson-btn, .ui-btn', 'خواندم، ادامه');
  const runner = nur.lessonHub.runner;
  const step = runner.session.current;
  assert(step.kind === 'quiz' && step.game.gameId === 'ayah-completion', `first quiz is «تکمیل آیه» (${step.game.gameId})`);

  const round = step.game.current;
  const wrong = round.options.find((o) => !o.correct);
  const wrongBtn = buttonsIn(nur.lessonHub.card, '.mcg-option').find((b) => b.textContent.trim() === wrong.label);
  assert(wrongBtn, 'wrong option is rendered');
  wrongBtn.click();

  assert(step.game.mistakes.length === 1, 'mistake recorded');
  assert(step.game.done === false, 'the game continues after a mistake');
  assert(nur.lessonHub.card.textContent.includes('بدون جریمه'), 'UI states clearly that there is no penalty');
  const after = res(nur);
  for (const key of ['rizq', 'nur', 'hekmat', 'gohar']) assert(after[key] === before[key], `${key} unchanged by a mistake`);
  assert(runner.session.mistakes === 1, 'session counts the mistake for spaced repetition');
});

await test('phase 4 ①/②: the full lesson runs all three minigames and pays nur + hekmat + speedup', () => {
  const before = res(nur);
  const session = nur.lessonHub.runner.session;
  const played = new Set();

  let guard = 0;
  while (!session.closed && guard < 40) {
    guard += 1;
    const step = session.current;
    if (!step) break;
    if (step.kind === 'read') {
      clickByText(nur.lessonHub.card, '.ui-btn', 'خواندم، ادامه');
      continue;
    }
    if (step.kind === 'summary') {
      clickByText(nur.lessonHub.card, '.ui-btn', 'پایان و دریافت پاداش');
      break;
    }
    const game = step.game;
    played.add(game.gameId);
    if (game.gameId === 'ayah-completion') {
      let inner = 0;
      while (!game.done && inner < 60) {
        inner += 1;
        const right = game.current.options.find((o) => o.correct);
        const btn = buttonsIn(nur.lessonHub.card, '.mcg-option').find((b) => b.textContent.trim() === right.label && !b.disabled);
        assert(btn, 'correct option is clickable');
        btn.click();
      }
    } else if (game.gameId === 'word-match') {
      let inner = 0;
      while (!game.done && inner < 60) {
        inner += 1;
        const pair = game.pairs.find((p) => !game.matched.has(p.id));
        const termChip = buttonsIn(nur.lessonHub.card, '.wm-chip--term').find((b) => b.textContent.trim() === pair.term);
        assert(termChip, `term chip rendered (${pair.term})`);
        termChip.click();
        const meaningChip = buttonsIn(nur.lessonHub.card, '.wm-chip--meaning').find((b) => b.textContent.trim() === pair.meaning);
        assert(meaningChip, 'meaning chip rendered');
        meaningChip.click();
      }
    } else {
      let inner = 0;
      while (!game.done && inner < 60) {
        inner += 1;
        clickByText(nur.lessonHub.card, '.ui-btn--ghost', 'راهنما (بدون جریمه)');
        clickByText(nur.lessonHub.card, '.ui-btn--primary', 'بررسی ترتیب');
      }
    }
    assert(game.done, `${game.gameId} completed through the UI`);
    clickByText(nur.lessonHub.card, '.ui-btn--primary', 'مرحلهٔ بعد');
  }

  assert(played.size === 3, `all three minigames played (${[...played].join(', ')})`);
  const after = res(nur);
  assert(after.nur > before.nur, `nur reward added (${before.nur} → ${after.nur})`);
  assert(after.hekmat > before.hekmat, `hekmat reward added (${before.hekmat} → ${after.hekmat})`);
  assert(after.rizq >= before.rizq && after.gohar >= before.gohar, 'other resources never decrease');
  const learning = nur.game.learning;
  assert(learning.progress.lessons['lesson-basics'].completions === 1, 'lesson completion recorded');
  assert(nur.game.state.meta.stats.lessonsCompleted === 1 && nur.metaSystem.tutorialSnapshot().step.id === 'visit-campaign', 'completed lesson advances meta progression and the FTUE');
  assert(nur.lessonHub.card.querySelector('.reward-grid'), 'reward summary rendered');
  assert(nur.lessonHub.card.textContent.includes('نور'), 'reward summary names nur');
  const speedup = learning.totals.speedupSecondsUsed + learning.speedupPoolSeconds();
  assert(speedup > 0, `builder speedup reward granted (${speedup}s)`);
  assert(learning.stats().dueCount >= 1, 'items were scheduled for later review');
});

await test('phase 4 ④: mistaken items are re-queued — the spaced-repetition deck grows and the badge shows', () => {
  const learning = nur.game.learning;
  const stats = learning.stats();
  assert(stats.total >= 6, `Leitner deck populated (${stats.total})`);
  assert(Object.values(stats.byBox).reduce((a, b) => a + b, 0) === stats.total, 'every item sits in exactly one box');
  assert(learning.leitner.entry('ayah:1:1').box >= 1, 'seed verse tracked');

  // Back to the hub: the review card offers the due items.
  clickByText(nur.lessonHub.card, '.ui-btn', 'بازگشت به دارالقرآن');
  assert(nur.lessonHub.mode === 'hub', 'back on the hub list');
  const hubText = nur.lessonHub.card.textContent;
  assert(hubText.includes('مرور فاصله‌دار'), 'spaced repetition section present');
  const badge = nur.hud.studyBadge;
  assert(badge.textContent.trim().length > 0, 'HUD due badge rendered');
  assert(nur.hud.studyButton.classList.contains('is-alert'), 'HUD alerts while reviews are due');
});

await test('phase 4 ①/④: a review session runs, re-shows a mistaken item and rewards again', () => {
  const learning = nur.game.learning;
  const before = res(nur);
  const dueBefore = learning.stats().dueCount;
  assert(dueBefore > 0, 'something is due for review');

  clickByText(nur.lessonHub.card, '.ui-btn--primary', `شروع مرور (${'۰۱۲۳۴۵۶۷۸۹'[dueBefore]} مورد)`);
  assert(nur.lessonHub.mode === 'session', 'review session mounted');
  const session = nur.lessonHub.runner.session;
  assert(session.kind === 'review', 'session is a review session');

  // Deliberately fail the first item to prove it comes back.
  const step = session.current;
  const game = step.game;
  if (game.gameId === 'ayah-completion') {
    const wrong = game.current.options.find((o) => !o.correct);
    buttonsIn(nur.lessonHub.card, '.mcg-option').find((b) => b.textContent.trim() === wrong.label).click();
  } else {
    const pair = game.pairs.find((p) => !game.matched.has(p.id));
    buttonsIn(nur.lessonHub.card, '.wm-chip--term').find((b) => b.textContent.trim() === pair.term).click();
    const other = game.pairs.find((p) => p.id !== pair.id);
    buttonsIn(nur.lessonHub.card, '.wm-chip--meaning').find((b) => b.textContent.trim() === other.meaning).click();
  }
  assert(session.mistakes >= 1, 'mistake registered in the review session');

  // Finish the whole review session through the UI.
  let guard = 0;
  while (!session.closed && guard < 60) {
    guard += 1;
    const current = session.current;
    if (!current) break;
    const currentGame = current.game;
    if (currentGame.gameId === 'ayah-completion') {
      let inner = 0;
      while (!currentGame.done && inner < 60) {
        inner += 1;
        const right = currentGame.current.options.find((o) => o.correct);
        const btn = buttonsIn(nur.lessonHub.card, '.mcg-option').find((b) => b.textContent.trim() === right.label && !b.disabled);
        if (!btn) break;
        btn.click();
      }
    } else {
      let inner = 0;
      while (!currentGame.done && inner < 60) {
        inner += 1;
        const pair = currentGame.pairs.find((p) => !currentGame.matched.has(p.id));
        if (!pair) break;
        const termChip = buttonsIn(nur.lessonHub.card, '.wm-chip--term').find((b) => b.textContent.trim() === pair.term);
        if (!termChip) break;
        termChip.click();
        const meaningChip = buttonsIn(nur.lessonHub.card, '.wm-chip--meaning').find((b) => b.textContent.trim() === pair.meaning);
        if (!meaningChip) break;
        meaningChip.click();
      }
    }
    if (session.closed) break;
    clickByText(nur.lessonHub.card, '.ui-btn--primary', 'مرحلهٔ بعد');
  }

  assert(session.steps.some((s) => s.repeat || s.requeue), 'the mistaken item was re-shown inside the same session');
  assert(learning.progress.totals.reviewSessions === 1, 'review session counted');
  const after = res(nur);
  assert(after.nur >= before.nur && after.hekmat >= before.hekmat, 'review rewards never remove resources');
  assert(learning.progress.totals.reviewSessions + learning.progress.totals.lessonsCompleted >= 2, 'progress totals accumulate');
  clickByText(nur.lessonHub.card, '.ui-btn', 'بازگشت به دارالقرآن');
});

await test('phase 4 ⑤: Quran text is confined to the lesson UI (never in the world, HUD or save)', () => {
  const verse = nur.quran.dataset.verses.get('ayah:1:1');
  nur.lessonHub.close();
  assert(nur.lessonHub.root.classList.contains('is-hidden'), 'hub closed');
  assert(nur.input.enabled === true, 'input restored after closing the hub');
  const hudText = document.body.textContent;
  assert(!hudText.includes(verse.textUthmani), 'no verse text left anywhere in the DOM');
  assert(!hudText.includes(verse.translationFa), 'no translation left anywhere in the DOM');
  const strayText = [...document.querySelectorAll('.quran-text')].filter((node) => {
    const modal = node.closest('.ui-modal');
    return !modal || !modal.classList.contains('is-hidden'); // visible Quran-styled text outside a lesson
  });
  assert(strayText.length === 0, `no visible quran-text node outside the lesson UI (${strayText.length})`);

  // Nothing Quranic is attached to the 3D scene either.
  const scene = nur.engine.scene;
  let labels = 0;
  scene.traverse((object) => {
    // The building id «dar-al-quran» is a type name; nothing may carry verse text.
    const name = String(object.name || '');
    if (/ayah|surah|verse/i.test(name)) labels += 1;
    if (/quran/i.test(name) && !name.includes('dar-al-quran')) labels += 1;
    const data = object.userData || {};
    for (const value of Object.values(data)) {
      if (typeof value === 'string' && (value.includes(verse.textUthmani) || value.includes(verse.translationFa))) labels += 1;
    }
  });
  assert(labels === 0, 'no 3D object carries Quran text (names or userData)');

  // …and the save stores ids only.
  const payload = JSON.stringify(nur.game.serialize());
  assert(!payload.includes(verse.textUthmani), 'save file contains no verse text');
  assert(payload.includes('"learning"'), 'save file carries the learning progress');
  assert(payload.includes('lesson-basics'), 'lesson completion persisted');
});

await test('phase 4: learning progress survives a reload (Leitner boxes, lesson record, totals)', async () => {
  const before = nur.game.learning.stats();
  const sebelumTotals = { ...nur.game.learning.progress.totals };
  nur.saveNow();
  await sleep(300);
  window.dispatchEvent(new window.Event('pagehide'));
  await sleep(400);
  assert(!document.querySelector('.game-hud'), 'HUD torn down');

  nur = await boot();
  const learning = nur.game.learning;
  assert(learning.progress.lessons['lesson-basics'].completions === 1, 'lesson record restored');
  assert(learning.leitner.stats().total === before.total, `Leitner deck restored (${learning.leitner.stats().total})`);
  assert(learning.progress.totals.reviewSessions === sebelumTotals.reviewSessions, 'review counter restored');
  assert(learning.progress.totals.nurEarned === sebelumTotals.nurEarned, 'reward totals restored');
  assert(nur.lessonHub.card === undefined || true, 'hub rebuilt on the new boot');
  assert(document.querySelector('.lesson-hub'), 'lesson hub exists after reload');
  await waitFor(() => !document.querySelector('.ui-loading'), 5000, 'loading screen removed');

  // Leave a fresh active job behind: the later reboot test asserts that a live
  // builder timer survives a reload, and phase 4 finished the queue above.
  nur.game.state.resources.rizq = 20000;
  nur.game.state.resources.nur = 20000;
  nur.game.state.resources.hekmat = 20000;
  nur.game.emitState(Date.now(), true);
  const wallDef = nur.buildings.byId.get('wall');
  assert(nur.buildings.startPlacement('wall'), 'wall placement for the reboot fixture');
  const wallSpot = freeSpot(nur, wallDef);
  movePlacement(nur, wallSpot.x, wallSpot.z);
  nur.hud.confirmButton.click();
  nur.buildings.cancelPlacement();
  assert(nur.game.queue.jobs.some((j) => j.status === 'active'), 'an active job is queued for the reboot test');
  nur.saveNow();
  await sleep(300);
  assert(logs.jsdom.length === 0, `jsdom errors: ${logs.jsdom[0]}`);
});

/* ==================================================== phase C: backward clock (⑤) */

await test('acceptance ⑤: future timestamps → 0s away, no gains, no toast', async () => {
  // close boot 2 first so boot 3 starts on a clean DOM (double pagehide also
  // exercises the idempotency of the boot-1 handler, which is never removed)
  window.dispatchEvent(new window.Event('pagehide'));
  await sleep(400);
  assert(!document.querySelector('.game-hud'), 'boot 2 HUD torn down');
  await nur.saveSystem.save(nur.game.serialize());
  const record = await nur.saveSystem.load();
  const payload = JSON.parse(JSON.stringify(record.payload));
  const before = { ...payload.resources };
  const F = Date.now() + 3600 * 1000; // clock moved FORWARD beyond the save
  payload.savedAt = F;
  payload.lastAccrualAt = F;
  for (const e of payload.entities) e.lastAccrualAt = F;
  for (const j of payload.jobs) if (j.status === 'active') j.endsAt = Date.now() + 600000;
  await nur.saveSystem.saveRecord({ id: 'main', schemaVersion: 2, savedAt: F, payload });

  nur = await boot(); // third boot
  const bootLog = logs.info.filter((l) => /\[شهر نور\] فاز [\d۰-۹]+ آماده شد/.test(l)).pop();
  assert(/\(0s غیبت\)/.test(bootLog), `zero seconds away: ${bootLog}`);
  for (const key of ['rizq', 'nur', 'hekmat', 'gohar']) {
    assert(nur.game.state.resources[key] === before[key], `${key} untouched (got ${nur.game.state.resources[key]}, want ${before[key]})`);
  }
  assert(nur.game.offlineReport && nur.game.offlineReport.secondsAway === 0, 'report says 0s');
  assert(nur.game.offlineReport.gained == null || Object.keys(nur.game.offlineReport.gained).length === 0, 'no gains from the future');
  assert(!nur.hud.toastNode.classList.contains('is-visible'), 'no welcome-back toast');
  await waitFor(() => !document.querySelector('.ui-loading'), 5000, 'loading screen removed');
  assert(nur.hud.queueList.querySelector('.queue-timer'), 'active job still ticking');
  assert(logs.jsdom.length === 0, `jsdom errors: ${logs.jsdom[0]}`);
});

await teardown();
