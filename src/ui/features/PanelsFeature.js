import { SettingsPanel } from '../SettingsPanel.js';
import { MetaPanel } from '../MetaPanel.js';
import { JamaatPanel } from '../social/JamaatPanel.js';
import { MissionPanel } from '../campaign/MissionPanel.js';
import { MissionZone } from '../../world/MissionZone.js';
import { DevPanel } from '../DevPanel.js';
import { installCampaign } from '../../game/campaign/CampaignFeature.js';
import { SocialSystem } from '../../game/social/SocialSystem.js';

export function createPanelFeature(key, ctx) {
  const { config, bus, game, engine, hud, buildings, world, rig, monitor, saveNow } = ctx;
  const common = { config, bus, metaSystem: game.meta, parent: document.body, onReplay: () => game.meta.replayTutorial() };
  let panel, zone;
  if (key === 'settings') panel = new SettingsPanel({ ...common, onPause: () => engine.pause('settings'), onResume: () => engine.resume('settings') });
  if (key === 'meta') {
    panel = new MetaPanel({ ...common, onPause: () => engine.pause('meta-panel'), onResume: () => engine.resume('meta-panel') });
    panel.setExtraActions([hud.armyButton, hud.battleButton, hud.policyButton]);
  }
  if (key === 'social') { if (!game.social) { game.enableSocial(SocialSystem); engine.addUpdatable(game.social, 31); } panel = new JamaatPanel({ config, bus, social: game.social, game, parent: document.body }); engine.addUpdatable(panel, 99); }
  if (key === 'missions') {
    installCampaign(game);
    zone = new MissionZone({ config, parent: world.group, bus, engine, getSnapshot: () => game.campaign?.snapshot() || null });
    zone.setMissions(game.missions.byId); engine.addUpdatable(zone, 45);
    panel = new MissionPanel({ config, bus, campaign: game.campaign, economy: game.economy, dataset: ctx.quran.dataset, parent: document.body, onOpenLesson: () => { panel.close(); buildings.cancelPlacement(); ctx.openStudy(); } });
    engine.addUpdatable(panel, 98);
  }
  if (key === 'debug') {
    panel = new DevPanel({ config, engine, bus, monitor, rig, world, characters: ctx.features.get('battle')?.view.characterSystem, onSaveNow: () => { saveNow(); hud.toast(config.t('dev.saved')); }, onSimulateOffline: () => { game.simulateOffline(3600000); saveNow(); hud.toast(config.t('dev.offlineSimulated')); } });
    engine.addUpdatable(panel, 110);
  }
  return { panel, zone, dispose() { engine.removeUpdatable(panel); if (zone) engine.removeUpdatable(zone); panel.dispose(); zone?.dispose(); } };
}
