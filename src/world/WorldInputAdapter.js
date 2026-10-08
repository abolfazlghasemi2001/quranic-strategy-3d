/**
 * WorldInputAdapter — converts screen-space taps into serializable world intents.
 * The gameplay layer receives coordinates/cells only; raycasting stays in world/core.
 */
import { EVENTS } from '../core/EventBus.js';

export class WorldInputAdapter {
  constructor({ config, world, rig, input, bus }) {
    Object.assign(this, { config, world, rig, input, bus });
    this._tapHandler = (payload) => this.handleTap(payload);
    this.input.onTap = this._tapHandler;
  }

  handleTap(payload = {}) {
    const viewport = payload.viewport || {
      width: (typeof window !== 'undefined' && window.innerWidth) || this.input.target?.clientWidth || 1,
      height: (typeof window !== 'undefined' && window.innerHeight) || this.input.target?.clientHeight || 1,
    };
    const point = this.rig.screenToGround(payload.clientX ?? payload.x, payload.clientY ?? payload.y, viewport);
    if (!point) return null;

    const inside = this.world.isInsideMap(point.x, point.z);
    const cell = this.world.getCellAt(point.x, point.z);
    const intent = {
      x: point.x,
      z: point.z,
      cell,
      inside,
      pointerType: payload.pointerType || 'unknown',
      at: Date.now(),
    };
    this.bus.emit(EVENTS.WORLD_TAP, intent);
    return intent;
  }

  dispose() {
    if (this.input.onTap === this._tapHandler) this.input.onTap = null;
  }
}
