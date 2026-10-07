/**
 * Disposable resource container.
 *
 * Every object that owns GPU resources (geometries, materials, textures, render targets)
 * is registered here and released through a single `dispose()` call. This keeps the
 * "dispose everything" rule enforceable instead of aspirational.
 */
export class Registry {
  constructor({ label = 'registry', onRemove = null } = {}) {
    /** @type {Map<string, {value: any, dispose?: Function}>} */
    this.items = new Map();
    this.label = label;
    this.onRemove = onRemove;
  }

  /** Register a value. `item` may be anything, optionally with a `dispose()` method. */
  add(key, item) {
    if (this.items.has(key)) this.remove(key);
    this.items.set(key, item);
    return item;
  }

  get(key) {
    return this.items.get(key);
  }

  has(key) {
    return this.items.has(key);
  }

  remove(key) {
    if (!this.items.has(key)) return false;
    const item = this.items.get(key);
    this.items.delete(key);
    if (this.onRemove) this.onRemove(key, item);
    if (item && typeof item.dispose === 'function') item.dispose();
    return true;
  }

  /** Dispose every registered item (in reverse insertion order). */
  clear() {
    const keys = Array.from(this.items.keys()).reverse();
    for (const key of keys) this.remove(key);
  }

  get size() {
    return this.items.size;
  }
}

/**
 * Recursively dispose an Object3D subtree: geometries, materials and their textures.
 * Safe to call on objects that share materials (dispose is idempotent in Three.js).
 */
export function disposeObject3D(root, { removeFromParent = true } = {}) {
  if (!root) return;
  const materials = new Set();
  const geometries = new Set();

  root.traverse((node) => {
    if (node.geometry) geometries.add(node.geometry);
    if (node.material) {
      if (Array.isArray(node.material)) node.material.forEach((m) => materials.add(m));
      else materials.add(node.material);
    }
    if (node.isInstancedMesh && node.dispose) node.dispose();
  });

  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) disposeMaterial(material);

  if (removeFromParent && root.parent) root.parent.remove(root);
}

/** Dispose a material and every texture referenced by its (known + custom) uniform values. */
export function disposeMaterial(material) {
  if (!material) return;
  for (const key of Object.keys(material)) {
    const value = material[key];
    if (value && value.isTexture) value.dispose();
  }
  if (material.uniforms) {
    for (const uniform of Object.values(material.uniforms)) {
      const value = uniform && uniform.value;
      if (value && value.isTexture) value.dispose();
    }
  }
  material.dispose();
}
