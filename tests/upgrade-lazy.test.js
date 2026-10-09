import { expect, it, vi } from 'vitest';
import { FeatureLoader } from '../src/core/FeatureLoader.js';
it('loads nothing during registration and coalesces concurrent requests', async () => {
  const factory = vi.fn(async () => ({ dispose: vi.fn() })); const loader = new FeatureLoader().register('battle', factory);
  expect(factory).not.toHaveBeenCalled();
  const [a,b] = await Promise.all([loader.load('battle'),loader.load('battle')]);
  expect(a).toBe(b); expect(factory).toHaveBeenCalledOnce(); loader.dispose(); loader.dispose(); expect(a.dispose).toHaveBeenCalledOnce();
});
it('can retry a failed import without poisoning the feature cache', async () => {
  const factory = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({});
  const loader = new FeatureLoader().register('quran', factory);
  await expect(loader.load('quran')).rejects.toThrow('offline'); expect(await loader.load('quran')).toEqual({});
});
it('cancels pending ownership and disposes any late factory result', async () => {
  let resolve; const value = { dispose: vi.fn() }; const loader = new FeatureLoader().register('settings', () => new Promise((r) => { resolve = r; }));
  const promise = loader.load('settings'); await Promise.resolve(); loader.dispose(); resolve(value);
  await expect(promise).rejects.toThrow('disposed'); expect(value.dispose).toHaveBeenCalledOnce(); expect(loader.get('settings')).toBeNull();
});
