/**
 * شهر نور — entry point (phase 3: economy, time & persistence)
 *
 * Boot order:
 *   config -> engine -> load save -> world -> input/camera -> game (hydrate +
 *   offline catch-up) -> buildings -> UI -> loop
 * Each layer only talks to the others through the event bus or through explicit
 * references handed over here, so later phases can add systems without rewrites.
 */
import './ui/hud.css';

import { Config } from './core/Config.js';
import { Engine } from './core/Engine.js';
import { EventBus, EVENTS } from './core/EventBus.js';
import { InputManager } from './core/InputManager.js';
import { OrbitCameraRig } from './core/OrbitCameraRig.js';
import { World } from './world/World.js';
import { Game } from './game/Game.js';
import { BuildingSystem } from './game/BuildingSystem.js';
import { SaveSystem } from './game/SaveSystem.js';
import { PerfMonitor } from './ui/PerfMonitor.js';
import { HUD } from './ui/HUD.js';
import { DevPanel } from './ui/DevPanel.js';
import { QuranPanel } from './ui/QuranPanel.js';
import { LoadingScreen, ErrorOverlay } from './ui/LoadingScreen.js';

async function boot() {
  const canvas = document.getElementById('scene');
  const config = new Config({ search: window.location.search });
  const bus = new EventBus();

  const loading = new LoadingScreen({ config, parent: document.body });
  const errorOverlay = new ErrorOverlay({ config, parent: document.body });
  loading.setStep('config', 0.03);

  let engine;
  try {
    engine = new Engine({ canvas, config, bus });
  } catch (error) {
    console.error(error);
    if (error && error.code === 'WEBGL_UNAVAILABLE') {
      errorOverlay.show(config.t('errors.webgl', 'WebGL2 در دسترس نیست.'));
    } else {
      errorOverlay.show(config.t('errors.boot', 'راه‌اندازی موتور گرافیکی ناموفق بود.'));
    }
    loading.hide();
    throw error;
  }

  loading.setStep('engine', 0.08);

  // ----------------------------------------------------------- persistence
  const saveSystem = new SaveSystem();
  loading.setStep('save', 0.12);
  let saveRecord = null;
  try {
    saveRecord = await saveSystem.load(); // {payload, migratedFrom, savedAt} | null
    if (saveRecord?.migratedFrom) {
      console.info(`[شهر نور] ذخیره از نسخهٔ ${saveRecord.migratedFrom} مهاجرت داده شد.`);
    }
  } catch (error) {
    console.warn('[شهر نور] بارگذاری ذخیره ناموفق بود؛ بازی از نو شروع می‌شود.', error);
    saveRecord = null;
  }

  // ---------------------------------------------------------------- world
  const world = new World({ config, bus });
  await world.build((step, ratio) => loading.setStep(step, ratio));
  engine.addToScene(world.group);

  // -------------------------------------------------------------- camera
  const input = new InputManager(canvas, { config });
  const rig = new OrbitCameraRig({ camera: engine.camera, config, input, bus });

  // ---------------------------------------------------------------- game
  const game = new Game({ config, world, rig, input, bus, record: saveRecord?.payload ?? null });
  const bootInfo = game.bootstrap(); // hydrate + offline catch-up + seed if fresh

  // ------------------------------------------------------------ save hooks
  let saveTimer = 0;
  const saveNow = () => {
    window.clearTimeout(saveTimer);
    saveSystem.save(game.serialize()).catch((error) => console.warn('[شهر نور] ذخیره ناموفق:', error));
  };
  /** Debounced (~1.5s) save after harvest / spend / enqueue. */
  const requestSave = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 1500);
  };
  const autosaveMs = (config.economy.save.autosaveSeconds || 15) * 1000;
  const autosaveTimer = window.setInterval(saveNow, autosaveMs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  const buildings = new BuildingSystem({
    config, world, rig, input, bus,
    state: game.state,
    economy: game.economy,
    queue: game.queue,
    game,
    persist: requestSave,
  });
  bus.on(EVENTS.JOB_FINISHED, requestSave);

  // ------------------------------------------------------------------ ui
  const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 });
  const quranPanel = new QuranPanel({ config, parent: document.body });
  const hud = new HUD({
    config,
    engine,
    bus,
    monitor,
    rig,
    buildings,
    economy: game.economy,
    queue: game.queue,
    onOpenQuran: () => {
      quranPanel.show();
      engine.pause('modal');
    },
  });
  const devPanel = new DevPanel({
    config,
    engine,
    bus,
    monitor,
    rig,
    world,
    onSaveNow: () => {
      saveNow();
      hud.toast('بازی ذخیره شد.');
    },
    onSimulateOffline: () => {
      const result = game.simulateOffline(60 * 60 * 1000);
      const gainedText = Object.entries(result.gained)
        .map(([key, value]) => `${config.t(`economy.${key}`, key)} ${value}`)
        .join('، ');
      hud.toast(`غیبت ۱ ساعته شبیه‌سازی شد${gainedText ? `: +${gainedText}` : ''}`);
      saveNow();
    },
  });

  quranPanel.root.addEventListener('click', (event) => {
    if (event.target.classList.contains('ui-modal__backdrop') || event.target.classList.contains('ui-icon-btn')) {
      engine.resume('modal');
    }
  });

  // Welcome-back toast (acceptance ⑤).
  if (game.offlineReport) hud.showOfflineReport(game.offlineReport);

  // ---------------------------------------------------------------- loop
  engine.addUpdatable(world, 10);
  engine.addUpdatable(rig, 20);
  engine.addUpdatable(game, 30);
  engine.addUpdatable(buildings, 35);
  engine.addUpdatable(hud, 100);
  engine.addUpdatable(devPanel, 110);

  engine.start();
  loading.setStep('ui', 1);
  window.setTimeout(() => loading.hide(), 260);

  // --------------------------------------------------------- debug handle
  window.__NUR__ = {
    config, engine, world, game, buildings, rig, input, bus, monitor, hud, devPanel, quranPanel,
    saveSystem, saveNow,
  };

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // keep everything for the back/forward cache
    window.clearInterval(autosaveTimer);
    window.clearTimeout(saveTimer);
    saveNow();
    devPanel.dispose();
    hud.dispose();
    quranPanel.dispose();
    buildings.dispose();
    game.dispose();
    input.dispose();
    rig.dispose();
    engine.removeUpdatable(world);
    world.dispose();
    engine.dispose();
    bus.clear();
  });

  console.info(
    `[شهر نور] فاز ۳ آماده شد — کیفیت: ${config.quality.tier}، بذر: ${config.seed}، ` +
    `ذخیره: ${saveRecord ? `بازیابی (${bootInfo.secondsAway}s غیبت)` : 'جدید'}، ` +
    `صف: ${game.queue.jobs.length}، منابع: ${JSON.stringify(game.state.resources)}`,
  );
  return window.__NUR__;
}

boot().catch((error) => {
  console.error('[شهر نور] خطای راه‌اندازی:', error);
  const overlay = document.querySelector('.ui-error');
  if (overlay && overlay.classList.contains('is-hidden')) overlay.classList.remove('is-hidden');
});
