/**
 * GameState — plain, serialisable game data.
 * Phase 1 only tracks the clock and the last tap; later phases add the economy,
 * buildings and quests here without touching the render layer.
 */
export class GameState {
  constructor({ config }) {
    this.config = config;
    this.version = 1;
    this.tick = 0;
    this.elapsed = 0;
    this.paused = false;
    this.lastTap = null;
    this.tapCount = 0;
    /** Reserved for phase 2+ (buildings, resources, quests). */
    this.entities = new Map();
  }

  reset() {
    this.tick = 0;
    this.elapsed = 0;
    this.lastTap = null;
    this.tapCount = 0;
    this.entities.clear();
  }

  toJSON() {
    return {
      version: this.version,
      tick: this.tick,
      elapsed: this.elapsed,
      tapCount: this.tapCount,
      lastTap: this.lastTap,
    };
  }
}
