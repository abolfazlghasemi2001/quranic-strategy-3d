/** Renderer-owned instancing. Logical roots remain available for damage/selection transforms. */
import * as THREE from 'three';
import { mergeGeometries } from '../core/GeometryUtils.js';

export class BuildingBatches {
  constructor({ parent, factory, engine, initialCapacity = 4 }) {
    Object.assign(this, { factory, engine, initialCapacity });
    this.group = new THREE.Group(); this.group.name = 'building-batches'; parent.add(this.group);
    this.layers = new Map();
    this.inverseParent = new THREE.Matrix4(); this.matrix = new THREE.Matrix4();
    this.hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);
    this.renderedEntityIds = new Set();
  }

  add(root, definition, { ready = true, level = 1 } = {}) {
    const key = `${definition.id}:${ready ? 'ready' : 'scaffold'}:${level}`;
    let layer = this.layers.get(key);
    if (!layer) {
      const source = ready ? this.factory.create(definition, { level }) : this.factory.createScaffold(definition);
      source.updateMatrixWorld(true);
      const buckets = new Map(); const owned = new Set();
      source.traverse((node) => {
        if (!node.isMesh) return;
        const transformed = node.geometry.clone().applyMatrix4(node.matrixWorld);
        if (!buckets.has(node.material)) buckets.set(node.material, []);
        buckets.get(node.material).push(transformed); owned.add(node.geometry);
      });
      for (const geometry of owned) geometry.dispose();
      layer = { key, entries: [], capacity: 0, dirty: true, parts: [...buckets].map(([material, geometries]) => ({ material, geometry: mergeGeometries(geometries, { name: `batch:${key}` }), mesh: null })) };
      this.layers.set(key, layer);
    }
    const item = { root, matrix: new THREE.Matrix4(), visible: false, slot: -1 };
    layer.entries.push(item); layer.dirty = true;
    root.userData.batchLayer = layer;
    this._reserve(layer, layer.entries.length);
    return root;
  }

  _reserve(layer, count) {
    if (count <= layer.capacity) return;
    layer.capacity = Math.max(this.initialCapacity, 2 ** Math.ceil(Math.log2(count)));
    for (const part of layer.parts) {
      if (part.mesh) { part.mesh.removeFromParent(); part.mesh.dispose(); }
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, layer.capacity);
      mesh.name = `instances:${layer.key}`; mesh.count = layer.entries.length;
      mesh.userData.noShadow = Boolean(part.material.userData.noShadow);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh); this.engine?.applyRuntimeSettingsTo?.(mesh); part.mesh = mesh;
    }
    layer.dirty = true;
  }

  remove(root) {
    const layer = root?.userData.batchLayer;
    if (!layer) return;
    layer.entries = layer.entries.filter((entry) => entry.root !== root); layer.dirty = true;
    delete root.userData.batchLayer;
    if (!layer.entries.length) {
      for (const part of layer.parts) { part.mesh?.removeFromParent(); part.mesh?.dispose(); part.geometry.dispose(); }
      this.layers.delete(layer.key);
    }
    this.renderedEntityIds.delete(root.userData.entityId);
    this.engine?.markShadowDirty?.();
  }

  flush() {
    this.group.updateWorldMatrix(true, false); this.inverseParent.copy(this.group.matrixWorld).invert();
    this.renderedEntityIds.clear(); let shadowDirty = false;
    for (const layer of this.layers.values()) {
      let changed = layer.dirty;
      for (let slot = 0; slot < layer.entries.length; slot += 1) {
        const entry = layer.entries[slot], root = entry.root;
        root.updateWorldMatrix(true, false);
        const visible = root.visible;
        this.matrix.copy(visible ? root.matrixWorld : this.hiddenMatrix);
        if (visible) { this.matrix.premultiply(this.inverseParent); this.renderedEntityIds.add(root.userData.entityId); }
        if (layer.dirty || entry.slot !== slot || entry.visible !== visible || !entry.matrix.equals(this.matrix)) {
          for (const part of layer.parts) part.mesh.setMatrixAt(slot, this.matrix);
          entry.matrix.copy(this.matrix); entry.visible = visible; entry.slot = slot; changed = true;
        }
      }
      if (changed) {
        for (const part of layer.parts) {
          part.mesh.count = layer.entries.length; part.mesh.instanceMatrix.needsUpdate = true;
          part.mesh.computeBoundingSphere();
        }
        shadowDirty = true;
      }
      layer.dirty = false;
    }
    if (shadowDirty) this.engine?.markShadowDirty?.();
  }

  dispose() {
    for (const layer of this.layers.values()) for (const part of layer.parts) { part.mesh?.dispose(); part.geometry.dispose(); }
    this.layers.clear(); this.renderedEntityIds.clear(); this.group.removeFromParent(); this.group.clear();
  }
}
