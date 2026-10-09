/** Eager configuration compatibility; browser composition uses ConfigRuntime. */
import { ConfigRuntime } from './ConfigRuntime.js';
import campaign from '../data/campaign.json';
import missions from '../data/missions.json';
import strings from '../data/strings.fa.json';
export { detectQualityTier, QUALITY_TIERS } from './ConfigRuntime.js';
export class Config extends ConfigRuntime {
  constructor(options = {}) { super({ ...options, content: { campaign, missions, strings, ...(options.content || {}) } }); }
}
