/**
 * Minimal synchronous event bus used to keep game logic, world and UI decoupled.
 * Logic never touches the DOM or Three.js directly: it emits events, other layers listen.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  on(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(handler);
    return () => this.off(type, handler);
  }

  once(type, handler) {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off(type, handler) {
    const set = this._listeners.get(type);
    if (!set) return false;
    const removed = set.delete(handler);
    if (set.size === 0) this._listeners.delete(type);
    return removed;
  }

  emit(type, payload) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    // Copy to be safe against listeners that unsubscribe inside the handler.
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[EventBus] listener for "${type}" failed:`, error);
      }
    }
  }

  clear() {
    this._listeners.clear();
  }

  get size() {
    let total = 0;
    for (const set of this._listeners.values()) total += set.size;
    return total;
  }
}

/** Canonical event names (typos become a load error instead of a silent bug). */
export const EVENTS = Object.freeze({
  TILE_TAP: 'tile:tap',
  WORLD_TAP: 'world:tap-intent',
  CAMERA_CHANGED: 'camera:changed',
  RESIZE: 'renderer:resize',
  QUALITY_CHANGED: 'quality:changed',
  CHARACTER_ASSET_STATUS: 'characters:asset-status',
  CHARACTER_PROFILE_SELECTED: 'characters:profile-selected',
  GRID_VISIBILITY: 'ui:grid-visibility',
  DEV_TOGGLE: 'ui:dev-toggle',
  CAMERA_RESET: 'ui:camera-reset',
  GAME_PAUSED: 'game:paused',
  WORLD_READY: 'world:ready',
  PERF_SAMPLE: 'perf:sample',
  CONTEXT_LOST: 'renderer:context-lost',
  CONTEXT_RESTORED: 'renderer:context-restored',
  ECONOMY_CHANGED: 'game:economy-changed',
  PLACEMENT_CHANGED: 'game:placement-changed',
  BUILDING_SELECTED: 'game:building-selected',
  BUILDING_ADDED: 'game:building-added',
  BUILDING_UPDATED: 'game:building-updated',
  BUILDING_REMOVED: 'game:building-removed',
  PLACEMENT_POINTER: 'game:placement-pointer',
  BUILD_QUEUE_CHANGED: 'game:build-queue-changed',
  JOB_FINISHED: 'game:job-finished',
  UI_TOAST: 'ui:toast',
  // --- phase 4: Quran learning layer ---
  QURAN_DATASET_READY: 'quran:dataset-ready',
  QURAN_LESSON_REQUESTED: 'quran:lesson-requested',
  QURAN_LESSON_STARTED: 'quran:lesson-started',
  QURAN_LESSON_STEP: 'quran:lesson-step',
  QURAN_LESSON_COMPLETED: 'quran:lesson-completed',
  QURAN_REVIEW_STARTED: 'quran:review-started',
  QURAN_REVIEW_COMPLETED: 'quran:review-completed',
  QURAN_REVIEW_DUE: 'quran:review-due',
  QURAN_REWARD_GRANTED: 'quran:reward-granted',
  QURAN_PANEL_OPENED: 'quran:panel-opened',
  QURAN_PANEL_CLOSED: 'quran:panel-closed',
  // --- phase 5: units, defence and battle mechanics ---
  ARMY_CHANGED: 'army:changed',
  BARRACKS_PANEL_REQUESTED: 'barracks:panel-requested',
  BATTLE_STARTED: 'battle:started',
  BATTLE_EVENTS: 'battle:events',
  BATTLE_PROGRESS: 'battle:progress',
  BATTLE_COMMAND: 'battle:command',
  BATTLE_TAP: 'battle:tap',
  BATTLE_ENDED: 'battle:ended',
  BATTLE_REWARD: 'battle:reward',
  BATTLE_REPLAY_STARTED: 'battle:replay-started',
  BATTLE_REPLAY_VERIFIED: 'battle:replay-verified',
  BATTLE_SESSION_CLOSED: 'battle:session-closed',
  STRUCTURE_DAMAGED: 'game:structure-damaged',
  STRUCTURE_REPAIRED: 'game:structure-repaired',
  // --- phase 6: story campaign (قصص) ---
  CAMPAIGN_CHANGED: 'campaign:changed',
  CAMPAIGN_PANEL_OPENED: 'campaign:panel-opened',
  CAMPAIGN_PANEL_CLOSED: 'campaign:panel-closed',
  MISSION_STARTED: 'campaign:mission-started',
  MISSION_PROGRESS: 'campaign:mission-progress',
  MISSION_ACTION: 'campaign:mission-action',
  MISSION_PLOT_TAP: 'campaign:mission-plot-tap',
  MISSION_FINISHED: 'campaign:mission-finished',
  MISSION_ABORTED: 'campaign:mission-aborted',
  MISSION_REWARD_GRANTED: 'campaign:mission-reward',
  // --- phase 7: FTUE, player meta and preferences ---
  SHOP_OPENED: 'ui:shop-opened',
  BUILDING_QUEUED: 'game:building-queued',
  RESOURCE_HARVESTED: 'game:resource-harvested',
  META_CHANGED: 'meta:changed',
  META_XP_AWARDED: 'meta:xp-awarded',
  META_LEVEL_UP: 'meta:level-up',
  META_ACHIEVEMENT_UNLOCKED: 'meta:achievement-unlocked',
  DAILY_MISSION_COMPLETED: 'meta:daily-mission-completed',
  FTUE_CHANGED: 'ftue:changed',
  FTUE_COMPLETED: 'ftue:completed',
  FTUE_SKIPPED: 'ftue:skipped',
  SETTINGS_OPENED: 'settings:opened',
  SETTINGS_CHANGED: 'settings:changed',
  META_PANEL_OPENED: 'meta:panel-opened',
  // --- phase 8: social / multiplayer (جماعت) ---
  SOCIAL_STATUS: 'social:status',
  SOCIAL_CHAT: 'social:chat',
  SOCIAL_PRESENCE: 'social:presence',
  SOCIAL_HELP: 'social:help',
  SOCIAL_EVENT: 'social:event',
  SOCIAL_LEDGER: 'social:ledger',
  SOCIAL_NOTICE: 'social:notice',
});
