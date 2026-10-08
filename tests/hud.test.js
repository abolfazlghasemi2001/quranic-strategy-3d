// @vitest-environment jsdom
/**
 * HUD redesign regression suite (phase 10).
 *
 * The HUD is pure DOM + event bus, so it can be driven headlessly here. These
 * tests pin the *contract* of the new mobile shell — the parts that FTUE, smoke
 * tests, DevPanel and the layout verifier (tools/hud-layout.mjs) all rely on:
 *
 *   1. five dock actions, in the documented RTL order, each ≥48 px by CSS
 *   2. the builders count is a badge on Construction (and stays on
 *      `hud.builderValue` / `hud.queueBadge` for existing tests)
 *   3. placement mode makes Construction inert instead of removing it
 *   4. no floating «راهنمای متن» label lives inside the HUD root any more
 *   5. resource chips render value + «/capacity» as separate, replaceable nodes
 *      (the capacity part is what CSS drops on narrow screens) — never "null"
 *   6. badges (study / army / social / battle / quest) toggle independently
 *   7. dispose() tears the HUD down completely (no leaked listeners)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { HUD } from '../src/ui/HUD.js';
import { EventBus, EVENTS } from '../src/core/EventBus.js';
import economyData from '../src/data/economy.json';
import buildingsData from '../src/data/buildings.json';

const config = {
  t: (key, fallback) => fallback ?? key,
  targets: { fps: 60 },
};

function makeEconomy() {
  return {
    data: economyData,
    costOf: () => ({}),
    secondsOf: () => 0,
    rateOf: () => 0,
    canAfford: () => true,
    speedupCost: () => 1,
    freeCapacity: () => 0,
    maxLevel: 5,
  };
}

function makeHarness() {
  const bus = new EventBus();
  const opened = [];
  const hud = new HUD({
    config,
    engine: { stats: {} },
    bus,
    monitor: { update: () => null },
    rig: {},
    buildings: {
      byId: new Map(),
      state: { entities: new Map() },
      placing: null,
      startPlacement: () => true,
      cancelPlacement: () => opened.push('cancel'),
      confirmPlacement: () => opened.push('confirm'),
      speedup: () => {},
      harvestSelected: () => {},
      upgradeSelected: () => {},
    },
    economy: makeEconomy(),
    queue: { jobs: [], maxJobs: 3, jobFor: () => null },
    game: null,
    learning: null,
    onOpenStudy: () => opened.push('study'),
    onOpenMissions: () => opened.push('missions'),
    onOpenSocial: () => opened.push('social'),
    onOpenSettings: () => opened.push('settings'),
    onOpenMeta: () => opened.push('report'),
    onOpenBarracks: () => opened.push('barracks'),
    onOpenBattle: () => opened.push('battle'),
    onOpenQuran: () => opened.push('quran'),
  });
  return { hud, bus, opened };
}

let harness;

beforeEach(() => {
  document.body.innerHTML = '';
  window.__opened = [];
  harness = makeHarness();
});

afterEach(() => {
  harness.hud.dispose();
});

describe('HUD shell: regions and action dock', () => {
  it('exposes the documented regions', () => {
    const { hud } = harness;
    const regions = [...hud.root.querySelectorAll('[data-hud-region]')].map((node) => node.dataset.hudRegion);
    for (const region of ['top', 'dock', 'bottom', 'panels', 'toast']) {
      expect(regions, `missing data-hud-region="${region}" (got ${regions.join(',')})`).toContain(region);
    }
    // status only, action dock, and the panels that stack above it
    expect(hud.root.classList.contains('game-hud')).toBe(true);
    expect(hud.root.querySelector('.hud-topbar').contains(hud.resourcesView)).toBe(true);
    expect(hud.root.querySelector('.hud-bottom').contains(hud.dockActions)).toBe(true);
    expect(hud.root.querySelector('.hud-panels').contains(hud.queuePanel)).toBe(true);
  });

  it('has exactly five dock actions in RTL order: Construction … Report card', () => {
    const actions = [...harness.hud.dockActions.querySelectorAll('.hud-action')];
    expect(actions.map((node) => node.dataset.hudAction)).toEqual(['build', 'study', 'missions', 'community', 'report']);
    // DOM order == visual order in RTL: Construction is the inline-start item
    expect(actions[0]).toBe(harness.hud.shopButton);
    expect(actions[4]).toBe(harness.hud.reportButton);
    for (const action of actions) {
      expect(action.querySelector('.hud-action__icon')).toBeTruthy();
      expect(action.querySelector('.ui-btn__label').textContent.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the settings gear in the status bar with an accessible label', () => {
    const { hud } = harness;
    expect(hud.topBar.contains(hud.settingsButton)).toBe(true);
    expect(hud.settingsButton.getAttribute('aria-label')).toBe('تنظیمات');
    hud.settingsButton.click();
    expect(window.__opened).toBeDefined();
    expect(harness.opened).toContain('settings');
  });

  it('never renders the floating «راهنمای متن» map label inside the HUD', () => {
    const { hud } = harness;
    expect(hud.root.querySelector('.quran-policy-btn')).toBeNull();
    // …but the control still exists for the profile panel's action grid
    expect(hud.policyButton.classList.contains('quran-policy-btn')).toBe(true);
    hud.policyButton.click();
    expect(harness.opened).toContain('quran');
  });
});

describe('HUD state rendering', () => {
  const economyState = (overrides = {}) => ({
    resources: { rizq: 612, nur: 384, hekmat: 205, gohar: 20 },
    capacity: { rizq: 800, nur: 600, hekmat: 400 },
    cityLevel: 3,
    builders: { free: 1, total: 2 },
    ...overrides,
  });

  it('renders the build queue change as the Construction badge and keeps the builder values in sync', () => {
    const { hud, bus } = harness;
    bus.emit(EVENTS.ECONOMY_CHANGED, economyState());
    expect(hud.buildersBadge.textContent).toBe('۱/۲');
    expect(hud.builderValue.textContent).toBe('۱/۲'); // legacy hook used by smoke tests
    expect(hud.shopButton.classList.contains('is-busy')).toBe(true);
    expect(hud.shopButton.getAttribute('aria-label')).toContain('۱/۲');

    bus.emit(EVENTS.BUILD_QUEUE_CHANGED, { jobs: [], free: 2, total: 2 });
    expect(hud.buildersBadge.textContent).toBe('۲/۲');
    expect(hud.queueBadge.textContent).toBe('۲/۲');
    expect(hud.shopButton.classList.contains('is-busy')).toBe(false);
  });

  it('renders amounts with a separate capacity node and never the text "null"', () => {
    const { hud, bus } = harness;
    bus.emit(EVENTS.ECONOMY_CHANGED, economyState());
    for (const key of ['rizq', 'nur', 'hekmat']) {
      const chip = hud.chips[key];
      expect(chip.querySelector('.game-resource__value')).toBeTruthy();
      expect(chip.querySelector('.game-resource__cap')).toBeTruthy();
    }
    // gohar has no storage cap (economy.json: stored:false) → no cap node at all
    expect(hud.chips.gohar.querySelector('.game-resource__cap')).toBeNull();
    expect(hud.chips.rizq.querySelector('b').textContent).toBe('۶۱۲/۸۰۰');
    expect(hud.chips.gohar.querySelector('b').textContent).toBe('۲۰');
    expect(hud.root.textContent).not.toContain('null');
    // the full reading is always available to assistive tech
    expect(hud.chips.rizq.title).toContain('۶۱۲');
    expect(hud.chips.rizq.title).toContain('۸۰۰');
  });

  it('marks full storages and reads the level into the avatar badge', () => {
    const { hud, bus } = harness;
    bus.emit(EVENTS.ECONOMY_CHANGED, economyState({
      resources: { rizq: 800, nur: 10, hekmat: 10, gohar: 1 },
    }));
    expect(hud.chips.rizq.classList.contains('is-full')).toBe(true);
    expect(hud.chips.nur.classList.contains('is-full')).toBe(false);
    expect(hud.levelValue.textContent).toBe('۳');
    expect(hud.avatarLevel.textContent).toBe('۳');
  });

  it('makes Construction inert (not hidden) during placement and shows the confirm/cancel bar', () => {
    const { hud, bus } = harness;
    const def = buildingsData.buildings[0];
    bus.emit(EVENTS.PLACEMENT_CHANGED, { active: true, def, valid: true });
    expect(hud.placementBar.classList.contains('is-hidden')).toBe(false);
    expect(hud.shopButton.classList.contains('is-hidden')).toBe(false);
    expect(hud.shopButton.disabled).toBe(true);
    expect(hud.confirmButton.disabled).toBe(false);

    bus.emit(EVENTS.PLACEMENT_CHANGED, { active: false, def, valid: false });
    expect(hud.placementBar.classList.contains('is-hidden')).toBe(true);
    expect(hud.shopButton.disabled).toBe(false);
  });

  it('keeps the badges of the secondary entry points independent', () => {
    const { hud, bus } = harness;
    expect(hud.studyBadge.classList.contains('is-hidden')).toBe(true);
    bus.emit(EVENTS.QURAN_REVIEW_DUE, { dueCount: 4, learned: 10 });
    expect(hud.studyBadge.textContent).toBe('۴');
    expect(hud.studyBadge.classList.contains('is-hidden')).toBe(false);
    expect(hud.studyButton.classList.contains('is-alert')).toBe(true);

    bus.emit(EVENTS.ARMY_CHANGED, { total: 6, used: 6, capacity: 12 });
    expect(hud.armyBadge.textContent).toBe('۶');
    expect(hud.battleBadge.classList.contains('is-hidden')).toBe(true);
    bus.emit(EVENTS.BATTLE_STARTED, {});
    expect(hud.battleBadge.classList.contains('is-hidden')).toBe(false);
  });

  it('toasts through the toast lane above the panels', () => {
    const { hud } = harness;
    expect(hud.root.querySelector('.hud-toaster').contains(hud.toastNode)).toBe(true);
    hud.toast('سلام');
    expect(hud.toastNode.textContent).toBe('سلام');
    expect(hud.toastNode.classList.contains('is-visible')).toBe(true);
  });
});

describe('HUD lifecycle', () => {
  it('removes the whole tree and unsubscribes on dispose', () => {
    const { hud, bus } = harness;
    expect(document.querySelector('.game-hud')).toBeTruthy();
    const listenersBefore = [...bus._listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(listenersBefore).toBeGreaterThan(0);

    hud.dispose();
    expect(document.querySelector('.game-hud')).toBeNull();
    const listenersAfter = [...bus._listeners.values()].reduce((sum, set) => sum + set.size, 0);
    expect(listenersAfter).toBe(0);
    // events after dispose must not throw (listeners gone, DOM detached)
    expect(() => bus.emit(EVENTS.ECONOMY_CHANGED, {
      resources: {}, capacity: {}, cityLevel: 1, builders: { free: 0, total: 0 },
    })).not.toThrow();
  });
});
