/** Saved training installs before bootstrap; fresh cities on opening battle/barracks. */
import { BarracksSystem } from './BarracksSystem.js';
import unitsData from '../../data/units.json';
import battleData from '../../data/battle.json';
export function installArmy(game) { return game.enableArmy(BarracksSystem, { unitsData, battleData }); }
