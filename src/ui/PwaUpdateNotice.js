/** Explicit update consent: preserve the running version until its save completes. */
import { el, button } from './dom.js';
export async function registerPwaUpdates({ config, saveNow, workerUrl }) {
  if (!('serviceWorker' in navigator)) return () => {};
  const service = navigator.serviceWorker;
  const registration = await service.register(workerUrl);
  let root = null, reloadAccepted = false, disposed = false, installing = null;
  const offer = () => {
    if (disposed || root || !registration.waiting || !service.controller) return;
    const apply = button(config.t('security.updateApply'), { className: 'ui-btn ui-btn--primary', onClick: async () => {
      apply.disabled = true;
      try { await saveNow(); reloadAccepted = true; registration.waiting?.postMessage({ type: 'SKIP_WAITING' }); }
      catch { apply.disabled = false; reloadAccepted = false; root.querySelector('p').textContent = config.t('security.saveBeforeUpdateFailed'); }
    } });
    root = el('aside', { className: 'pwa-update', attrs: { role: 'status', 'aria-live': 'polite', dir: 'rtl' }, children: [el('p', { text: config.t('security.updateReady') }), apply, button(config.t('security.updateLater'), { className: 'ui-btn', onClick: () => { root?.remove(); root = null; } })] });
    document.body.append(root);
  };
  const changed = () => { if (installing?.state === 'installed') offer(); };
  const found = () => { installing?.removeEventListener('statechange', changed); installing = registration.installing; installing?.addEventListener('statechange', changed); };
  const controller = () => { if (reloadAccepted) { reloadAccepted = false; location.reload(); } };
  registration.addEventListener('updatefound', found); service.addEventListener('controllerchange', controller); offer(); found();
  return () => { disposed = true; root?.remove(); registration.removeEventListener('updatefound', found); installing?.removeEventListener('statechange', changed); service.removeEventListener('controllerchange', controller); };
}
