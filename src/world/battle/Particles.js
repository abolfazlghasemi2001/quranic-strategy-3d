/**
 * Particles — سامانهٔ ذرهٔ سبک و پولی (گرد و خاک، جرقهٔ نور).
 *
 * همه چیز InstancedMesh است: یک draw call برای هر گونه ذره. هیچ بافت دود، خون
 * یا آسیب گرافیکی وجود ندارد (قاعدهٔ محتوایی پروژه): فقط گرد و خاک و جرقهٔ نور.
 * تصادفی‌بودن ظاهری از Rng بذردار می‌آید تا جلوه‌ها هم قابل‌تکرار بمانند.
 */
import * as THREE from 'three';
import { Rng } from '../../core/RNG.js';
import { createParticleTexture } from './UnitModels.js';

export class ParticleField {
  /**
   * @param {object} options
   * @param {number} options.count — بیشترین ذرهٔ همزمان
   * @param {'dust'|'spark'} options.kind
   * @param {number} options.size
   * @param {number} options.color
   * @param {number} options.lifeSeconds
   * @param {number} options.riseSpeed
   * @param {number} options.opacity
   * @param {number} options.seed
   */
  constructor({ count, kind, size, color, lifeSeconds = 0.8, riseSpeed = 0.6, opacity = 0.6, seed = 1 }) {
    this.count = count;
    this.size = size;
    this.lifeSeconds = lifeSeconds;
    this.riseSpeed = riseSpeed;
    this.rng = new Rng((seed ^ 0x7a1c9e27) >>> 0);
    this.texture = createParticleTexture(kind);
    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: kind === 'spark' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, count);
    this.mesh.name = `particles:${kind}`;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.particles = new Array(count);
    for (let i = 0; i < count; i += 1) {
      this.particles[i] = { active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, max: 1, scale: 1 };
    }
    this.cursor = 0;
    this._matrix = new THREE.Matrix4();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._position = new THREE.Vector3();
  }

  /** یک انفجار کوچک ذره در نقطهٔ داده‌شده. */
  burst(x, y, z, { count = 4, spread = 0.8, speed = 0.6, life = null } = {}) {
    for (let i = 0; i < count; i += 1) {
      const particle = this.particles[this.cursor];
      this.cursor = (this.cursor + 1) % this.count;
      const angle = this.rng.next() * Math.PI * 2;
      const radius = this.rng.next() * spread;
      particle.active = true;
      particle.x = x + Math.cos(angle) * radius * 0.4;
      particle.y = y + this.rng.next() * 0.4;
      particle.z = z + Math.sin(angle) * radius * 0.4;
      particle.vx = Math.cos(angle) * speed * (0.4 + this.rng.next());
      particle.vz = Math.sin(angle) * speed * (0.4 + this.rng.next());
      particle.vy = this.riseSpeed * (0.5 + this.rng.next());
      particle.max = life ?? this.lifeSeconds * (0.7 + this.rng.next() * 0.6);
      particle.life = particle.max;
      particle.scale = this.size * (0.7 + this.rng.next() * 0.7);
    }
  }

  update(dt, camera) {
    let visible = 0;
    const quat = camera ? camera.quaternion : null;
    for (let i = 0; i < this.count; i += 1) {
      const particle = this.particles[i];
      if (!particle.active) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }
      const damping = Math.max(0, 1 - dt * 3.2);
      particle.vx *= damping;
      particle.vz *= damping;
      particle.vy = particle.vy * damping + this.riseSpeed * dt * 0.5;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      const ratio = particle.life / particle.max;
      const scale = particle.scale * (0.45 + ratio * 0.75);
      this._position.set(particle.x, particle.y, particle.z);
      this._quat.copy(quat || IDENTITY);
      this._scale.set(scale, scale, scale);
      this._matrix.compose(this._position, this._quat, this._scale);
      this.mesh.setMatrixAt(visible, this._matrix);
      visible += 1;
    }
    this.mesh.count = visible;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** خاموش‌کردن همهٔ ذره‌ها (پایان نبرد). */
  reset() {
    for (const particle of this.particles) particle.active = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.mesh.dispose();
  }
}

const IDENTITY = new THREE.Quaternion();
