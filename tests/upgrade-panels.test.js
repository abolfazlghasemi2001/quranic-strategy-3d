// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/core/Config.js';
import { EventBus } from '../src/core/EventBus.js';
import { Game } from '../src/game/Game.js';
import { BattlePanel } from '../src/ui/BattlePanel.js';
import { BarracksPanel } from '../src/ui/BarracksPanel.js';
import units from '../src/data/units.json';
let game, bus, config, panels;
beforeEach(() => {
  config = new Config({ search: '?quality=low' }); bus = new EventBus();
  game = new Game({ config, bus }); game.bootstrap(); panels = [];
});
afterEach(() => { panels.forEach((panel) => panel.dispose()); game.dispose(); document.body.replaceChildren(); });
const makePanel = () => {
  const panel = new BattlePanel({ config, bus, battle: game.battle, barracks: game.barracks, unitsData: units });
  panels.push(panel); return panel;
};
describe('BattlePanel smoke regressions', () => {
  it('keeps the withdrawal report visible and lets the player close the session', () => {
    const panel = makePanel(); panel.show(); panel.startBattle(); panel.withdrawButton.click(); game.battle.update(0.1);
    expect(panel.visible).toBe(true);
    expect(panel.resultBox.classList.contains('is-hidden')).toBe(false);
    expect(panel.liveBox.classList.contains('is-hidden')).toBe(true);
    panel.closeSession(); expect(game.battle.active).toBe(false);
    expect(panel.visible).toBe(false);
  });
  it('does not display the live controls over a finished replay report', () => {
    const panel = makePanel(); panel.show(); panel.startBattle(); game.battle.withdraw(); game.battle.update(0.1);
    game.battle.closeSession();
    expect(game.battle.startReplay(0).ok).toBe(true);
    game.battle.sim.runToEnd(); game.battle.update(0.1);
    expect(panel.resultBox.classList.contains('is-hidden')).toBe(false);
    expect(panel.liveBox.classList.contains('is-hidden')).toBe(true);
  });
  it('replays directly from its own result button without a manual session close', () => {
    const panel = makePanel(); panel.show(); panel.startBattle(); game.battle.withdraw(); game.battle.update(0.1);
    panel.replayButton.click(); expect(game.battle.mode).toBe('replay'); expect(panel.visible).toBe(true);
  });
  it('keeps a valid replay verified at completion, not just on initial verification', () => {
    const panel = makePanel(); panel.show(); panel.startBattle(); game.battle.withdraw(); game.battle.update(0.1);
    game.battle.closeSession(); expect(game.battle.startReplay(0).ok).toBe(true);
    game.battle.sim.runToEnd(); game.battle.update(0.1);
    expect(game.battle.lastVerification.ok).toBe(true);
  });
  it('unsubscribes when disposed and renders hostile encounter text literally', () => {
    const panel = makePanel(); panel.encounters[0].name = '<img src=x onerror=alert(1)>';
    panel.show(); expect(panel.root.querySelector('img')).toBeNull();
    const count = bus.size; panel.dispose(); expect(bus.size).toBeLessThan(count);
  });
});
describe('BarracksPanel smoke', () => {
  it('opens, starts deterministic training, closes and reopens with queue intact', () => {
    const barracks = game.state.createEntity({ type: 'barracks', col: 2, row: 2, size: [3, 3], level: 1 });
    game.state.resources.rizq = 1000; game.state.resources.nur = 1000;
    const loader = vi.fn(async () => new Map());
    const panel = new BarracksPanel({ config, bus, barracks: game.barracks, economy: game.economy, unitsData: units, onOpenCharacters: loader });
    panels.push(panel); panel.show();
    expect(loader).toHaveBeenCalledOnce();
    expect(game.barracks.startTraining('guard', Date.now()).ok).toBe(true);
    panel.render(); expect(game.state.army.training).toHaveLength(1);
    panel.hide(); panel.show(); expect(game.state.army.training).toHaveLength(1);
    expect(panel.root.querySelectorAll('.barracks-unit').length).toBe(units.units.length);
    expect(barracks.status).toBe('ready');
  });
});
