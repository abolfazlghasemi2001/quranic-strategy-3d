/**
 * Test-only stand-in for src/core/Engine.js used by tools/smoke.mjs.
 *
 * The real Engine owns a WebGLRenderer, which cannot run inside jsdom. The
 * smoke harness aliases `./core/Engine.js` (the sole importer is src/main.js)
 * to this file, so the rest of the app boots unmodified. It exposes the exact
 * surface main.js / DevPanel / PerfMonitor consume:
 *   camera, scene, addToScene, addUpdatable/removeUpdatable (priority-sorted),
 *   start, pause/resume/togglePause (reason-set + GAME_PAUSED on change),
 *   stats, resize, dispose — plus a manual `tick(dt)` the harness drives
 *   instead of requestAnimationFrame for deterministic stepping.
 */
import * as THREE from 'three';

export class Engine {
  constructor({ canvas = null, config = null, bus = null } = {}) {
    this.canvas = canvas;
    this.config = config;
    this.bus = bus;

    this.scene = new THREE.Scene();

    const cam = (config && config.world && config.world.camera) || {};
    const w = typeof window !== 'undefined' && window.innerWidth ? window.innerWidth : 1024;
    const h = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 768;
    this.camera = new THREE.PerspectiveCamera(cam.fov ?? 50, w / h, cam.near ?? 0.5, cam.far ?? 900);
    this.camera.position.set(0, 60, 60);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);

    // PerfMonitor/DevPanel read these six (+points/lines for completeness).
    this.stats = {
      frameMs: 16.7,
      fps: 60,
      drawCalls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      programs: 0,
      geometries: 0,
      textures: 0,
    };

    // OrbitCameraRig reads engine.viewport.height for its units-per-pixel.
    this.viewport = { width: w, height: h };

    this.time = 0;
    this.frame = 0;
    this.running = false;
    this._pauseReasons = new Set();
    this._updatables = [];
    this._disposed = false;
  }

  get paused() {
    return this._pauseReasons.size > 0;
  }

  addToScene(object) {
    if (object) this.scene.add(object);
  }

  removeFromScene(object) {
    if (object) this.scene.remove(object);
  }

  addUpdatable(object, priority = 0) {
    if (!object || typeof object.update !== 'function') return;
    object.__priority = priority;
    this._updatables.push(object);
    this._updatables.sort((a, b) => a.__priority - b.__priority);
  }

  removeUpdatable(object) {
    const index = this._updatables.indexOf(object);
    if (index >= 0) this._updatables.splice(index, 1);
  }

  start() {
    this.running = true;
  }

  stop() {
    this.running = false;
  }

  pause(reason = 'manual') {
    const wasPaused = this.paused;
    this._pauseReasons.add(reason);
    if (!wasPaused && this.paused && this.bus) this.bus.emit('game:paused', { paused: true, reason });
  }

  resume(reason = 'manual') {
    const wasPaused = this.paused;
    this._pauseReasons.delete(reason);
    if (wasPaused && !this.paused && this.bus) this.bus.emit('game:paused', { paused: false, reason });
  }

  togglePause() {
    if (this.paused) this.resume('manual');
    else this.pause('manual');
  }

  resize(width, height) {
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewport.width = width;
    this.viewport.height = height;
  }

  /** Manual frame for the smoke harness (no rAF loop, fully deterministic). */
  tick(dt = 1 / 60) {
    if (this._disposed) return;
    if (this.running && !this.paused) {
      for (const updatable of [...this._updatables]) updatable.update(dt, this);
    }
    this.time += dt;
    this.frame += 1;
    this.camera.updateMatrixWorld(true);
  }

  dispose() {
    this.running = false;
    this._updatables.length = 0;
    this._pauseReasons.clear();
    this._disposed = true;
  }
}

export default Engine;
