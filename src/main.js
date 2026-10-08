/**
 * شهر نور — entry point (phase 7: meta progression, FTUE and settings)
 *
 * Boot order:
 *   config -> engine -> load save -> Quran dataset -> world -> input/camera ->
 *   game (hydrate + offline catch-up) -> buildings -> UI -> loop
 * Each layer only talks to the others through the event bus or through explicit
 * references handed over here, so later phases can add systems without rewrites.
 */
import './ui/hud.css';

import { Config } from './core/Config.js';
import { Engine } from './core/Engine.js';
import { EventBus, EVENTS } from './core/EventBus.js';
import { SoundManager } from './core/SoundManager.js';
import { InputManager } from './core/InputManager.js';
import { OrbitCameraRig } from './core/OrbitCameraRig.js';
import { World } from './world/World.js';
import { Game } from './game/Game.js';
import { BuildingSystem } from './game/BuildingSystem.js';
import { SaveSystem } from './game/SaveSystem.js';
import { QuranDatasetLoader } from './game/quran/QuranDataset.js';
import quranSample from './data/quran-sample.json';
import { PerfMonitor } from './ui/PerfMonitor.js';
import { HUD } from './ui/HUD.js';
import { DevPanel } from './ui/DevPanel.js';
import { QuranPanel } from './ui/QuranPanel.js';
import { LessonHub } from './ui/quran/LessonHub.js';
import { BattleView } from './world/battle/BattleView.js';
import { BattlePanel } from './ui/BattlePanel.js';
import { BarracksPanel } from './ui/BarracksPanel.js';
import { MissionZone } from './world/MissionZone.js';
import { MissionPanel } from './ui/campaign/MissionPanel.js';
import { MetaPanel } from './ui/MetaPanel.js';
import { SettingsPanel } from './ui/SettingsPanel.js';
import { FTUEGuide } from './ui/FTUEGuide.js';
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

  // -------------------------------------------------------- quran dataset
  // The dataset is loaded by the UI/logic entry point only — never by core/ or
  // world/, so Quran text can never leak into the 3D scene, ground or effects.
  loading.setStep('quran', 0.15);
  const datasetLoader = new QuranDatasetLoader({
    sample: quranSample,
    learning: config.quranLearning,
    search: window.location.search,
  });
  const quranLoad = await datasetLoader.load();
  const quran = { dataset: quranLoad.dataset, validation: quranLoad.validation, loadReport: quranLoad.loadReport };
  if (quranLoad.loadReport.remoteLoaded) {
    console.info(`[شهر نور] دیتاست قرآن از بیرون بارگذاری شد: ${quranLoad.loadReport.url} (${quranLoad.validation.warnings} هشدار)`);
  } else {
    console.info(`[شهر نور] دیتاست قرآن: نمونهٔ داخلی (جای‌نگهدار) — علت: ${quranLoad.loadReport.remoteError}`);
  }
  if (quranLoad.validation.errors > 0) {
    console.warn('[شهر نور] خطاهای اعتبارسنجی دیتاست:', quranLoad.validation.issues.filter((i) => i.level === 'error'));
  }

  // ---------------------------------------------------------------- world
  const world = new World({ config, bus });
  await world.build((step, ratio) => loading.setStep(step, ratio));
  engine.addToScene(world.group);
  const storedSettings = saveRecord?.payload?.meta?.settings || {};
  engine.setRuntimeSettings({
    qualityTier: storedSettings.qualityTier || config.quality.tier,
    batterySaver: Boolean(storedSettings.batterySaver),
  });

  // -------------------------------------------------------------- camera
  const input = new InputManager(canvas, { config });
  const rig = new OrbitCameraRig({ camera: engine.camera, config, input, bus });

  // ---------------------------------------------------------------- game
  const game = new Game({ config, world, rig, input, bus, record: saveRecord?.payload ?? null, quran });
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

  game.attachPersist(requestSave);
  const soundManager = new SoundManager({ bus, enabled: game.meta.settings.soundEnabled });

  const buildings = new BuildingSystem({
    config, world, rig, input, bus,
    state: game.state,
    economy: game.economy,
    queue: game.queue,
    game,
    engine,
    persist: requestSave,
  });
  bus.on(EVENTS.JOB_FINISHED, requestSave);
  // نتیجهٔ نبرد (آسیب سازه‌ها، سپاه بازمانده، پاداش) بی‌درنگ ذخیره می‌شود.
  bus.on(EVENTS.BATTLE_ENDED, () => saveNow());

  // ------------------------------------------------------------------ ui
  const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 });
  const lessonHub = new LessonHub({
    config,
    learning: game.learning,
    bus,
    parent: document.body,
    hasBuilding: () => [...game.state.entities.values()].some((e) => e.type === 'dar-al-quran' && e.status === 'ready'),
  });
  const quranPanel = new QuranPanel({ config, parent: document.body, learning: game.learning });

  // Phase 5: لایهٔ رندر نبرد + پنل‌های سپاه و نبرد.
  const battleView = new BattleView({
    parent: world.group,
    config,
    state: game.state,
    rig,
    buildings,
    battleData: game.battle.battleData,
    unitsData: game.battle.unitsData,
    getBattle: () => game.battle,
    engine,
    seed: config.seed,
  });
  const barracksPanel = new BarracksPanel({
    config,
    bus,
    barracks: game.barracks,
    economy: game.economy,
    unitsData: game.battle.unitsData,
  });
  const battlePanel = new BattlePanel({
    config,
    bus,
    battle: game.battle,
    barracks: game.barracks,
    unitsData: game.battle.unitsData,
    view: battleView,
    onBattleStart: () => {
      buildings.cancelPlacement();
      hud.toggleShop(false);
      hud.setBattleLive(true);
      battleView.mount(game.battle.sim);
      const town = game.battle.sim?.townCenter();
      const townDef = town ? { x: (town.col + town.w / 2) * config.tileSize, z: (town.row + town.h / 2) * config.tileSize } : null;
      battleView.focusCamera(townDef || { x: config.cols * config.tileSize / 2, z: config.rows * config.tileSize / 2 });
      hud.toast(config.t('battle.startedToast', 'نبرد آغاز شد؛ از پادگان نیرو مستقر کنید.'));
    },
    onBattleExit: () => {
      battleView.unmount();
      hud.setBattleLive(false);
    },
    onOpenBarracks: () => {
      buildings.cancelPlacement();
      barracksPanel.show();
    },
  });

  // Phase 6: نشانگرهای سه‌بعدی مأموریت‌ها + پنل کمپین قصص.
  const missionZone = new MissionZone({
    config,
    parent: world.group,
    bus,
    engine,
    getSnapshot: () => game.campaign?.snapshot() || null,
  });
  missionZone.setMissions(game.missions.byId);
  const missionPanel = new MissionPanel({
    config,
    bus,
    campaign: game.campaign,
    economy: game.economy,
    dataset: quran.dataset,
    parent: document.body,
    onOpenLesson: () => {
      missionPanel.close();
      buildings.cancelPlacement();
      lessonHub.show();
    },
  });

  const replayFTUE = () => game.meta.replayTutorial();
  const settingsPanel = new SettingsPanel({
    config,
    bus,
    metaSystem: game.meta,
    parent: document.body,
    onReplay: replayFTUE,
    onPause: () => engine.pause('settings'),
    onResume: () => engine.resume('settings'),
  });
  const metaPanel = new MetaPanel({
    config,
    bus,
    metaSystem: game.meta,
    parent: document.body,
    onReplay: replayFTUE,
    onPause: () => engine.pause('meta-panel'),
    onResume: () => engine.resume('meta-panel'),
  });

  const hud = new HUD({
    config,
    engine,
    bus,
    monitor,
    rig,
    buildings,
    economy: game.economy,
    queue: game.queue,
    game,
    learning: game.learning,
    campaign: game.campaign,
    onOpenMissions: () => {
      buildings.cancelPlacement();
      missionPanel.show();
    },
    onOpenBattle: () => {
      buildings.cancelPlacement();
      battlePanel.show();
    },
    onOpenBarracks: () => {
      buildings.cancelPlacement();
      barracksPanel.show();
    },
    onOpenQuran: () => {
      quranPanel.show();
      engine.pause('modal');
    },
    onOpenStudy: () => {
      // Lessons run with the city live behind the modal, so builders keep
      // working while the player studies — only camera input is suspended.
      buildings.cancelPlacement();
      lessonHub.show();
    },
    onOpenSettings: () => {
      buildings.cancelPlacement();
      settingsPanel.show();
    },
    onOpenMeta: () => {
      buildings.cancelPlacement();
      metaPanel.show();
    },
  });
  const modalIsVisible = (panel) => Boolean(panel?.root && !panel.root.classList.contains('is-hidden'));
  const ftueGuide = new FTUEGuide({
    config,
    bus,
    metaSystem: game.meta,
    engine,
    hud,
    buildings,
    rig,
    parent: document.body,
    isModalOpen: () => [settingsPanel, metaPanel, lessonHub, quranPanel, missionPanel, battlePanel, barracksPanel].some(modalIsVisible),
  });
  bus.on(EVENTS.SETTINGS_CHANGED, (settings) => {
    engine.setRuntimeSettings(settings);
    soundManager.setEnabled(settings.soundEnabled);
    saveNow();
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

  // پایان مأموریت بی‌درنگ ذخیره می‌شود (ستاره‌ها و باز شدن مأموریت بعدی).
  bus.on(EVENTS.MISSION_FINISHED, () => saveNow());

  bus.on(EVENTS.QURAN_LESSON_REQUESTED, () => {
    buildings.cancelPlacement();
    lessonHub.show();
  });
  bus.on(EVENTS.QURAN_PANEL_OPENED, () => input.setEnabled(false));
  bus.on(EVENTS.QURAN_PANEL_CLOSED, () => input.setEnabled(true));

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
  engine.addUpdatable(lessonHub, 95);
  engine.addUpdatable(battleView, 40);
  engine.addUpdatable(missionZone, 45);
  engine.addUpdatable(missionPanel, 98);
  engine.addUpdatable(battlePanel, 96);
  engine.addUpdatable(barracksPanel, 97);
  engine.addUpdatable(hud, 100);
  engine.addUpdatable(ftueGuide, 105);
  engine.addUpdatable(devPanel, 110);

  engine.start();
  loading.setStep('ui', 1);
  window.setTimeout(() => loading.hide(), 260);

  // --------------------------------------------------------- debug handle
  window.__NUR__ = {
    config, engine, world, game, buildings, rig, input, bus, monitor, hud, devPanel, quranPanel,
    lessonHub, datasetLoader, quran, saveSystem, saveNow,
    battleView, battlePanel, barracksPanel, missionZone, missionPanel,
    metaSystem: game.meta, metaPanel, settingsPanel, ftueGuide, soundManager,
  };

  window.addEventListener('pagehide', (event) => {
    if (event.persisted) return; // keep everything for the back/forward cache
    window.clearInterval(autosaveTimer);
    window.clearTimeout(saveTimer);
    saveNow();
    devPanel.dispose();
    ftueGuide.dispose();
    settingsPanel.dispose();
    metaPanel.dispose();
    soundManager.dispose();
    hud.dispose();
    quranPanel.dispose();
    lessonHub.dispose();
    missionPanel.dispose();
    missionZone.dispose();
    battlePanel.dispose();
    barracksPanel.dispose();
    battleView.dispose();
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
    `[شهر نور] فاز ۷ آماده شد — کیفیت: ${config.quality.tier}، بذر: ${config.seed}، ` +
    `ذخیره: ${saveRecord ? `بازیابی (${bootInfo.secondsAway}s غیبت)` : 'جدید'}، ` +
    `صف: ${game.queue.jobs.length}، منابع: ${JSON.stringify(game.state.resources)}، ` +
    `دیتاست قرآن: ${quran.dataset.stats.datasetId} (آیه ${quran.dataset.stats.verseCount}، درس ${quran.dataset.stats.lessonCount}، بازبینی‌شده ${quran.dataset.stats.reviewedVerseCount})، ` +
    `در نوبت مرور: ${game.learning.stats().dueCount}، ` +
    `سپاه: ${game.barracks.total()} (ظرفیت ${game.barracks.capacity()})، ` +
    `سابقهٔ نبرد: ${game.state.battles.history.length}، ` +
    `کمپین: ${game.campaign.list().filter((m) => m.status !== 'locked').length}/${game.campaign.list().length} مأموریت باز، ★${game.campaign.totalStars()}، ` +
    `مأموریت فعال: ${game.campaign.activeRun ? game.campaign.mission(game.campaign.activeRun.missionId)?.title : 'ندارد'}`, 
  );
  return window.__NUR__;
}

boot().catch((error) => {
  console.error('[شهر نور] خطای راه‌اندازی:', error);
  const overlay = document.querySelector('.ui-error');
  if (overlay && overlay.classList.contains('is-hidden')) overlay.classList.remove('is-hidden');
});
