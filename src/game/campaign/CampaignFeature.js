/** Lazy pure-logic factory. Saved active missions install before bootstrap; new cities on interaction. */
import campaign from '../../data/campaign.json';
import missions from '../../data/missions.json';
import { CampaignSystem } from './CampaignSystem.js';
import { normalizeMissions, validateMissions } from './MissionData.js';
export function installCampaign(game) {
  game.config.installCampaignData({ campaign, missions });
  return game.enableCampaign({ CampaignSystem, normalizeMissions, validateMissions });
}
