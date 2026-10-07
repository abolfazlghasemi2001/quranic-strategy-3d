/**
 * OrbitCameraRig — Clash of Clans style camera.
 *
 *   - fixed pitch (the data decides the angle, ~52 degrees by default)
 *   - yaw rotation around the focus point
 *   - panning locked to the ground plane (dragged content follows the finger)
 *   - zoom = distance to the focus point, clamped to the data driven limits
 *   - inertia + exponential smoothing, frame rate independent
 *   - the focus point can never leave the map bounds
 */
import * as THREE from 'three';
import { clamp, damp, degToRad, wrapAngle } from './MathUtils.js';

export class OrbitCameraRig {
  constructor({ camera, config, input, bus = null }) {
    this.camera = camera;
    this.config = config;
    this.input = input;
    this.bus = bus;

    const cam = config.camera;
    this.pitch = degToRad(cam.pitchDeg);
    this.minDistance = cam.minDistance;
    this.maxDistance = cam.maxDistance;

    this._defaults = {
      yaw: degToRad(cam.yawDeg),
      distance: cam.distance,
      focus: new THREE.Vector3(config.startFocus.x, 0, config.startFocus.z),
    };

    this.yaw = this._defaults.yaw;
    this.distance = this._defaults.distance;
    this.targetDistance = this._defaults.distance;
    this.focus = this._defaults.focus.clone();
    this.targetFocus = this._defaults.focus.clone();

    this.bounds = config.focusBounds;
    this._panVelocity = new THREE.Vector3();
    this._instVelocity = new THREE.Vector3();

    this._up = new THREE.Vector3(0, 1, 0);
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._offset = new THREE.Vector3();
    this._delta = new THREE.Vector3();
    this._move = new THREE.Vector3();

    this._raycaster = new THREE.Raycaster();
    this._groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hitPoint = new THREE.Vector3();
    this._ndc = new THREE.Vector2();

    this.unitsPerPixel = 1;
    this.applyTransform();
  }

  /** World units covered by one vertical CSS pixel at the focus distance. */
  _computeUnitsPerPixel(viewportHeight) {
    const halfFov = degToRad(this.camera.fov * 0.5);
    return (2 * this.targetDistance * Math.tan(halfFov)) / Math.max(1, viewportHeight);
  }

