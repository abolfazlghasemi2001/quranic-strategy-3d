/**
 * Engine — renderer + scene + camera + game loop.
 *
 * The engine knows nothing about gameplay. It owns the WebGL resources, keeps the
 * viewport in sync (resize, orientation change, DPR changes) and ticks the
 * registered updatables with a clamped delta time.
 */
import * as THREE from 'three';
import { Registry, disposeObject3D } from './Registry.js';
import { EVENTS } from './EventBus.js';

const TONE_MAPPING = {
  none: THREE.NoToneMapping,
  linear: THREE.LinearToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  neutral: THREE.NeutralToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  cineon: THREE.CineonToneMapping,
  agx: THREE.AgXToneMapping,
};

const SHADOW_TYPES = {
  basic: THREE.BasicShadowMap,
  pcf: THREE.PCFShadowMap,
  pcfsoft: THREE.PCFSoftShadowMap,
  vsm: THREE.VSMShadowMap,
};

const MAX_FRAME_DELTA = 0.1; // seconds — protects the sim from tab-switch spikes

export class Engine {
  /**
   * @param {object} options
   * @param {HTMLCanvasElement} options.canvas
   * @param {import('./Config.js').Config} options.config
   * @param {import('./EventBus.js').EventBus} [options.bus]
   */
  constructor({ canvas, config, bus = null }) {
    this.canvas = canvas;
    this.config = config;
    this.bus = bus;
    this.registry = new Registry({ label: 'engine' });
    this.updatables = [];
    this.time = 0;
    this.frame = 0;
    this.running = false;
    this.paused = false;
    this._pauseReasons = new Set();
    this.viewport = { width: 1, height: 1, dpr: 1 };
    this.runtimeQualityTier = config.quality.tier;
    this.batterySaver = false;
    this.frameCap = config.targets?.fps || 60;
    this.runtimeQuality = { ...config.quality };
    this._nextFrameAt = 0;
    this._resolutionScale = 1;
    this._disposed = false;
    this.governor = null;
    this.stats = {
      frameMs: 0,
      fps: 0,
      drawCalls: 0,
      triangles: 0,
      points: 0,
      lines: 0,
      programs: 0,
      geometries: 0,
      textures: 0,
    };

    this._rafId = 0;
    this._clock = new THREE.Clock(false);
    this._resizeQueued = false;
    this._boundTick = this._tick.bind(this);

    this._createRenderer();
    this._createScene();
    this._createCamera();
    this._bindEvents();
    this.resize();
    import('./FrameTimeGovernor.js').then(({ FrameTimeGovernor }) => {
      if (this._disposed) return;
      this.governor = new FrameTimeGovernor(config.sources.quality.resolutionGovernor);
      this.governor.reset({ fps: this.frameCap, minScale: this.runtimeQuality.minResolutionScale || 0.7 });
    }).catch(() => {});
  }

  /* ------------------------------------------------------------- creation */

