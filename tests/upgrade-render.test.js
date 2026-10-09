import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Engine } from '../src/core/Engine.js';
import { World } from '../src/world/World.js';
import { Config } from '../src/core/Config.js';
import { CharacterEntity } from '../src/world/characters/CharacterEntity.js';
import { CharacterRegistry } from '../src/world/characters/CharacterRegistry.js';
import { CharacterAssetLoader } from '../src/world/characters/CharacterAssetLoader.js';
import characterData from '../src/data/characters.json';

const renderer = () => ({ render: vi.fn(), shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false }, info: { render: {}, memory: {} }, setSize() {}, setPixelRatio() {} });
afterEach(() => vi.unstubAllGlobals());
describe('render lifecycle regression contracts', () => {
  it('does not halve normal rendering when RAF timestamps jitter around 60 Hz', () => {
    vi.stubGlobal('window', { requestAnimationFrame: vi.fn(() => 1), cancelAnimationFrame: vi.fn() });
    const config = new Config({ search: '?quality=low' });
    const engine = Object.assign(Object.create(Engine.prototype), {
      config, renderer: renderer(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(),
      runtimeQuality: config.quality, runtimeQualityTier: 'low', viewport: { width: 1, height: 1, dpr: 1 },
      resize() {}, applyRuntimeSettingsTo() {}, _clock: { getDelta: () => 1 / 60 },
      running: true, paused: false, frame: 0, time: 0, updatables: [], _nextFrameAt: 0, _refreshStats() {},
    });
    engine.setRuntimeSettings({ qualityTier: 'low', batterySaver: false });
    for (let i = 1; i <= 60; i += 1) engine._tick(i * (1000 / 60) + (i % 2 ? 0.6 : 0));
    expect(engine.renderer.render).toHaveBeenCalledTimes(60);
  });
  it('cancels hidden-tab RAF and does not reschedule a late callback', () => {
    const request = vi.fn(() => 8), cancel = vi.fn();
    vi.stubGlobal('window', { requestAnimationFrame: request, cancelAnimationFrame: cancel });
    const engine = Object.assign(Object.create(Engine.prototype), { running: true, paused: false, _pauseReasons: new Set(), _rafId: 7, _clock: { getDelta: () => 0.016 }, _nextFrameAt: 0, frame: 0, _refreshStats() {}, stats: {}, updatables: [] });
    engine.pause('hidden'); expect(cancel).toHaveBeenCalledWith(7);
    engine._tick(17); expect(request).not.toHaveBeenCalled();
    engine.resume('hidden'); expect(request).toHaveBeenCalledOnce();
    expect(engine.running).toBe(true);
  });
  it('sets both global and light shadow dirty flags at the solar cadence', () => {
    const config = new Config({ search: '?quality=medium' });
    const world = new World({ config }); world._buildLights();
    const engine = { renderer: renderer(), scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() };
    world._applyDayNight(world.dayNight.sample(), engine);
    engine.renderer.shadowMap.needsUpdate = false;
    world.lights.sun.shadow.needsUpdate = false;
    world.animationTime = 2;
    world._applyDayNight(world.dayNight.sample(), engine);
    expect(engine.renderer.shadowMap.needsUpdate).toBe(true);
    expect(world.lights.sun.shadow.needsUpdate).toBe(true);
    world.dispose();
  });
  it('disposes per-clone skeleton textures but does not dispose shared geometry/materials', () => {
    const registry = new CharacterRegistry(characterData);
    const entity = new CharacterEntity({ key: '1', profile: registry.getProfile('guard'), faction: 0, model: registry.getModel('guard') });
    const root = new THREE.Group(); const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    mesh.isSkinnedMesh = true; mesh.skeleton = { dispose: vi.fn() }; root.add(mesh); entity.visual = root; entity.root.add(root);
    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose'), materialDispose = vi.spyOn(mesh.material, 'dispose');
    entity.dispose();
    expect(mesh.skeleton.dispose).toHaveBeenCalledOnce();
    expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
  });
  it('disposes a parsed asset when skinned-mesh validation fails', async () => {
    const scene = new THREE.Group(); const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
    scene.add(new THREE.Mesh(geometry, material)); const dispose = vi.spyOn(geometry, 'dispose');
    const loader = new CharacterAssetLoader({ registry: new CharacterRegistry(characterData), fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) }), parseGLTF: async () => ({ scene, animations: [] }), logger: { warn() {} } });
    expect(await loader.load('guard')).toBeNull();
    expect(dispose).toHaveBeenCalledOnce(); loader.dispose();
  });
});
