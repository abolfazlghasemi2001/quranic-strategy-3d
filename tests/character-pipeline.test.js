import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import characterData from '../src/data/characters.json';
import { CharacterRegistry } from '../src/world/characters/CharacterRegistry.js';
import { CharacterAssetLoader } from '../src/world/characters/CharacterAssetLoader.js';
import { CharacterEntity } from '../src/world/characters/CharacterEntity.js';

const makeRiggedGltf = () => {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(0.5, 1, 0.5);
  geometry.setAttribute('position', geometry.getAttribute('position'));
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.isSkinnedMesh = true; // Asset validation observes the GLTF skinned-mesh contract.
  scene.add(mesh);
  const clip = (name, from, to) => new THREE.AnimationClip(name, 1, [
    new THREE.NumberKeyframeTrack('.position[y]', [0, 1], [from, to]),
  ]);
  return {
    scene,
    animations: [clip('Idle', 0, 0.05), clip('Walking_A', 0, 0.2), clip('Hit_A', 0, 0.08)],
  };
};

const makeRegistry = () => new CharacterRegistry(characterData);

afterEach(() => vi.restoreAllMocks());

describe('character pipeline', () => {
  it('validates the fictional roster and unit-to-profile bindings', () => {
    const registry = makeRegistry();
    expect(registry.modelIds).toHaveLength(5);
    expect(registry.selectedProfiles.map((profile) => profile.id)).toEqual(characterData.selection);
    expect(registry.profileForUnit('guard').id).toBe('guard');
    expect(registry.profileForUnit('archer').id).toBe('archer');
    expect(registry.profileForUnit('healer').modelId).toBe('scholar');
    expect(characterData.contentPolicy.sacredFigures).toBe(false);
  });

  it('deduplicates concurrent GLB requests, caches validated assets and publishes status', async () => {
    const registry = makeRegistry();
    const gltf = makeRiggedGltf();
    const fetchImpl = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(32) }));
    const onStatus = vi.fn();
    const loader = new CharacterAssetLoader({
      registry,
      fetchImpl,
      parseGLTF: vi.fn(async () => gltf),
      onStatus,
      logger: { warn: vi.fn() },
    });

    const first = loader.load('guard');
    const second = loader.load('guard');
    expect(second).toBe(first);
    await expect(first).resolves.toBe(gltf);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(loader.status('guard')).toBe('ready');
    expect(loader.getMetadata('guard')).toMatchObject({ meshes: 1, skinnedMeshes: 1, triangles: 12 });
    expect(onStatus.mock.calls.map(([status]) => status.status)).toEqual(['loading', 'ready']);
    loader.dispose();
  });

  it('keeps recoverable fallback state after errors and supports an explicit retry', async () => {
    const registry = makeRegistry();
    const gltf = makeRiggedGltf();
    let shouldFail = true;
    const fetchImpl = vi.fn(async () => (shouldFail
      ? { ok: false, status: 503 }
      : { ok: true, arrayBuffer: async () => new ArrayBuffer(32) }));
    const onStatus = vi.fn();
    const logger = { warn: vi.fn() };
    const loader = new CharacterAssetLoader({
      registry,
      fetchImpl,
      parseGLTF: async () => gltf,
      onStatus,
      logger,
    });

    await expect(loader.load('farmer')).resolves.toBeNull();
    expect(loader.status('farmer')).toBe('fallback');
    expect(logger.warn).toHaveBeenCalledOnce();
    shouldFail = false;
    await expect(loader.retry('farmer')).resolves.toBe(gltf);
    expect(loader.status('farmer')).toBe('ready');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onStatus.mock.calls.map(([status]) => status.status)).toEqual(['loading', 'fallback', 'loading', 'ready']);
    loader.dispose();
  });

  it('fits a cloned rig, switches animation clips and respects reduced motion', () => {
    const registry = makeRegistry();
    const profile = registry.getProfile('guard');
    const model = {
      ...registry.getModel('guard'),
      animations: { idle: 'Idle', walk: 'Walking_A', hit: 'Hit_A' },
    };
    const asset = makeRiggedGltf();
    const entity = new CharacterEntity({ key: 'unit-1', profile, faction: 0, model });

    expect(entity.attach(asset, new Map(), { castShadow: false })).toBe(true);
    expect(entity.ready).toBe(true);
    expect(entity.meshCount).toBe(1);
    expect(entity.currentAnimation).toBe('idle');
    expect(entity.setAnimation('walk')).toBe(true);
    expect(entity.currentAnimation).toBe('walk');
    expect(entity.playTransient('hit', 0.2)).toBe(true);
    expect(entity.currentAnimation).toBe('hit');
    entity.setReducedMotion(true);
    expect(entity.currentAnimation).toBe('idle');
    expect(entity.playTransient('hit')).toBe(false);
    entity.updateAnimation(0.1);
    entity.dispose();
  });
});
