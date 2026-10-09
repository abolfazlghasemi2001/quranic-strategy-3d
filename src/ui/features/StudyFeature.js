import { QuranDatasetLoader } from '../../game/quran/QuranDataset.js';
import { LearningSystem } from '../../game/quran/LearningSystem.js';
import quranSample from '../../data/quran-sample.json';
import { LessonHub } from '../quran/LessonHub.js';
import { QuranPanel } from '../QuranPanel.js';
import { setRecitationEnabled, stopRecitation } from '../quran/RecitationAudio.js';
import { EVENTS } from '../../core/EventBus.js';

export async function createStudyFeature(ctx, signal) {
  const { config, game, bus, hud, engine } = ctx;
  const loader = new QuranDatasetLoader({ sample: quranSample, learning: config.quranLearning, search: ctx.search, baseUrl: config.appUrl });
  const loaded = await loader.load();
  if (signal.aborted) return null;
  Object.assign(ctx.quran, loaded);
  const learning = game.enableLearning(LearningSystem, ctx.quran); hud.learning = learning;
  setRecitationEnabled(game.meta.settings.recitationEnabled);
  const hub = new LessonHub({ config, learning, bus, parent: document.body, hasBuilding: () => [...game.state.entities.values()].some((entity) => entity.type === 'dar-al-quran' && entity.status === 'ready') });
  const policy = new QuranPanel({ config, parent: document.body, learning });
  const close = (event) => { if (event.target.classList.contains('ui-modal__backdrop') || event.target.classList.contains('ui-icon-btn')) engine.resume('modal'); };
  policy.root.addEventListener('click', close);
  engine.addUpdatable(hub, 95);
  bus.emit(EVENTS.QURAN_DATASET_READY, { dataset: loaded.dataset.stats, validation: loaded.validation, loadReport: loaded.loadReport, learning: learning.stats() });
  learning.tick(Date.now());
  if (loaded.loadReport.warning) console.warn(config.t('security.quranOverrideRejected'));
  if (loaded.loadReport.remoteError) console.warn(config.t('security.quranRejected'), loaded.loadReport.remoteError);
  return {
    loader, hub, policy,
    setSettings(settings) { setRecitationEnabled(settings.recitationEnabled); },
    dispose() { policy.root.removeEventListener('click', close); engine.removeUpdatable(hub); hub.dispose(); policy.dispose(); stopRecitation(); },
  };
}
