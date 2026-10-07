/**
 * InputManager — turns raw pointer/wheel/keyboard events into *intents*.
 *
 * Intent contract (consumed once per frame by the camera rig):
 *   pan      : {x, y}   drag distance in CSS pixels (content follows the finger)
 *   zoom     : number   positive = zoom in  (pinch ratio in log space, or wheel steps)
 *   rotatePx : number   horizontal drag in pixels for explicit rotate gestures
 *   twist    : number   rotation in radians from a two finger twist
 *   keys     : Set      currently pressed KeyboardEvent.code values
 *
 * Mobile first (Clash of Clans style):
 *   one finger        -> move the camera over the map
 *   two fingers       -> move + pinch zoom + twist rotate
 * Desktop:
 *   left drag         -> move,  wheel -> zoom,  right/middle or Shift+drag -> rotate
 *   WASD / arrows     -> move
 */
export class InputManager {
  constructor(target, { config = null, onAction = null, onTap = null } = {}) {
    this.target = target;
    this.config = config;
    this.onAction = onAction;
    this.onTap = onTap;

    this.pan = { x: 0, y: 0 };
    this.zoom = 0;
    this.rotatePx = 0;
    this.twist = 0;
    this.isPanning = false;
    this.pointerCount = 0;
    this.keys = new Set();
    this.enabled = true;

    this.tapSlop =
      (config ? config.gameplay.tap.maxDistancePx : 16) || 16;
    this.tapDuration =
      (config ? config.gameplay.tap.maxDurationMs : 450) || 450;

    this._pointers = new Map();
    this._base = { count: 0, cx: 0, cy: 0, dist: 0, angle: 0 };
    this._disposed = false;

    this._handlers = {
      pointerdown: (event) => this._onPointerDown(event),
      pointermove: (event) => this._onPointerMove(event),
      pointerup: (event) => this._onPointerUp(event),
      pointercancel: (event) => this._onPointerUp(event),
      wheel: (event) => this._onWheel(event),
      keydown: (event) => this._onKeyDown(event),
      keyup: (event) => this._onKeyUp(event),
      contextmenu: (event) => event.preventDefault(),
      blur: () => this._clearPointers(),
    };

    this._attach();
  }

  _attach() {
    const target = this.target;
    target.style.touchAction = 'none';
    target.addEventListener('pointerdown', this._handlers.pointerdown, { passive: false });
    target.addEventListener('pointermove', this._handlers.pointermove, { passive: false });
    window.addEventListener('pointerup', this._handlers.pointerup, { passive: false });
    window.addEventListener('pointercancel', this._handlers.pointercancel, { passive: false });
    target.addEventListener('wheel', this._handlers.wheel, { passive: false });
    target.addEventListener('contextmenu', this._handlers.contextmenu);
    window.addEventListener('keydown', this._handlers.keydown);
    window.addEventListener('keyup', this._handlers.keyup);
    window.addEventListener('blur', this._handlers.blur);
  }

  /* ------------------------------------------------------------ internals */

  _collect() {
    let sumX = 0;
    let sumY = 0;
    let count = 0;
    for (const pointer of this._pointers.values()) {
      sumX += pointer.x;
      sumY += pointer.y;
      count += 1;
    }
    const cx = count ? sumX / count : 0;
    const cy = count ? sumY / count : 0;

    let dist = 0;
    let angle = 0;
    if (count >= 2) {
      const [a, b] = Array.from(this._pointers.values());
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      dist = Math.hypot(dx, dy);
      angle = Math.atan2(dy, dx);
    }
    return { count, cx, cy, dist, angle };
  }

  _rebaseline() {
    this._base = this._collect();
    this.pointerCount = this._base.count;
    this.isPanning = this._base.count > 0;
  }

  _clearPointers() {
    this._pointers.clear();
    this._rebaseline();
    this.isPanning = false;
    this.keys.clear();
  }