  update(dt, engine) {
    const cam = this.config.camera;
    const intent = this.input.consume();
    const height = engine ? engine.viewport.height : window.innerHeight;

    this.unitsPerPixel = this._computeUnitsPerPixel(height);
    const upp = this.unitsPerPixel;

    // ---- basis vectors on the ground plane -------------------------------
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    this._right.crossVectors(this._forward, this._up).normalize();

    // ---- rotation --------------------------------------------------------
    if (intent.rotatePx !== 0) this.yaw += intent.rotatePx * degToRad(cam.rotateDegPerPixel);
    if (intent.twist !== 0) this.yaw += intent.twist;
    this.yaw = wrapAngle(this.yaw);

    // ---- keyboard pan ----------------------------------------------------
    let keyRight = 0;
    let keyForward = 0;
    const keys = intent.keys;
    if (keys.has('ArrowLeft') || keys.has('KeyA')) keyRight -= 1;
    if (keys.has('ArrowRight') || keys.has('KeyD')) keyRight += 1;
    if (keys.has('ArrowUp') || keys.has('KeyW')) keyForward += 1;
    if (keys.has('ArrowDown') || keys.has('KeyS')) keyForward -= 1;
    const keyboardActive = keyRight !== 0 || keyForward !== 0;

    if (keyboardActive) {
      const speed = cam.keyboardPanSpeed * dt;
      this.targetFocus.addScaledVector(this._right, keyRight * speed);
      this.targetFocus.addScaledVector(this._forward, keyForward * speed);
      this._panVelocity.set(0, 0, 0);
    }

    // ---- drag pan + velocity tracking ------------------------------------
    if (intent.pan.x !== 0 || intent.pan.y !== 0) {
      // content follows the finger: drag right => camera moves left, drag down => camera moves forward
      this._delta
        .copy(this._right)
        .multiplyScalar(-intent.pan.x * upp)
        .addScaledVector(this._forward, intent.pan.y * upp);
      this.targetFocus.add(this._delta);

      const invDt = dt > 1e-4 ? 1 / dt : 0;
      this._instVelocity.copy(this._delta).multiplyScalar(invDt);
      const smoothing = cam.inertia.smoothing;
      this._panVelocity.lerp(this._instVelocity, smoothing);
    }

    // ---- inertia ---------------------------------------------------------
    const inertiaActive = !intent.isPanning && !keyboardActive;
    if (inertiaActive) {
      const speed = this._panVelocity.length();
      if (speed > cam.inertia.minSpeed) {
        const step = Math.min(speed, cam.inertia.maxSpeed) * dt;
        this._move.copy(this._panVelocity).multiplyScalar(step / speed);
        this.targetFocus.add(this._move);
        this._panVelocity.multiplyScalar(Math.exp(-cam.inertia.decay * dt));
      } else {
        this._panVelocity.set(0, 0, 0);
      }
    }

    // ---- zoom ------------------------------------------------------------
    if (intent.zoom !== 0) {
      this.targetDistance = clamp(this.targetDistance * Math.exp(-intent.zoom), this.minDistance, this.maxDistance);
    }
    this.distance = damp(this.distance, this.targetDistance, cam.zoomSmoothing, dt);

    // ---- clamp focus to the map, then smooth ------------------------------
    this.targetFocus.x = clamp(this.targetFocus.x, this.bounds.minX, this.bounds.maxX);
    this.targetFocus.z = clamp(this.targetFocus.z, this.bounds.minZ, this.bounds.maxZ);

    this.focus.x = damp(this.focus.x, this.targetFocus.x, cam.panSmoothing, dt);
    this.focus.z = damp(this.focus.z, this.targetFocus.z, cam.panSmoothing, dt);
    this.focus.y = 0;

    this.applyTransform();
  }

  applyTransform() {
    const cosPitch = Math.cos(this.pitch);
    this._offset
      .set(Math.sin(this.yaw) * cosPitch, Math.sin(this.pitch), Math.cos(this.yaw) * cosPitch)
      .multiplyScalar(this.distance);

    this.camera.position.copy(this.focus).add(this._offset);
    this.camera.lookAt(this.focus);
  }

  /** Reset yaw / zoom / position to the values defined in the data files. */
  reset() {
    this.yaw = this._defaults.yaw;
    this.distance = this._defaults.distance;
    this.targetDistance = this._defaults.distance;
    this.focus.copy(this._defaults.focus);
    this.targetFocus.copy(this._defaults.focus);
    this._panVelocity.set(0, 0, 0);
    this.applyTransform();
  }

  /** Smoothly move the focus somewhere (used by later phases: jumping to a district). */
  setFocus(x, z, { immediate = false } = {}) {
    this.targetFocus.set(clamp(x, this.bounds.minX, this.bounds.maxX), 0, clamp(z, this.bounds.minZ, this.bounds.maxZ));
    if (immediate) {
      this.focus.copy(this.targetFocus);
      this.applyTransform();
    }
  }

  setDistance(distance, { immediate = false } = {}) {
    this.targetDistance = clamp(distance, this.minDistance, this.maxDistance);
    if (immediate) {
      this.distance = this.targetDistance;
      this.applyTransform();
    }
  }

  get zoomRatio() {
    const span = this.maxDistance - this.minDistance;
    return span > 0 ? clamp((this.maxDistance - this.distance) / span, 0, 1) : 1;
  }

  /**
   * Screen (CSS pixel) position -> point on the ground plane.
   * Returns null when the ray points at the sky.
   */
  screenToGround(clientX, clientY, viewport) {
    const width = viewport ? viewport.width : window.innerWidth;
    const height = viewport ? viewport.height : window.innerHeight;
    this._ndc.set((clientX / width) * 2 - 1, -(clientY / height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._raycaster.ray.intersectPlane(this._groundPlane, this._hitPoint);
    if (!hit) return null;
    return { x: hit.x, y: hit.y, z: hit.z };
  }

  dispose() {
    this._panVelocity.set(0, 0, 0);
  }
}
