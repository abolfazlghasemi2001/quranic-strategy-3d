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
  CAMERA_CHANGED: 'camera:changed',
  RESIZE: 'renderer:resize',
  QUALITY_CHANGED: 'quality:changed',
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
  BUILD_QUEUE_CHANGED: 'game:build-queue-changed',
  JOB_FINISHED: 'game:job-finished',
  UI_TOAST: 'ui:toast',
});