  _createRenderer() {
    const { quality, world } = this.config;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: Boolean(quality.antialias),
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });

    if (!this.renderer.capabilities.isWebGL2) {
      const error = new Error('WebGL2 is not available');
      error.code = 'WEBGL_UNAVAILABLE';
      throw error;
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = TONE_MAPPING[world.renderer.toneMapping] ?? THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = world.renderer.toneMappingExposure ?? 1;
    this.renderer.setClearColor(new THREE.Color(world.renderer.clearColor || '#cfe0ef'), 1);

    this.renderer.shadowMap.enabled = Boolean(quality.shadows);
    this.renderer.shadowMap.type = SHADOW_TYPES[world.renderer.shadowType] ?? THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;

  }

  _createScene() {
    this.scene = new THREE.Scene();
    this.scene.name = 'root';

    if (this.config.fogEnabled) {
      const fog = this.config.world.fog;
      this.scene.fog = new THREE.Fog(new THREE.Color(fog.color), fog.near, fog.far);
      this.registry.add('fog', { dispose: () => { this.scene.fog = null; } });
    }

    /** Root group for world content (kept separate from future UI/overlay roots). */
    this.worldRoot = new THREE.Group();
    this.worldRoot.name = 'world-root';
    this.scene.add(this.worldRoot);
  }

  _createCamera() {
    const camera = this.config.world.camera;
    this.camera = new THREE.PerspectiveCamera(camera.fov, 1, camera.near, camera.far);
    this.camera.name = 'world-camera';
    this.camera.position.set(0, 60, 60);
    this.scene.add(this.camera);
  }

  /* -------------------------------------------------------------- events */

  _bindEvents() {
    this._onResize = () => this._queueResize();
    this._onVisibility = () => {
      if (document.hidden) this.pause('hidden');
      else this.resume('hidden');
    };
    this._onContextLost = (event) => {
      event.preventDefault();
      this.pause('context-lost');
      if (this.bus) this.bus.emit(EVENTS.CONTEXT_LOST);
    };
    this._onContextRestored = () => {
      this.renderer.shadowMap.needsUpdate = true;
      this.resume('context-lost');
      if (this.bus) this.bus.emit(EVENTS.CONTEXT_RESTORED);
    };
    this._onOrientation = () => {
      // iOS reports the new size a moment after the event.
      window.setTimeout(this._onResize, 240);
    };

    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onOrientation, { passive: true });
    document.addEventListener('visibilitychange', this._onVisibility);
    this.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    this.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);

    const parent = this.canvas.parentElement || document.body;
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(this._onResize);
      this._resizeObserver.observe(parent);
    }
  }

  _queueResize() {
    if (this._resizeQueued) return;
    this._resizeQueued = true;
    window.requestAnimationFrame(() => {
      this._resizeQueued = false;
      this.resize();
    });
  }

  /* -------------------------------------------------------------- resize */

  resize() {
    const parent = this.canvas.parentElement || document.body;
    const width = Math.max(1, Math.round(parent.clientWidth || window.innerWidth || 1));
    const height = Math.max(1, Math.round(parent.clientHeight || window.innerHeight || 1));
    const dpr = Math.min(window.devicePixelRatio || 1, this.runtimeQuality.maxPixelRatio || this.config.quality.maxPixelRatio) * this._resolutionScale;

    if (this.viewport.width === width && this.viewport.height === height && this.viewport.dpr === dpr) return;

    this.viewport = { width, height, dpr };
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.bus) this.bus.emit(EVENTS.RESIZE, { ...this.viewport });
  }

  /**
   * Apply player-selected quality at runtime. Pixel ratio, fog and actual
   * shadow casting are changed without rebuilding the WebGL renderer.
   * Battery saver is an independent 30 FPS cap and always disables shadows.
   */
  setRuntimeSettings({ qualityTier = this.runtimeQualityTier, batterySaver = this.batterySaver } = {}) {
    const qualityData = this.config.sources?.quality || {};
    const tiers = qualityData.tiers || {};
    const defaults = qualityData.defaults || this.config.quality;
    const tier = ['low', 'medium', 'high'].includes(qualityTier) ? qualityTier : this.config.quality.tier;
    const profile = { ...defaults, ...(tiers[tier] || {}) };
    const effective = { ...profile, tier, shadows: Boolean(profile.shadows) && !Boolean(batterySaver) };

    this.runtimeQualityTier = tier;
    this.batterySaver = Boolean(batterySaver);
    this.runtimeQuality = effective;
    this._resolutionScale = 1;
    this.frameCap = this.batterySaver ? 30 : Math.max(1, Number(this.config.targets?.fps) || 60);
    this._nextFrameAt = 0;
    this.governor?.reset({ fps: this.frameCap, minScale: effective.minResolutionScale || 0.7 });

    if (this.renderer) {
      this.renderer.shadowMap.enabled = effective.shadows;
      // World.markShadowDirty controls a bounded refresh cadence for the moving sun.
      this.renderer.shadowMap.autoUpdate = false;
      if (effective.shadows) this.renderer.shadowMap.needsUpdate = true;
    }
    const fogData = this.config.world.fog;
    this.scene.fog = fogData?.enabled && effective.fog
      ? new THREE.Fog(new THREE.Color(fogData.color), fogData.near, fogData.far)
      : null;

    this.applyRuntimeSettingsTo(this.scene);
    this.scene.traverse((node) => {
      if (node.isDirectionalLight && node.name === 'sun' && effective.shadows && node.shadow?.mapSize) {
        const mapSize = Math.max(256, Number(effective.shadowMapSize) || 1024);
        node.shadow.mapSize.set(mapSize, mapSize);
        node.shadow.camera?.updateProjectionMatrix?.();
        node.shadow.needsUpdate = true;
      }
    });

    this.resize(); // reads the newly selected DPR cap
    if (this.bus) {
      this.bus.emit(EVENTS.QUALITY_CHANGED, {
        qualityTier: tier,
        batterySaver: this.batterySaver,
        frameCap: this.frameCap,
        maxPixelRatio: effective.maxPixelRatio,
        shadows: effective.shadows,
      });
    }
    return { qualityTier: tier, batterySaver: this.batterySaver, frameCap: this.frameCap, shadows: effective.shadows };
  }

  /** Apply the current runtime shadow policy to a subtree created after boot. */
  applyRuntimeSettingsTo(root) {
    if (!root?.traverse) return root;
    const shadows = Boolean(this.runtimeQuality?.shadows && !this.batterySaver);
    root.traverse((node) => {
      if (node.isMesh) {
        node.castShadow = shadows && !node.userData.noShadow;
        node.receiveShadow = shadows && !node.userData.noShadow;
      }
      if (node.isDirectionalLight && node.name === 'sun') node.castShadow = shadows;
    });
    return root;
  }

  markShadowDirty() {
    if (!this.renderer?.shadowMap?.enabled) return;
    this.renderer.shadowMap.needsUpdate = true;
    this.scene.traverse((node) => { if (node.isLight && node.shadow && node.castShadow) node.shadow.needsUpdate = true; });
  }

  /* ---------------------------------------------------------------- loop */

  addUpdatable(updatable, priority = 0) {
    if (updatable == null) return null;
    updatable.__priority = priority;
    this.updatables.push(updatable);
    this.updatables.sort((a, b) => (a.__priority ?? 0) - (b.__priority ?? 0));
    return updatable;
  }

  removeUpdatable(updatable) {
    const index = this.updatables.indexOf(updatable);
    if (index >= 0) this.updatables.splice(index, 1);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this._clock.start();
    this._clock.getDelta();
    this._rafId = window.requestAnimationFrame(this._boundTick);
  }

  stop() {
    this.running = false;
    if (this._rafId) window.cancelAnimationFrame(this._rafId);
    this._rafId = 0;
    this._clock.stop();
  }

  /**
   * Pausing is reason based: visibility changes, an open modal and the manual
   * pause button each hold their own reason, and the sim only runs when the set
   * of reasons is empty. This avoids one system resuming the game while another
   * still wants it paused.
   */
  pause(reason = 'manual') {
    this._pauseReasons.add(reason);
    this._applyPauseState();
  }

  resume(reason = 'manual') {
    this._pauseReasons.delete(reason);
    this._applyPauseState();
  }

  _applyPauseState() {
    const shouldPause = this._pauseReasons.size > 0;
    const suspended = this._pauseReasons.has('hidden') || this._pauseReasons.has('context-lost');
    if (suspended && this._rafId) { window.cancelAnimationFrame(this._rafId); this._rafId = 0; }
    else if (!suspended && this.running && !this._rafId) this._rafId = window.requestAnimationFrame(this._boundTick);
    if (this.paused === shouldPause) return;
    this.paused = shouldPause;
    if (shouldPause && this.stats) { this.stats.fps = 0; this.stats.frameMs = 0; }
    if (!shouldPause) {
      this._clock.getDelta(); // drop the elapsed paused time
      this._nextFrameAt = 0;
    }
    if (this.bus) this.bus.emit(EVENTS.GAME_PAUSED, { paused: shouldPause, reasons: Array.from(this._pauseReasons) });
  }

  togglePause() {
    if (this.paused) this.resume('manual');
    else this.pause('manual');
  }

  _tick(timestamp = 0) {
    this._rafId = 0;
    if (!this.running || this._pauseReasons?.has('hidden') || this._pauseReasons?.has('context-lost')) return;
    this._rafId = window.requestAnimationFrame(this._boundTick);
    if (this.paused) return;

    const now = Number.isFinite(timestamp) && timestamp > 0
      ? timestamp
      : (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (!this.paused && this.frameCap > 0) {
      if (now + (this.config.sources?.quality?.scheduler?.frameToleranceMs ?? 1) < this._nextFrameAt) return;
      const interval = 1000 / this.frameCap;
      this._nextFrameAt = this._nextFrameAt > 0
        ? this._nextFrameAt + Math.max(1, Math.floor((now - this._nextFrameAt) / interval) + 1) * interval
        : now + interval;
    }

    const frameDelta = this._clock.getDelta();
    this.frameDelta = frameDelta;
    const scale = this.governor?.sample(frameDelta * 1000);
    if (scale != null) { this._resolutionScale = scale; this.resize(); }
    const dt = Math.min(frameDelta, MAX_FRAME_DELTA);
    this.frame += 1;

    if (!this.paused) {
      this.time += dt;
      for (let i = 0; i < this.updatables.length; i += 1) {
        this.updatables[i].update(dt, this);
      }
      for (const updatable of this.updatables) updatable.beforeRender?.(this);
      this.renderer.render(this.scene, this.camera);
    }

    this._refreshStats(frameDelta);
  }

  _refreshStats(dt) {
    const info = this.renderer.info;
    const frameMs = dt * 1000;
    this.stats.frameMs = this.stats.frameMs === 0 ? frameMs : this.stats.frameMs * 0.9 + frameMs * 0.1;
    this.stats.fps = this.stats.frameMs > 0 ? 1000 / this.stats.frameMs : 0;
    this.stats.drawCalls = info.render.calls;
    this.stats.triangles = info.render.triangles;
    this.stats.points = info.render.points;
    this.stats.lines = info.render.lines;
    this.stats.programs = info.programs ? info.programs.length : 0;
    this.stats.geometries = info.memory.geometries;
    this.stats.textures = info.memory.textures;
  }

  /* ------------------------------------------------------------- helpers */

  /** Attach a Three.js object to the world root. */
  attach(object3d) {
    this.worldRoot.add(object3d);
    return object3d;
  }

  addToScene(object3d) {
    this.scene.add(object3d);
    this.applyRuntimeSettingsTo(object3d);
    return object3d;
  }

  /* ------------------------------------------------------------- dispose */

  dispose() {
    this._disposed = true;
    this.stop();
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onOrientation);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.canvas.removeEventListener('webglcontextlost', this._onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this._onContextRestored);
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    disposeObject3D(this.worldRoot, { removeFromParent: false });
    this.updatables.length = 0;
    this.registry.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
  }
}
