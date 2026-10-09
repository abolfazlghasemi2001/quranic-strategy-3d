// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { registerPwaUpdates } from '../src/ui/PwaUpdateNotice.js';
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });
const setup = async (saveNow) => {
 const worker = { postMessage: vi.fn() }, registration = Object.assign(new EventTarget(), { waiting: worker, installing: null });
 const service = Object.assign(new EventTarget(), { controller: {}, register: vi.fn(async () => registration) });
 const reload = vi.fn(); vi.stubGlobal('navigator', { serviceWorker: service }); vi.stubGlobal('location', { reload });
 const dispose = await registerPwaUpdates({ config: { t: (key) => key }, saveNow, workerUrl: './sw.js' });
 return { worker, service, reload, dispose };
};
it('leaves the old controller alone until consent and durable save resolution', async () => {
 let resolve; const save = vi.fn(() => new Promise((done) => { resolve = done; })); const {worker,service,reload,dispose} = await setup(save);
 service.dispatchEvent(new Event('controllerchange')); expect(reload).not.toHaveBeenCalled();
 document.querySelector('.ui-btn--primary').click(); expect(save).toHaveBeenCalledOnce(); expect(worker.postMessage).not.toHaveBeenCalled();
 resolve(123); await Promise.resolve(); await Promise.resolve(); expect(worker.postMessage).toHaveBeenCalledWith({type:'SKIP_WAITING'});
 service.dispatchEvent(new Event('controllerchange')); expect(reload).toHaveBeenCalledOnce();dispose();
});
it('allows postponement and never activates a worker on a failed save', async () => {
 const {worker,dispose}=await setup(vi.fn().mockRejectedValue(new Error('quota')));
 document.querySelector('.ui-btn--primary').click(); await Promise.resolve();await Promise.resolve();
 expect(worker.postMessage).not.toHaveBeenCalled();expect(document.querySelector('.pwa-update').textContent).toContain('security.saveBeforeUpdateFailed');
 document.querySelectorAll('.pwa-update button')[1].click();expect(document.querySelector('.pwa-update')).toBeNull();dispose();
});
