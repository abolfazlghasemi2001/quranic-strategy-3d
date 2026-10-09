import { BattleSystem } from '../../game/battle/BattleSystem.js';
import { BattleView } from '../../world/battle/BattleView.js';
import { BattlePanel } from '../BattlePanel.js';
import { BarracksPanel } from '../BarracksPanel.js';
import { EVENTS } from '../../core/EventBus.js';
import unitsData from '../../data/units.json';
import battleData from '../../data/battle.json';
import { installArmy } from '../../game/barracks/ArmyFeature.js';

export function createBattleFeature(ctx) {
  const { config, game, bus, world, rig, buildings, buildingView, engine, hud } = ctx;
  installArmy(game); game.enableBattle(BattleSystem);
  const view = new BattleView({ parent: world.group, config, state: game.state, rig, buildings, buildingView, bus, battleData, unitsData, getBattle: () => game.battle, engine, seed: config.seed });
  view.setQuality(game.meta.settings); view.setReducedMotion(ctx.reducedMotion());
  const barracksPanel = new BarracksPanel({ config, bus, barracks: game.barracks, economy: game.economy, unitsData, onOpenCharacters: () => view.proceduralOnly ? Promise.resolve([]) : view.preloadCharacters(), onRetryCharacters: () => view.preloadCharacters({ retryFailed: true }) });
  const exit = () => { view.unmount(); hud.setBattleLive(false); engine.markShadowDirty?.(); };
  const battlePanel = new BattlePanel({
    config, bus, battle: game.battle, barracks: game.barracks, unitsData, view,
    onBattleStart: () => {
      buildings.cancelPlacement(); hud.toggleShop(false); hud.setBattleLive(true); view.mount(game.battle.sim);
      const town = game.battle.sim?.townCenter();
      view.focusCamera(town ? { x: (town.col + town.w / 2) * config.tileSize, z: (town.row + town.h / 2) * config.tileSize } : config.mapCenter);
      hud.toast(config.t('battle.startedToast')); engine.markShadowDirty?.();
    },
    onBattleExit: exit,
    onOpenBarracks: () => { buildings.cancelPlacement(); barracksPanel.show(); },
  });
  const off = bus.on(EVENTS.BATTLE_SESSION_CLOSED, exit);
  engine.addUpdatable(view, 40); engine.addUpdatable(view.characterSystem, 41);
  engine.addUpdatable(battlePanel, 96); engine.addUpdatable(barracksPanel, 97);
  return {
    view, battlePanel, barracksPanel,
    setSettings(settings, reduceMotion) { view.setQuality(settings); view.setReducedMotion(reduceMotion); },
    dispose() {
      off(); for (const item of [view, view.characterSystem, battlePanel, barracksPanel]) engine.removeUpdatable(item);
      battlePanel.dispose(); barracksPanel.dispose(); view.dispose(); hud.setBattleLive(false);
    },
  };
}
