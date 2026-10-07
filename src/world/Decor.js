/**
 * Decor — turns placement data into InstancedMeshes.
 * Four instanced meshes render the entire vegetation of the map:
 * tree trunks, tree foliage, rocks and shrubs (4 draw calls, 4 shadow casters).
 */
import * as THREE from 'three';
import { createRockGeometry, createShrubGeometry, createTreeGeometries } from '../core/GeometryUtils.js';
import { mulberry32 } from '../core/RNG.js';

export class Decor {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {{tree: object[], rock: object[], shrub: object[]}} options.items
   */
  constructor({ config, items }) {
    this.config = config;
    this.items = items;
    this.group = new THREE.Group();
    this.group.name = 'decor';
    this.meshes = [];
    this._disposables = [];
    this._dummy = new THREE.Object3D();
    this._color = new THREE.Color();
  }

  build() {
    const colors = this.config.terrain.colors;
    const shadows = Boolean(this.config.quality.shadows);

    this._buildTrees({ colors, shadows });
    this._buildRocks({ colors, shadows });
    this._buildShrubs({ colors, shadows });

    return this.group;
  }

  _buildTrees({ colors, shadows }) {
    const trees = this.items.tree || [];
    if (trees.length === 0) return;

    const { trunk, foliage } = createTreeGeometries({ seed: this.config.seed });
    this._disposables.push(trunk, foliage);

    const trunkMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, flatShading: false });
    const foliageMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, flatShading: true });
    trunkMaterial.name = 'tree-trunk-material';
    foliageMaterial.name = 'tree-foliage-material';
    this._disposables.push(trunkMaterial, foliageMaterial);

    const trunks = new THREE.InstancedMesh(trunk, trunkMaterial, trees.length);
    const canopies = new THREE.InstancedMesh(foliage, foliageMaterial, trees.length);
    trunks.name = 'tree-trunks';
    canopies.name = 'tree-canopies';
    trunks.castShadow = shadows;
    canopies.castShadow = shadows;
    trunks.receiveShadow = shadows;
    canopies.receiveShadow = shadows;

    const trunkColor = new THREE.Color(colors.trunk);
    const trunkDark = new THREE.Color(colors.trunkDark);
    const foliageColor = new THREE.Color(colors.foliage);
    const foliageAlt = new THREE.Color(colors.foliageAlt);

    trees.forEach((item, index) => {
      const rng = mulberry32(item.colorSeed >>> 0);
      this._composeMatrix(item);
      trunks.setMatrixAt(index, this._dummy.matrix);
      canopies.setMatrixAt(index, this._dummy.matrix);

      this._color.copy(trunkColor).lerp(trunkDark, rng() * 0.65);
      trunks.setColorAt(index, this._color);

      this._color.copy(foliageColor).lerp(foliageAlt, item.variant ? rng() * 0.8 + 0.2 : rng() * 0.45);
      this._color.offsetHSL((rng() - 0.5) * item.colorJitter * 0.12, (rng() - 0.5) * item.colorJitter * 0.35, (rng() - 0.5) * item.colorJitter);
      canopies.setColorAt(index, this._color);
    });

    this._finalize(trunks);
    this._finalize(canopies);
    this.group.add(trunks, canopies);
  }

  _buildRocks({ colors, shadows }) {
    const rocks = this.items.rock || [];
    if (rocks.length === 0) return;

    const geometry = createRockGeometry({ radius: 0.55, detail: 1, squash: 0.8, seed: this.config.seed + 3, amount: 0.15 });
    this._disposables.push(geometry);

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.02, flatShading: true });
    material.name = 'rock-material';
    this._disposables.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, rocks.length);
    mesh.name = 'rocks';
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;

    const base = new THREE.Color(colors.rock);
    const dark = new THREE.Color(colors.rockDark);

    rocks.forEach((item, index) => {
      const rng = mulberry32(item.colorSeed >>> 0);
      this._composeMatrix(item);
      mesh.setMatrixAt(index, this._dummy.matrix);
      this._color.copy(base).lerp(dark, rng() * 0.8);
      this._color.offsetHSL(0, 0, (rng() - 0.5) * 0.08);
      mesh.setColorAt(index, this._color);
    });

    this._finalize(mesh);
    this.group.add(mesh);
  }

  _buildShrubs({ colors, shadows }) {
    const shrubs = this.items.shrub || [];
    if (shrubs.length === 0) return;

    const geometry = createShrubGeometry({ radius: 0.42, squash: 0.72, seed: this.config.seed + 7 });
    this._disposables.push(geometry);

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, flatShading: true });
    material.name = 'shrub-material';
    this._disposables.push(material);

    const mesh = new THREE.InstancedMesh(geometry, material, shrubs.length);
    mesh.name = 'shrubs';
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;

    const base = new THREE.Color(colors.shrub);
    const dark = new THREE.Color(colors.foliageDark);

    shrubs.forEach((item, index) => {
      const rng = mulberry32(item.colorSeed >>> 0);
      this._composeMatrix(item);
      mesh.setMatrixAt(index, this._dummy.matrix);
      this._color.copy(base).lerp(dark, rng() * 0.7);
      mesh.setColorAt(index, this._color);
    });

    this._finalize(mesh);
    this.group.add(mesh);
  }

  _composeMatrix(item) {
    const stretch = item.stretch || { x: 1, y: 1, z: 1 };
    this._dummy.position.set(item.x, 0, item.z);
    this._dummy.rotation.set(item.tiltX || 0, item.yaw || 0, item.tiltZ || 0, 'YXZ');
    this._dummy.scale.set(item.scale * stretch.x, item.scale * stretch.y, item.scale * stretch.z);
    this._dummy.updateMatrix();
  }

  _finalize(mesh) {
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.meshes.push(mesh);
  }

  getInstanceCounts() {
    return this.meshes.map((mesh) => ({ name: mesh.name, count: mesh.count }));
  }

  dispose() {
    for (const mesh of this.meshes) mesh.dispose();
    this.meshes.length = 0;
    for (const resource of this._disposables) {
      if (resource && typeof resource.dispose === 'function') resource.dispose();
    }
    this._disposables.length = 0;
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}