  _onPointerDown(event) {
    if (!this.enabled) return;
    event.preventDefault();
    this._pointers.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      startTime: performance.now(),
      button: event.button,
      pointerType: event.pointerType,
      moved: false,
    });
    try {
      this.target.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best effort (Safari occasionally throws) */
    }
    this._rebaseline();
  }

  _onPointerMove(event) {
    if (!this.enabled) return;
    const pointer = this._pointers.get(event.pointerId);
    if (!pointer) return;
    event.preventDefault();

    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (!pointer.moved && Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > this.tapSlop) {
      pointer.moved = true;
    }

    const state = this._collect();
    const dx = state.cx - this._base.cx;
    const dy = state.cy - this._base.cy;

    if (state.count >= 2) {
      // move + pinch + twist
      this.pan.x += dx;
      this.pan.y += dy;
      if (this._base.dist > 8 && state.dist > 8) {
        const sensitivity = this.config ? this.config.camera.pinchZoomSensitivity : 1;
        this.zoom += Math.log(state.dist / this._base.dist) * sensitivity;
        this.twist += this._shortestAngle(state.angle - this._base.angle);
      }
      this.isPanning = true;
    } else if (state.count === 1) {
      const rotateMode =
        pointer.pointerType === 'mouse' && (pointer.button === 1 || pointer.button === 2 || event.shiftKey);
      if (rotateMode) this.rotatePx += dx;
      else this.pan.x += dx;
      if (!rotateMode) this.pan.y += dy;
      this.isPanning = true;
    }

    this._base = state;
    this.pointerCount = state.count;
  }

  _onPointerUp(event) {
    const pointer = this._pointers.get(event.pointerId);
    if (!pointer) return;
    this._pointers.delete(event.pointerId);

    const duration = performance.now() - pointer.startTime;
    const wasTap = !pointer.moved && duration <= this.tapDuration && pointer.pointerType !== undefined;
    this._rebaseline();
    this.isPanning = this.pointerCount > 0;

    if (wasTap && this._pointers.size === 0) {
      const payload = {
        type: 'tap',
        x: pointer.x,
        y: pointer.y,
        clientX: pointer.x,
        clientY: pointer.y,
        pointerType: pointer.pointerType,
        duration,
      };
      if (this.onTap) this.onTap(payload);
      if (this.onAction) this.onAction(payload);
    }
  }

  _onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    const step = this.config ? this.config.camera.wheelZoomStep : 0.0016;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1;
    // scrolling down / away => zoom out (negative intent)
    this.zoom += -event.deltaY * unit * step;
  }

  _onKeyDown(event) {
    if (!this.enabled) return;
    this.keys.add(event.code);
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(event.code)) {
      event.preventDefault();
    }
  }

  _onKeyUp(event) {
    this.keys.delete(event.code);
  }

  _shortestAngle(angle) {
    let a = angle;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /* -------------------------------------------------------------- public */

  /** Read and reset the accumulated intents (called once per frame by the camera rig). */
  consume() {
    const out = {
      pan: { x: this.pan.x, y: this.pan.y },
      zoom: this.zoom,
      rotatePx: this.rotatePx,
      twist: this.twist,
      isPanning: this.isPanning,
      pointerCount: this.pointerCount,
      keys: this.keys,
    };
    this.pan.x = 0;
    this.pan.y = 0;
    this.zoom = 0;
    this.rotatePx = 0;
    this.twist = 0;
    return out;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this._clearPointers();
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const target = this.target;
    target.removeEventListener('pointerdown', this._handlers.pointerdown);
    target.removeEventListener('pointermove', this._handlers.pointermove);
    window.removeEventListener('pointerup', this._handlers.pointerup);
    window.removeEventListener('pointercancel', this._handlers.pointercancel);
    target.removeEventListener('wheel', this._handlers.wheel);
    target.removeEventListener('contextmenu', this._handlers.contextmenu);
    window.removeEventListener('keydown', this._handlers.keydown);
    window.removeEventListener('keyup', this._handlers.keyup);
    window.removeEventListener('blur', this._handlers.blur);
    this._pointers.clear();
  }
}
