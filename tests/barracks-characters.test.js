// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarracksPanel } from '../src/ui/BarracksPanel.js';
import { EventBus, EVENTS } from '../src/core/EventBus.js';

const config = { t: (_key, fallback) => fallback };
const unitsData = {
  units: [{
    id: 'guard', name: 'نگهبان', icon: '⛨', role: 'melee', description: 'نزدیک‌زن',
    cost: { rizq: 5 }, hp: 100, damage: 10, rangeTiles: 1, speedTilesPerSecond: 2, trainSeconds: 8,
  }],
};
const makeBarracks = () => ({
  readiness: () => ({ used: 1, capacity: 10, free: 9, freeSlots: 1, slots: 2 }),
  hasBarracks: () => true,
  countOf: () => 1,
  jobFor: () => null,
  canTrain: () => ({ ok: true }),
  maxPerType: () => 20,
  activeJobs: () => [],
  queuedJobs: () => [],
});

afterEach(() => { document.body.replaceChildren(); });

describe('Barracks character presentation', () => {
  it('loads selectable unit appearances on open and presents recoverable fallback status without technical errors', () => {
    const bus = new EventBus();
    const onOpenCharacters = vi.fn();
    const onRetryCharacters = vi.fn();
    const selectedProfile = vi.fn();
    bus.on(EVENTS.CHARACTER_PROFILE_SELECTED, selectedProfile);
    const panel = new BarracksPanel({
      config,
      bus,
      barracks: makeBarracks(),
      economy: {},
      unitsData,
      onOpenCharacters,
      onRetryCharacters,
    });

    panel.show();
    expect(onOpenCharacters).toHaveBeenCalledOnce();
    expect(panel.unitList.textContent).toContain('نگهبان');
    expect(panel.unitList.textContent).toContain('مدل سه‌بعدی');
    const selector = panel.unitList.querySelector('select[data-unit="guard"]');
    expect(selector).toBeTruthy();
    selector.value = 'scholar';
    selector.dispatchEvent(new Event('change', { bubbles: true }));
    expect(selectedProfile).toHaveBeenCalledWith({ unitId: 'guard', profileId: 'scholar' });
    expect(panel.unitList.textContent).toContain('دانش‌پژوه');

    bus.emit(EVENTS.CHARACTER_ASSET_STATUS, { modelId: 'guard', status: 'loading' });
    expect(panel.characterStatus.textContent).toContain('در حال آماده‌سازی');
    bus.emit(EVENTS.CHARACTER_ASSET_STATUS, { modelId: 'guard', status: 'fallback' });
    expect(panel.characterStatus.textContent).toContain('نمای جایگزین فعال');
    expect(panel.root.textContent).not.toContain('HTTP 503');
    expect(panel.root.textContent).not.toContain('GLTFLoader');
    expect(panel.retryCharactersButton.hidden).toBe(false);
    panel.retryCharactersButton.click();
    expect(onRetryCharacters).toHaveBeenCalledOnce();

    panel.dispose();
  });
});
