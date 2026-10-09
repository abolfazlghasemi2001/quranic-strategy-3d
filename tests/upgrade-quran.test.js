import { createHash, webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QuranDatasetLoader } from '../src/game/quran/QuranDataset.js';
import sample from '../src/data/quran-sample.json';
import learning from '../src/data/quran-learning.json';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const text = JSON.stringify(sample);
const make = (content = text, options = {}) => new QuranDatasetLoader({ sample, learning: { ...learning, dataset: { ...learning.dataset, checksums: { './alt/my.json': digest(text) }, ...options.dataset } }, search: '?quran=./alt/my.json', baseUrl: 'https://localhost/', fetchImpl: async () => ({ ok: true, text: async () => content, json: async () => JSON.parse(content) }), ...options.loader });
afterEach(() => vi.unstubAllGlobals());
describe('QUR-01: relative path, byte integrity and schema boundary', () => {
  it('accepts a checksummed relative dataset and preserves its reviewed flags', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { dataset, loadReport } = await make().load();
    expect(loadReport.remoteLoaded).toBe(true);
    expect(dataset.meta.reviewed).toBe(sample.meta.reviewed);
  });
  it('rejects different bytes even if the JSON value is identical', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { loadReport } = await make(text + '\n').load();
    expect(loadReport.remoteLoaded).toBe(false);
    expect(loadReport.error).toMatch(/checksum/i);
  });
  it('rejects duplicate ayah indices even with a matching checksum', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const duplicate = structuredClone(sample); duplicate.surahs[0].ayahs.push(duplicate.surahs[0].ayahs[0]);
    const content = JSON.stringify(duplicate);
    const { loadReport } = await make(content, { dataset: { checksums: { './alt/my.json': digest(content) } } }).load();
    expect(loadReport.remoteLoaded).toBe(false);
    expect(loadReport.error).toMatch(/schema/i);
  });
  it('ignores an override without a pinned checksum', () => {
    const loader = new QuranDatasetLoader({ sample, learning, search: '?quran=./unknown.json' });
    expect(loader.resolveUrl()).toBe('./quran/quran.json');
  });
  it('rejects a response beyond the configured byte budget', async () => {
    vi.stubGlobal('crypto', webcrypto);
    expect((await make(text, { dataset: { maxBytes: 20 } }).load()).loadReport.remoteLoaded).toBe(false);
  });
  it('has an absolute fetch deadline even for a stalled mock ignoring AbortSignal', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const { loadReport } = await make(text, { dataset: { timeoutMs: 15 }, loader: { fetchImpl: () => new Promise(() => {}) } }).load();
    expect(loadReport.remoteLoaded).toBe(false); expect(loadReport.error).toMatch(/timeout/i);
  }, 300);
});
