/**
 * Game — game logic layer (no Three.js, no DOM).
 *
 * Responsibilities for phase 1:
 *   - fixed timestep simulation clock (logic runs at `gameplay.logicHz`)
 *   - translate screen taps into tile coordinates through the camera rig
 *   - emit gameplay events for the render/UI layers
 *
 * Decoupling rule: the game never draws and never touches the DOM. It only
 * reads input intents and emits events.
 */
import { GameState } from './GameState.js';
import { EVENTS } from '../core/EventBus.js';

export class Game {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/OrbitCameraRig.js').OrbitCameraRig} options.rig
   * @param {import('../core/InputManager.js').InputManager} options.input
   * @param {import('../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ config, world, rig, input, bus = null }) {
    this.config = config;
    this.world = world;
    this.rig = rig;
    this.input = input;
    this.bus = bus;

    this.state = new GameState({ config });
    this.fixedStep = 1 / (config.gameplay.logicHz || 15);
    this.maxStepsPerFrame = config.gameplay.maxStepsPerFrame || 5;
    this._accumulator = 0;

    this.onTap = (payload) => this.handleTap(payload);
    this.input.onTap = this.onTap;

    if (bus) {
      this._unsubscribers = [
        bus.on(EVENTS.GAME_PAUSED, ({ paused }) => {
          this.state.paused = paused;
          this._accumulator = 0;
        }),
      ];
    } else {
      this._unsubscribers = [];
    }
  }

  /** Variable rate update: currently only keeps the accumulator fed. */
  update(dt) {
    if (this.state.paused) return;

    this._accumulator += dt;
    let steps = 0;
    while (this._accumulator >= this.fixedStep && steps < this.maxStepsPerFrame) {
      this.fixedUpdate(this.fixedStep);
      this._accumulator -= this.fixedStep;
      steps += 1;
    }
    // Do not let a long stall queue up an unbounded backlog of logic steps.
    if (this._accumulator > this.fixedStep * this.maxStepsPerFrame) this._accumulator = 0;
  }

  /** Deterministic simulation tick (15 Hz by default). */
  fixedUpdate(step) {
    this.state.tick += 1;
    this.state.elapsed += step;
  }

  /**
   * Screen tap -> world point -> tile.
   * Emits `tile:tap` with both the world position and the tile coordinates so
   * gameplay (phase 2: placing buildings) can react without knowing about pixels.
   */
  handleTap(payload) {
    const viewport = payload && payload.viewport ? payload.viewport : { width: window.innerWidth, height: window.innerHeight };
    const point = this.rig.screenToGround(payload.clientX ?? payload.x, payload.clientY ?? payload.y, viewport);
    if (!point) return null;

    const inside = this.world.isInsideMap(point.x, point.z);
    const cell = this.world.getCellAt(point.x, point.z);

    this.state.lastTap = { x: point.x, z: point.z, cell, inside, time: this.state.elapsed };
    this.state.tapCount += 1;

    if (inside) {
      this._haptic();
      if (this.bus) {
        this.bus.emit(EVENTS.TILE_TAP, {
          x: point.x,
          z: point.z,
          col: cell ? cell.col : null,
          row: cell ? cell.row : null,
          source: payload.pointerType || 'unknown',
        });
      }
    }
    return this.state.lastTap;
  }

  _haptic() {
    if (!this.config.gameplay.haptics.enabled) return;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    try {
      navigator.vibrate(this.config.gameplay.haptics.tapMs || 8);
    } catch {
      /* vibration is optional */
    }
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
    if (this.input) this.input.onTap = null;
  }
}
