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

await test('boot: fresh game starts in jsdom with no runtime errors', async () => {
  nur = await boot();
  assert(!logs.error.some((l) => l.includes('خطای راه‌اندازی')), 'no boot rejection');
  assert(logs.info.some((l) => l.includes('ذخیره: جدید')), 'fresh-boot log line present');
  assert(document.querySelector('.ui-error').classList.contains('is-hidden'), 'error overlay stays hidden');
  // offline welcome-back toast must NOT appear on a fresh boot
  assert(!nur.hud.toastNode.classList.contains('is-visible'), 'no offline toast on boot 1');
  await waitFor(() => !document.querySelector('.ui-loading'), 5000, 'loading screen removed');
  assert(logs.jsdom.length === 0, `jsdom errors: ${logs.jsdom[0]}`);
});

if (!nur) await teardown();

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
  nur.hud.shopList.children[1].click(); // مزرعه (farm)
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
  assert(nur.hud.queueBadge.textContent === '۱/۲', `builders badge: ${nur.hud.queueBadge.textContent}`);
  assert(chip(nur, 'rizq') === '۴۰۰/۸۰۰', `farm cost paid (rizq ${chip(nur, 'rizq')})`);
  assert(chip(nur, 'nur') === '۳۲۰/۶۰۰', `farm cost paid (nur ${chip(nur, 'nur')})`);
  assert(chip(nur, 'hekmat') === '۲۳۰/۴۰۰', `farm cost paid (hekmat ${chip(nur, 'hekmat')})`);
  assert(toastText(nur).includes('در صف ساخت'), `toast: ${toastText(nur)}`);
  assert(!nur.hud.selection.classList.contains('is-hidden'), 'confirmed building gets selected');
  assert(nur.hud.selection.textContent.includes('در حال ساخت'), 'selection shows building state');
});

await test('acceptance ③: two active builders, third job queued, wall placement chains', () => {
  nur.hud.shopList.children[2].click(); // چشمه (light-spring)
  movePlacement(nur, ...(() => {
    const s = freeSpot(nur, nur.buildings.byId.get('light-spring'));
    return [s.x, s.z];
  })());
  nur.hud.confirmButton.click();
  assert(nur.hud.queueList.querySelectorAll('.queue-row--active').length === 2, 'two active jobs');
  assert(nur.hud.queueBadge.textContent === '۰/۲', `badge after two jobs: ${nur.hud.queueBadge.textContent}`);

  nur.hud.shopList.children[6].click(); // دیوار (wall)
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
  assert(nur.game.state.resources.gohar === 19, `no double daily bonus (gohar ${nur.game.state.resources.gohar})`);
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
  nur.hud.shopList.children[5].click(); // نگهبانی (watchtower)
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
  payload.savedAt = T - 2 * 3600 * 1000;
  payload.lastAccrualAt = T - 2 * 3600 * 1000;
  payload.lastDailyAt = T - 48 * 3600 * 1000; // previous day → daily bonus should fire
  for (const e of payload.entities) {
    if (e.type === 'farm' || e.type === 'light-spring') e.lastAccrualAt = T - 2 * 3600 * 1000;
  }
  await nur.saveSystem.saveRecord({ id: 'main', schemaVersion: 2, savedAt: payload.savedAt, payload });
});

await test('acceptance ④/⑤: reload restores state, gains from 2 h offline, capped', async () => {
  nur = await boot(); // second boot (?run=2) over the backdated record
  // secondsAway log line first (toast disappears after 2.4 s)
  const bootLog = logs.info.filter((l) => l.includes('[شهر نور] فاز ۳ آماده شد')).pop();
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
  assert(chip(nur, 'gohar') === '۲۴', `daily bonus +5 (got ${chip(nur, 'gohar')})`);

  const rep = nur.game.offlineReport;
  assert(rep && rep.secondsAway === away, 'report secondsAway matches the log');
  assert(rep.gained && rep.gained.rizq > 0 && rep.gained.nur > 0, `offline gains: ${JSON.stringify(rep.gained)}`);
  assert(rep.goharDaily === 5, `daily bonus reported (got ${rep.goharDaily})`);
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
  const bootLog = logs.info.filter((l) => l.includes('[شهر نور] فاز ۳ آماده شد')).pop();
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
