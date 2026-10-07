/**
 * Markers — pooled ground rings that visualise taps.
 * The game logic only emits `tile:tap`; this render side listens and animates.
 */
import * as THREE from 'three';
import { createMarkerGeometry } from '../core/GeometryUtils.js';
import { EVENTS } from '../core/EventBus.js';

export class Markers {
  constructor({ config, bus }) {
    this.config = config;
    this.bus = bus;
    const settings = config.gameplay.tapMarker;

    this.geometry = createMarkerGeometry({ innerRadius: 0.5, outerRadius: settings.radiusUnits * 0.5, segments: 32 });
    this.material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(config.terrain.colors.marker),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.group = new THREE.Group();
    this.group.name = 'tap-markers';

    /** @type {Array<{mesh: THREE.Mesh, life: number, active: boolean}>} */
    this.pool = [];
    this._cursor = 0;

    for (let i = 0; i < settings.maxMarkers; i += 1) {
      const mesh = new THREE.Mesh(this.geometry, this.material);
      mesh.name = `tap-marker-${i}`;
      mesh.visible = false;
      mesh.renderOrder = 5;
      mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      this.pool.push({ mesh, life: 0, active: false });
    }

    this._unsubscribe = bus ? bus.on(EVENTS.TILE_TAP, (payload) => this.spawn(payload.x, payload.z)) : null;
  }

  spawn(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const entry = this.pool[this._cursor % this.pool.length];
    this._cursor += 1;

    entry.mesh.position.set(x, 0.09, z);
    entry.mesh.scale.setScalar(0.65);
    entry.mesh.visible = true;
    entry.life = 0;
    entry.active = true;
  }

  update(dt) {
    const lifetime = this.config.gameplay.tapMarker.lifetimeSec;
    for (const entry of this.pool) {
      if (!entry.active) continue;
      entry.life += dt;
      const t = Math.min(1, entry.life / lifetime);
      entry.mesh.scale.setScalar(0.65 + t * 0.75);
      // material is shared: opacity is driven per marker through the mesh scale
      if (t >= 1) {
        entry.active = false;
        entry.mesh.visible = false;
      }
    }
    // fade the shared material with the newest marker for a soft pulse
    const newest = this.pool.find((entry) => entry.active);
    this.material.opacity = newest ? 0.85 * (1 - Math.min(1, newest.life / lifetime)) + 0.15 : 0.85;
  }

  dispose() {
    if (this._unsubscribe) this._unsubscribe();
    this.geometry.dispose();
    this.material.dispose();
    if (this.group.parent) this.group.parent.remove(this.group);
    this.pool.length = 0;
  }
}
