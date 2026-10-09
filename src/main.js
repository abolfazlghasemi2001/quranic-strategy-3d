/** Composition only: city first; optional battle, study and panels load on demand. */
import './ui/hud.css';
import './ui/quran/accessibility.css';
import { ConfigRuntime as Config } from './core/ConfigRuntime.js';
import { Engine } from './core/Engine.js';
import { EventBus, EVENTS } from './core/EventBus.js';
import { FeatureLoader } from './core/FeatureLoader.js';
import { InputManager } from './core/InputManager.js';
import { OrbitCameraRig } from './core/OrbitCameraRig.js';
import { World } from './world/World.js';
import { BuildingView } from './world/BuildingView.js';
import { WorldInputAdapter } from './world/WorldInputAdapter.js';
import { GameRuntime as Game } from './game/GameRuntime.js';
import { BuildingSystem } from './game/BuildingSystem.js';
import { SaveSystem } from './game/SaveSystem.js';
import { PerfMonitor } from './ui/PerfMonitor.js';
import { HUD } from './ui/HUD.js';
import { LoadingScreen, ErrorOverlay } from './ui/LoadingScreen.js';

function applyAccessibilitySettings(settings = {}) {
  const root = document.documentElement, scales = { normal: 1, large: 1.14, larger: 1.28 };
  root.dataset.fontScale = scales[settings.fontScale] ? settings.fontScale : 'normal';
  root.style.setProperty('--ui-font-scale', String(scales[settings.fontScale] || 1));
  root.classList.toggle('is-high-contrast', Boolean(settings.highContrast));
  const reduceMotion = Boolean(settings.reduceMotion || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  root.classList.toggle('is-reduced-motion', reduceMotion); return reduceMotion;
}

async function boot() {
  const canvas = document.getElementById('scene'), config = new Config({ search: window.location.search }), bus = new EventBus();
  const loading = new LoadingScreen({ config, parent: document.body }), errorOverlay = new ErrorOverlay({ config, parent: document.body });
  loading.setStep('config', 0.03);
  let engine;
  try { engine = new Engine({ canvas, config, bus }); }
  catch (error) { errorOverlay.show(config.t(error.code === 'WEBGL_UNAVAILABLE' ? 'errors.webgl' : 'errors.boot')); loading.hide(); throw error; }
  const saveSystem = new SaveSystem(); let saveRecord = null;
  loading.setStep('save', 0.12);
  try { saveRecord = await saveSystem.load(); } catch (error) { console.warn(config.t('errors.saveLoad'), error); }
  const world = new World({ config, bus });
  await world.build((step, ratio) => loading.setStep(step, ratio)); engine.addToScene(world.group);
  const storedSettings = saveRecord?.payload?.meta?.settings || {};
  engine.setRuntimeSettings({ qualityTier: storedSettings.qualityTier || config.quality.tier, batterySaver: Boolean(storedSettings.batterySaver) });
  const input = new InputManager(canvas, { config }), rig = new OrbitCameraRig({ camera: engine.camera, config, input, bus });
  const quran = { dataset: null, validation: null, loadReport: { pending: true } };
  const game = new Game({ config, bus, record: saveRecord?.payload ?? null });
  if (saveRecord?.payload?.army?.training?.length || Object.keys(saveRecord?.payload?.army?.garrison || {}).length) { const mod = await import('./game/barracks/ArmyFeature.js'); mod.installArmy(game); }
  if (saveRecord?.payload?.campaign?.activeRun) { const mod = await import('./game/campaign/CampaignFeature.js'); mod.installCampaign(game); }
  const worldInput = new WorldInputAdapter({ config, world, rig, input, bus }), bootInfo = game.bootstrap();
  let disposed = false, saveTimer = 0, openIntent = 0;
  const saveNow = ({ strict = false } = {}) => { window.clearTimeout(saveTimer); return saveSystem.save(game.serialize(), { requirePersistent: strict }).catch((error) => { console.warn(config.t('errors.save'), error); if (strict) throw error; }); };
  const requestSave = () => { window.clearTimeout(saveTimer); saveTimer = window.setTimeout(saveNow, 1500); };
  const autosaveTimer = window.setInterval(saveNow, (config.economy.save.autosaveSeconds || 15) * 1000);
  const onVisibility = () => { if (document.visibilityState === 'hidden') saveNow(); };
  document.addEventListener('visibilitychange', onVisibility); game.attachPersist(requestSave);
  bus.on(EVENTS.HAPTIC_REQUESTED, ({ milliseconds }) => {
    if (game.meta.settings.hapticsEnabled !== false && typeof navigator.vibrate === 'function') { try { navigator.vibrate(milliseconds); } catch { /* optional hardware */ } }
  });
  let reduceMotion = applyAccessibilitySettings(game.meta.settings); world.setReducedMotion(reduceMotion);
  const buildings = new BuildingSystem({ config, bus, state: game.state, economy: game.economy, queue: game.queue, game, persist: requestSave });
  const buildingView = new BuildingView({ config, world, rig, input, bus, state: game.state, engine });
  buildingView.setReducedMotion(reduceMotion); game.emitState(Date.now(), true);
  bus.on(EVENTS.JOB_FINISHED, requestSave); bus.on(EVENTS.BATTLE_ENDED, saveNow); bus.on(EVENTS.MISSION_FINISHED, saveNow);
  const monitor = new PerfMonitor({ windowSeconds: 1.5, sampleInterval: 0.25 }), features = new FeatureLoader();
  let ctx;
  const open = (key, action) => {
    const intent = ++openIntent;
    buildings.cancelPlacement(); if (key !== 'meta') features.get('meta')?.panel.close();
    const ready = features.get(key);
    if (ready) { action(ready); return Promise.resolve(ready); }
    hud.toast(config.t('security.featureLoading'));
    return features.load(key).then((value) => { if (!disposed && openIntent === intent && value) { hud.toast(''); action(value); } return value; }).catch((error) => { if (!disposed && openIntent === intent) hud.toast(config.t('security.featureFailed')); console.warn(error); });
  };
  const hud = new HUD({
    config, engine, bus, monitor, rig, buildings, economy: game.economy, queue: game.queue, game,
    onOpenSocial: () => open('social', ({ panel }) => panel.show()),
    onOpenMissions: () => open('missions', ({ panel }) => panel.show()),
    onOpenBattle: () => open('battle', ({ battlePanel }) => battlePanel.show()),
    onOpenBarracks: () => open('battle', ({ barracksPanel }) => barracksPanel.show()),
    onOpenQuran: () => open('study', ({ policy }) => { policy.show(); engine.pause('modal'); }),
    onOpenStudy: () => open('study', ({ hub }) => hub.show()),
    onOpenSettings: () => open('settings', ({ panel }) => panel.show()),
    onOpenMeta: () => open('meta', ({ panel }) => panel.show()),
  });
  ctx = { config, engine, bus, game, world, rig, input, buildings, buildingView, hud, monitor, features, saveNow, quran, search: window.location.search, reducedMotion: () => reduceMotion, openStudy: () => open('study', ({ hub }) => hub.show()) };
  let stringsPromise;
  const ensureStrings = () => stringsPromise ||= import('./data/strings.fa.json').then((module) => config.installStrings(module.default));
  features.register('audio', async (signal) => {
    const { SoundManager } = await import('./core/SoundManager.js');
    if (signal.aborted) return null;
    const manager = new SoundManager({ bus, enabled: game.meta.settings.soundEnabled });
    return { manager, dispose: () => manager.dispose() };
  });
  const onGesture = () => features.load('audio').then((audio) => audio?.manager.unlockGesture()).catch(() => {});
  window.addEventListener('pointerdown', onGesture, { capture: true, passive: true });
  window.addEventListener('keydown', onGesture, { capture: true, passive: true });
  features.register('battle', async (signal) => { await ensureStrings(); const mod = await import('./ui/features/BattleFeature.js'); return signal.aborted ? null : mod.createBattleFeature(ctx); });
  features.register('study', async (signal) => { await ensureStrings(); const mod = await import('./ui/features/StudyFeature.js'); return signal.aborted ? null : mod.createStudyFeature(ctx, signal); });
  for (const key of ['settings', 'meta', 'social', 'missions', 'debug']) features.register(key, async (signal) => {
    await ensureStrings(); const mod = await import('./ui/features/PanelsFeature.js');
    if (key === 'missions') await features.load('study');
    return signal.aborted ? null : mod.createPanelFeature(key, ctx);
  });
  const modalVisible = (panel) => panel?.root && !panel.root.classList.contains('is-hidden');
  features.register('guide', async (signal) => {
    await ensureStrings(); const { FTUEGuide } = await import('./ui/FTUEGuide.js');
    if (signal.aborted) return null;
    const guide = new FTUEGuide({ config, bus, metaSystem: game.meta, engine, hud, buildings, rig, parent: document.body, isModalOpen: () => [features.get('study')?.hub, features.get('study')?.policy, features.get('battle')?.battlePanel, features.get('battle')?.barracksPanel, ...['meta', 'settings', 'social', 'missions'].map((key) => features.get(key)?.panel)].some(modalVisible) }); engine.addUpdatable(guide, 105);
    return { guide, dispose() { engine.removeUpdatable(guide); guide.dispose(); } };
  });
  bus.on(EVENTS.QURAN_LESSON_REQUESTED, ctx.openStudy);
  bus.on(EVENTS.QURAN_PANEL_OPENED, () => input.setEnabled(false)); bus.on(EVENTS.QURAN_PANEL_CLOSED, () => input.setEnabled(true));
  bus.on(EVENTS.SETTINGS_CHANGED, (settings) => {
    engine.setRuntimeSettings(settings); features.get('audio')?.manager.setEnabled(settings.soundEnabled);
    reduceMotion = applyAccessibilitySettings(settings); world.setReducedMotion(reduceMotion); buildingView.setReducedMotion(reduceMotion);
    features.get('battle')?.setSettings(settings, reduceMotion); features.get('study')?.setSettings(settings); saveNow();
  });
  if (game.offlineReport) hud.showOfflineReport(game.offlineReport);
  for (const warning of config.warnings) if (warning === 'social-endpoint-rejected') hud.toast(config.t('security.socialRejected'));
  for (const [item, priority] of [[world, 10], [rig, 20], [game, 30], [game.social, 31], [buildingView, 36], [hud, 100]]) engine.addUpdatable(item, priority);
  engine.start(); loading.setStep('ui', 1); const loadingTimer = window.setTimeout(() => loading.hide(), 260);

  let pwaDispose = null;
  const idle = () => {
    if (game.meta.settings.soundEnabled) features.load('audio').catch(console.warn);
    features.load('guide').catch(console.warn);
    features.load('study').catch((error) => { if (!disposed) console.warn(error); });
    if (import.meta.env.PROD && 'serviceWorker' in navigator) import('./ui/PwaUpdateNotice.js').then(({ registerPwaUpdates }) => registerPwaUpdates({ config, saveNow: () => saveNow({ strict: true }), workerUrl: `${import.meta.env.BASE_URL}sw.js` })).then((cleanup) => { if (disposed) cleanup(); else pwaDispose = cleanup; }).catch(console.warn);
  };
  const idleApi = typeof window.requestIdleCallback === 'function';
  const idleId = idleApi ? window.requestIdleCallback(idle, { timeout: config.quranLearning.dataset.idleDelayMs || 5000 }) : window.setTimeout(idle, config.quranLearning.dataset.idleDelayMs || 5000);
  if (config.dev) features.load('debug').catch(console.warn);
  const dispose = () => {
    if (disposed) return; disposed = true; ++openIntent;
    window.clearInterval(autosaveTimer); window.clearTimeout(saveTimer); window.clearTimeout(loadingTimer);
    if (idleApi) window.cancelIdleCallback(idleId); else window.clearTimeout(idleId);
    window.removeEventListener('pointerdown', onGesture, true); window.removeEventListener('keydown', onGesture, true);
    document.removeEventListener('visibilitychange', onVisibility); window.removeEventListener('pagehide', onPageHide);
    saveNow(); pwaDispose?.(); features.dispose(); hud.dispose(); buildings.dispose(); buildingView.dispose(); worldInput.dispose(); game.dispose(); input.dispose(); rig.dispose(); world.dispose(); engine.dispose(); bus.clear();
  };
  const onPageHide = (event) => { if (!event.persisted) dispose(); };
  window.addEventListener('pagehide', onPageHide);
  const handle = { config, engine, world, worldInput, game, buildings, buildingView, rig, input, bus, monitor, hud, quran, saveSystem, saveNow, dispose, features, metaSystem: game.meta,
    ensureBattle: () => features.load('battle'), ensureStudy: () => features.load('study'), ensureGuide: () => features.load('guide'), ensureSettings: () => features.load('settings'), ensureMissions: () => features.load('missions'), ensureAll: () => features.loadAll() };
  const refs = { battleView: ['battle', 'view'], battlePanel: ['battle', 'battlePanel'], barracksPanel: ['battle', 'barracksPanel'], lessonHub: ['study', 'hub'], quranPanel: ['study', 'policy'], datasetLoader: ['study', 'loader'], settingsPanel: ['settings', 'panel'], metaPanel: ['meta', 'panel'], jamaatPanel: ['social', 'panel'], missionPanel: ['missions', 'panel'], missionZone: ['missions', 'zone'], devPanel: ['debug', 'panel'], ftueGuide: ['guide', 'guide'], soundManager: ['audio', 'manager'] };
  for (const [key, [feature, property]] of Object.entries(refs)) Object.defineProperty(handle, key, { get: () => features.get(feature)?.[property] || null });
  Object.defineProperty(handle, 'social', { get: () => game.social }); window.__NUR__ = handle;
  if (config.socialUrl) features.load('social').then(() => game.social.connect({ url: config.socialUrl })).catch(() => {});
  console.info(`[شهر نور] فاز ۷ آماده شد — کیفیت: ${config.quality.tier}، بذر: ${config.seed}، ذخیره: ${saveRecord ? `بازیابی (${bootInfo.secondsAway}s غیبت)` : 'جدید'}، صف: ${game.queue.jobs.length}، منابع: ${JSON.stringify(game.state.resources)}`);
  return handle;
}
boot().catch((error) => { console.error('[شهر نور] خطای راه‌اندازی:', error); document.querySelector('.ui-error')?.classList.remove('is-hidden'); });
