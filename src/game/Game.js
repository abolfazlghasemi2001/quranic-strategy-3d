/** Eager compatibility composition for logic tests/embedders. The browser uses GameRuntime. */
import { GameRuntime } from './GameRuntime.js';
import { LearningSystem } from './quran/LearningSystem.js';
import { BattleSystem } from './battle/BattleSystem.js';
import { BarracksSystem } from './barracks/BarracksSystem.js';
import { SocialSystem } from './social/SocialSystem.js';
import unitsData from '../data/units.json';
import battleData from '../data/battle.json';
import { CampaignSystem } from './campaign/CampaignSystem.js';
import { normalizeMissions, validateMissions } from './campaign/MissionData.js';
export class Game extends GameRuntime {
  constructor(options) { super({ ...options, features: { LearningSystem, BattleSystem, BarracksSystem, SocialSystem, armyData: { unitsData, battleData }, CampaignSystem, normalizeMissions, validateMissions, ...(options.features || {}) } }); }
}
