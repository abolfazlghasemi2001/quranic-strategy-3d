/**
 * Chunk — one buildable block of the world (phase 1 has a single chunk covering
 * the whole grid). Keeping props grouped per chunk means later phases can stream
 * or rebuild districts without touching the rest of the map.
 */
import * as THREE from 'three';
import { Decor } from './Decor.js';

export class Chunk {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {string} options.key
   * @param {{cx: number, cz: number}} options.coord
   * @param {{minX: number, maxX: number, minZ: number, maxZ: number}} options.bounds
   * @param {{tree: object[], rock: object[], shrub: object[]}} options.items
   */
  constructor({ config, key, coord, bounds, items }) {
    this.config = config;
    this.key = key;
    this.coord = coord;
    this.bounds = bounds;
    this.items = items;
    this.built = false;

    this.group = new THREE.Group();
    this.group.name = `chunk-${key}`;
    this.decor = null;
  }

  build() {
    if (this.built) return this.group;
    this.decor = new Decor({ config: this.config, items: this.items });
    this.group.add(this.decor.build());
    this.built = true;
    return this.group;
  }

  get propCount() {
    const { tree = [], rock = [], shrub = [] } = this.items;
    return tree.length + rock.length + shrub.length;
  }

  /** World space centre of the chunk. */
  get center() {
    return {
      x: (this.bounds.minX + this.bounds.maxX) * 0.5,
      z: (this.bounds.minZ + this.bounds.maxZ) * 0.5,
    };
  }

  contains(x, z) {
    return x >= this.bounds.minX && x <= this.bounds.maxX && z >= this.bounds.minZ && z <= this.bounds.maxZ;
  }

  dispose() {
    if (this.decor) {
      this.decor.dispose();
      this.decor = null;
    }
    if (this.group.parent) this.group.parent.remove(this.group);
    this.built = false;
  }
}
