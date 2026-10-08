/**
 * Asynchronous GLB loader with shared in-flight/cache entries and a recoverable fallback state.
 * GLTFLoader/SkeletonUtils are renderer-layer concerns; gameplay only ever sees events and data.
 */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

function summarizeGltf(gltf) {
  const summary = { meshes: 0, skinnedMeshes: 0, triangles: 0, materials: new Set(), textures: new Set() };
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    summary.meshes += 1;
    if (node.isSkinnedMesh) summary.skinnedMeshes += 1;
    const geometry = node.geometry;
    if (geometry) {
      const indexCount = geometry.index?.count;
      const positionCount = geometry.attributes?.position?.count || 0;
      summary.triangles += Math.floor((indexCount ?? positionCount) / 3);
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      summary.materials.add(material);
      for (const value of Object.values(material)) {
        if (value?.isTexture) summary.textures.add(value);
      }
    }
  });
  return {
    meshes: summary.meshes,
    skinnedMeshes: summary.skinnedMeshes,
    triangles: summary.triangles,
    materialCount: summary.materials.size,
    textureCount: summary.textures.size,
    textureBytesEstimate: [...summary.textures].reduce((total, texture) => {
      const image = texture.image || texture.source?.data;
      const width = Number(image?.width || image?.videoWidth || image?.naturalWidth) || 0;
      const height = Number(image?.height || image?.videoHeight || image?.naturalHeight) || 0;
      return total + width * height * 4;
    }, 0),
  };
}

export function disposeGltf(gltf) {
  if (!gltf?.scene) return;
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  gltf.scene.traverse((node) => {
    if (!node.isMesh) return;
    if (node.geometry) geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export class CharacterAssetLoader {
  constructor({
    registry,
    fetchImpl = globalThis.fetch,
    parseGLTF = null,
    onStatus = () => {},
    onError = () => {},
    baseUrl = null,
    timeoutMs = 20000,
    maxConcurrent = 2,
    logger = console,
  } = {}) {
    if (!registry) throw new TypeError('CharacterAssetLoader requires a CharacterRegistry');
    this.registry = registry;
    this.fetchImpl = fetchImpl;
    this.parseGLTF = parseGLTF || ((buffer, url) => new GLTFLoader().parseAsync(buffer, url));
    this.onStatus = onStatus;
    this.onError = onError;
    this.baseUrl = baseUrl;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 20000);
    this.maxConcurrent = Math.max(1, Math.floor(Number(maxConcurrent) || 2));
    this.logger = logger;
    this.cache = new Map();
    this.controllers = new Set();
    this.disposed = false;
  }

  resolveUrl(model) {
    const base = this.baseUrl
      || (typeof document !== 'undefined' ? document.baseURI : null)
      || (typeof location !== 'undefined' ? location.href : null);
    if (!base) return model.asset;
    try {
      return new URL(model.asset, base).href;
    } catch {
      return model.asset;
    }
  }

  status(modelId) {
    const entry = this.cache.get(modelId);
    return entry?.status || 'idle';
  }

  getAsset(modelId) {
    const entry = this.cache.get(modelId);
    return entry?.status === 'ready' ? entry.gltf : null;
  }

  getMetadata(modelId) {
    const entry = this.cache.get(modelId);
    return entry?.status === 'ready' ? entry.metadata : null;
  }

  load(modelId, { retry = false } = {}) {
    if (this.disposed) return Promise.resolve(null);
    const model = this.registry.getModel(modelId);
    if (!model) return Promise.resolve(null);

    const cached = this.cache.get(modelId);
    if (cached && !retry) {
      if (cached.promise) return cached.promise;
      return Promise.resolve(cached.status === 'ready' ? cached.gltf : null);
    }
    if (retry && cached?.gltf) disposeGltf(cached.gltf);

    const entry = { status: 'loading', promise: null, gltf: null, metadata: null, error: null };
    this.cache.set(modelId, entry);
    this._publish({ modelId, status: 'loading' });
    entry.promise = this._load(model, entry);
    return entry.promise;
  }

  async _load(model, entry) {
    const modelId = model.id;
    const url = this.resolveUrl(model);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) this.controllers.add(controller);
    let timeout = null;
    let stage = 'fetch';
    try {
      if (typeof this.fetchImpl !== 'function') throw new Error('fetch is unavailable');
      if (controller) timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const response = await this.fetchImpl(url, controller ? { signal: controller.signal } : undefined);
      if (!response?.ok) throw new Error(`HTTP ${response?.status ?? 'failure'}`);
      const buffer = await response.arrayBuffer();
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 20) throw new Error('GLB response is empty or truncated');

      stage = 'parse';
      const gltf = await this.parseGLTF(buffer, url);
      if (this.disposed) {
        disposeGltf(gltf);
        return null;
      }
      if (!gltf?.scene || !Array.isArray(gltf.animations)) throw new Error('Parsed GLB has no scene or animation list');
      gltf.scene.updateMatrixWorld(true);
      const metadata = summarizeGltf(gltf);
      if (metadata.meshes === 0 || metadata.skinnedMeshes === 0 || gltf.animations.length === 0) {
        throw new Error('GLB must contain a skinned mesh and real animation clips');
      }

      entry.status = 'ready';
      entry.gltf = gltf;
      entry.metadata = metadata;
      entry.error = null;
      this._publish({ modelId, status: 'ready', metadata });
      return gltf;
    } catch (error) {
      if (this.disposed) return null;
      entry.status = 'fallback';
      entry.gltf = null;
      entry.metadata = null;
      entry.error = { stage, name: error?.name || 'Error', message: error?.message || String(error) };
      this._publish({ modelId, status: 'fallback' });
      const report = { modelId, url, stage, error, recoverable: true };
      try { this.onError(report); } catch { /* diagnostics must never break the game */ }
      this.logger?.warn?.(`[شهر نور] مدل کاراکتر «${modelId}» بارگذاری نشد؛ نمایش جایگزین فعال می‌ماند.`, { stage, error });
      return null;
    } finally {
      if (timeout != null) clearTimeout(timeout);
      if (controller) this.controllers.delete(controller);
      entry.promise = null;
    }
  }

  async preload(modelIds = this.registry.modelIds, { retry = false } = {}) {
    const ids = [...new Set(modelIds)].filter((id) => this.registry.getModel(id));
    const results = new Map();
    for (let start = 0; start < ids.length; start += this.maxConcurrent) {
      const batch = ids.slice(start, start + this.maxConcurrent);
      const loaded = await Promise.all(batch.map(async (id) => [id, await this.load(id, { retry })]));
      for (const [id, gltf] of loaded) results.set(id, gltf);
    }
    return results;
  }

  retry(modelId) {
    return this.load(modelId, { retry: true });
  }

  _publish(payload) {
    try { this.onStatus(payload); } catch { /* observers are optional */ }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    for (const entry of this.cache.values()) if (entry.gltf) disposeGltf(entry.gltf);
    this.cache.clear();
  }
}

export { summarizeGltf as summarizeCharacterAsset };
