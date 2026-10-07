/**
 * شهر نور — entry point (phase 1: foundation & 3D world)
 *
 * Boot order:
 *   config -> engine -> world -> input/camera -> game logic -> UI -> loop
 * Each layer only talks to the others through the event bus or through explicit
 * references handed over here, so later phases can add systems without rewrites.
 */
import './ui/hud.css';

import { Config } from './core/Config.js';
import { Engine } from './core/Engine.js';
import { EventBus } from './core/EventBus.js';
import { InputManager } from './core/InputManager.js';
import { OrbitCameraRig } from './core/OrbitCameraRig.js';
import { World } from './world/World.js';
import { Game } from './game/Game.js';
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

  loading.setStep('engine', 0.1);

  // ---------------------------------------------------------------- world
  const world = new World({ config, bus });
  await world.build((step, ratio) => loading.setStep(step, ratio));
  engine.addToScene(world.group);

  // -------------------------------------------------------------- camera
  const input = new InputManager(canvas, { config });
  const rig = new OrbitCameraRig({ camera: engine.camera, config, input, bus });

  // ---------------------------------------------------------------- game
  const game = new Game({ config, world, rig, input, bus });

  // ------------------------------------------------------------------ ui
  const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 });
  const quranPanel = new QuranPanel({ config, parent: document.body });
  const hud = new HUD({
    config,
    engine,
    bus,
    monitor,
    rig,
    onOpenQuran: () => {
      quranPanel.show();
      engine.pause('modal');
    },
  });
  const devPanel = new DevPanel({ config, engine, bus, monitor, rig, world });

  quranPanel.root.addEventListener('click', (event) => {
    if (event.target.classList.contains('ui-modal__backdrop') || event.target.classList.contains('ui-icon-btn')) {
      engine.resume('modal');
    }
  });

  // ---------------------------------------------------------------- loop
  engine.addUpdatable(world, 10);
  engine.addUpdatable(rig, 20);
  engine.addUpdatable(game, 30);
  engine.addUpdatable(hud, 100);
  engine.addUpdatable(devPanel, 110);

  engine.start();
  loading.setStep('ui', 1);
  window.setTimeout(() => loading.hide(), 260);

  // --------------------------------------------------------- debug handle
  window.__NUR__ = { config, engine, world, game, rig, input, bus, monitor, hud, devPanel, quranPanel };

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // keep everything for the back/forward cache
    devPanel.dispose();
    hud.dispose();
    quranPanel.dispose();
    game.dispose();
    input.dispose();
    rig.dispose();
    engine.removeUpdatable(world);
    world.dispose();
    engine.dispose();
    bus.clear();
  });

  console.info(
    `[شهر نور] فاز ۱ آماده شد — کیفیت: ${config.quality.tier}، بذر: ${config.seed}، اندازهٔ نقشه: ${config.cols}×${config.rows}`,
  );
  return window.__NUR__;
}

boot().catch((error) => {
  console.error('[شهر نور] خطای راه‌اندازی:', error);
  const overlay = document.querySelector('.ui-error');
  if (overlay && overlay.classList.contains('is-hidden')) overlay.classList.remove('is-hidden');
});
