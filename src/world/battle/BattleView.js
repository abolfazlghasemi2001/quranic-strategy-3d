/**
 * BattleView — لایهٔ رندر میدان نبرد (فقط نمایش؛ هیچ منطقی اینجا نیست).
 *
 * همهٔ حالت‌ها از شبیه‌ساز خوانده می‌شود و این لایه فقط «می‌کشد»:
 *   • کاراکترهای نزدیک با rig/animation واقعی؛ LOD دوردست با InstancedMesh مشترک
 *   • نوار جان با دو InstancedMesh (پس‌زمینه + پرشدگی)
 *   • تیر و گلولهٔ نوری با استخر InstancedMesh
 *   • گرد و خاک و جرقهٔ نور با ParticleField (بدون خون، بدون آسیب گرافیکی)
 *   • نشانهٔ آسیب روی سازه‌ها: تیره‌شدن، کج‌شدن دیوار شکسته و فروریختن ملایم
 *
 * قواعد محتوایی: هیچ متن و تصویری — و به‌ویژه هیچ متن قرآنی — روی صحنه نمی‌آید.
 */
import * as THREE from 'three';
import characterData from '../../data/characters.json';
import { EVENTS } from '../../core/EventBus.js';
import { CharacterSystem } from '../characters/CharacterSystem.js';
import { ParticleField } from './Particles.js';
import {
  BATTLE_FACTION,
  BATTLE_PALETTES,
  createBarGeometry,
  createDeployRing,
  createProjectileGeometry,
  createUnitGeometry,
  createUnitMaterial,
} from './UnitModels.js';

/** چرخش خنثی برای نوارهای جان (وقتی دوربینی در دست نیست). */
const IDENTITY_Q = new THREE.Quaternion();

export class BattleView {
  /**
   * @param {object} options
   * @param {THREE.Scene|THREE.Object3D} options.parent — معمولاً گروه دنیا
   * @param {object} options.config
   * @param {object} options.state — GameState (برای یافتن ریشهٔ سازه‌ها)
   * @param {import('../../core/OrbitCameraRig.js').OrbitCameraRig} options.rig
   * @param {object} options.battleData — battle.json
   * @param {object} options.unitsData — units.json
   * @param {() => import('../../game/battle/BattleSystem.js').BattleSystem} options.getBattle
   * @param {number} [options.seed]
   */
  constructor({ parent, config, state, rig, buildings = null, buildingView = null, bus = null, battleData, unitsData, getBattle, engine = null, seed = 1 }) {
    this.parent = parent;
    this.config = config;
    this.state = state;
    this.rig = rig;
    this.buildings = buildings;
    this.buildingView = buildingView;
    this.bus = bus;
    this.engine = engine;
    this.battleData = battleData;
    this.unitsData = unitsData;
    this.proceduralOnly = unitsData.rendering?.proceduralDefault !== false;
    this.reducedMotion = false;
    this.unitDefs = new Map((unitsData?.units || []).map((def) => [def.id, def]));
    this.characterProfileOverrides = new Map();
    this.getBattle = getBattle;
    this.seed = seed >>> 0;

    this.group = new THREE.Group();
    this.group.name = 'battle-view';
    this.group.visible = false;
    this.parent.add(this.group);
    this.characterSystem = new CharacterSystem({ parent: this.group, config, bus, engine, data: characterData });
    this._eventUnsubscribers = bus ? [
      bus.on(EVENTS.BATTLE_EVENTS, ({ events } = {}) => this.handleEvents(events)),
      bus.on(EVENTS.CHARACTER_PROFILE_SELECTED, ({ unitId, profileId } = {}) => this.setCharacterProfile(unitId, profileId)),
    ] : [];
    this._frustum = new THREE.Frustum();
    this._viewProjection = new THREE.Matrix4();
    this._frustumPoint = new THREE.Vector3();
    this._renderRecords = [];
    this._renderRecordsById = new Map();
    this._selectedCharacterIds = new Set();
    this._preferredCharacterKeys = new Set();

    this.mounted = false;
    this.sim = null;
    this.elapsed = 0;
    this.unitMaterial = createUnitMaterial();
    this.groups = new Map(); // `${faction}:${type}` → { mesh, capacity, used }
    this.unitGeometries = [];
    this.projectiles = [];
    this.structureStates = new Map();
    this.overlays = [];
    this.deployType = null;
    this.markerValid = true;

    this._matrix = new THREE.Matrix4();
    this._color = new THREE.Color();
    this._position = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
    this._scale = new THREE.Vector3();
    this._euler = new THREE.Euler();

    this.barsBg = null;
    this.barsFill = null;
    this.barWidth = 1.5;
    this.maxUnitsPerInstance = 64;
    this.particles = null;
    this.projectilePools = new Map();
    /** آخرین جهت هر واحد (تا واحد ایستاده ژستش را از دست ندهد). */
    this.facing = new Map();
  }

  get active() {
    return this.mounted;
  }

  getCharacterStats() {
    return this.characterSystem.getDebugStats();
  }

  preloadCharacters(options) {
    return this.characterSystem.preloadCharacters(options);
  }

  setQuality(settings) {
    return this.characterSystem.setQuality(settings);
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
    this.characterSystem.setReducedMotion(enabled);
  }

  /** Appearance-only override; combat stats and deterministic simulation are untouched. */
  setCharacterProfile(unitId, profileId) {
    this.proceduralOnly = false; this.preloadCharacters().catch(() => {});
    const id = String(unitId || '');
    if (!this.unitDefs.has(id)) return false;
    const defaultProfile = this.characterSystem.registry.profileForUnit(id);
    if (!profileId || profileId === defaultProfile?.id) {
      this.characterProfileOverrides.delete(id);
      return true;
    }
    if (!this.characterSystem.registry.getProfile(profileId)) return false;
    this.characterProfileOverrides.set(id, profileId);
    return true;
  }

  _profileForUnit(unitId) {
    const override = this.characterProfileOverrides.get(unitId);
    return override
      ? this.characterSystem.registry.getProfile(override)
      : this.characterSystem.registry.profileForUnit(unitId);
  }

  /* -------------------------------------------------------------- mount/unmount */

  /**
   * ساختن همهٔ ظرف‌ها برای یک نبرد. ظرفیت هر (لشکر × گونه) از آرایش نبرد
   * خوانده می‌شود تا هیچ‌وقت کم نیاید.
   */
  mount(sim) {
    this.unmount();
    this.sim = sim;
    this.mounted = true;
    this.elapsed = 0;
    this.group.visible = true;
    if (!this.proceduralOnly) this.characterSystem.preloadCharacters().catch(() => {});

    const counts = new Map();
    const bump = (faction, type) => counts.set(`${faction}:${type}`, (counts.get(`${faction}:${type}`) || 0) + 1);
    for (const spawn of sim.spawnQueue) bump(BATTLE_FACTION.RAIDER, spawn.unit);
    for (const [type, total] of Object.entries(sim.garrison || {})) {
      for (let i = 0; i < total; i += 1) bump(BATTLE_FACTION.DEFENDER, type);
    }
    for (const unit of sim.units) bump(unit.faction, unit.type);

    for (const def of this.unitsData.units) {
      for (const faction of [BATTLE_FACTION.DEFENDER, BATTLE_FACTION.RAIDER]) {
        const key = `${faction}:${def.id}`;
        const capacity = Math.min(this.maxUnitsPerInstance, Math.max(4, (counts.get(key) || 0) + 2));
        const palette = faction === BATTLE_FACTION.DEFENDER ? BATTLE_PALETTES.defender : BATTLE_PALETTES.raider;
        const geometry = createUnitGeometry(def.id, palette, def.render);
        const pose = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
        pose.setUsage(THREE.DynamicDrawUsage); geometry.setAttribute('aPose', pose);
        this.unitGeometries.push(geometry);
        const mesh = new THREE.InstancedMesh(geometry, this.unitMaterial, capacity);
        mesh.name = `units:${key}`;
        mesh.customDepthMaterial = this.unitMaterial.userData.depthMaterial;
        mesh.castShadow = true;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        this.group.add(mesh);
        this.groups.set(key, { mesh, capacity, used: 0 });
      }
    }

    // نوار جان
    const barGeometry = createBarGeometry(0.18);
    this.unitGeometries.push(barGeometry);
    this.barsBg = new THREE.InstancedMesh(
      barGeometry,
      new THREE.MeshBasicMaterial({ color: 0x1d1712, transparent: true, opacity: 0.55, depthWrite: false }),
      96,
    );
    this.barsFill = new THREE.InstancedMesh(
      barGeometry,
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, depthWrite: false }),
      96,
    );
    for (const mesh of [this.barsBg, this.barsFill]) {
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }

    // تیر و گلولهٔ نوری
    this.projectilePools = new Map();
    for (const kind of ['arrow', 'light-bolt', 'light-ring']) {
      const geometry = createProjectileGeometry(kind);
      this.unitGeometries.push(geometry);
      const mesh = new THREE.InstancedMesh(geometry, this.unitMaterial.clone(), 28);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.visible = false;
      this.group.add(mesh);
      this.projectilePools.set(kind, { mesh, used: 0 });
    }

    // ذره‌ها
    const particleData = this.battleData.particles || {};
    this.particles = {
      dust: new ParticleField({
        count: particleData.dust?.max ?? 120,
        kind: 'dust',
        size: particleData.dust?.size ?? 1,
        color: new THREE.Color(particleData.dust?.color || '#cfc2a4').getHex(),
        lifeSeconds: particleData.dust?.lifeSeconds?.[1] ?? 1,
        riseSpeed: particleData.dust?.riseSpeed ?? 0.5,
        opacity: particleData.dust?.opacity ?? 0.55,
        seed: this.seed ^ 0x11,
      }),
      spark: new ParticleField({
        count: particleData.spark?.max ?? 100,
        kind: 'spark',
        size: particleData.spark?.size ?? 0.4,
        color: new THREE.Color(particleData.spark?.color || '#ffe6a8').getHex(),
        lifeSeconds: particleData.spark?.lifeSeconds?.[1] ?? 0.4,
        riseSpeed: particleData.spark?.riseSpeed ?? 1.6,
        opacity: particleData.spark?.opacity ?? 0.9,
        seed: this.seed ^ 0x22,
      }),
    };
    for (const field of Object.values(this.particles)) this.group.add(field.mesh);

    // حلقهٔ استقرار
    this.deployRing = createDeployRing(0.7, 1.0, 0x8ff0e0);
    this.deployRing.visible = false;
    this.group.add(this.deployRing);

    this.engine?.applyRuntimeSettingsTo(this.group);
    this.captureStructures();
    return this;
  }

  /** جای اصلی همهٔ سازه‌ها نگه داشته می‌شود تا نشانهٔ آسیب برگشت‌پذیر باشد. */
  captureStructures() {
    this.structureStates.clear();
    for (const structure of this.sim.structures) {
      const root = this.buildingView?.getEntityRoot(structure.sourceId) || null;
      if (!root) continue;
      this.structureStates.set(structure.index, {
        root,
        baseY: root.position.y,
        baseRotationZ: root.rotation.z,
        overlay: null,
        applied: -1,
      });
    }
  }

  unmount() {
    if (!this.mounted) return;
    for (const state of this.structureStates.values()) {
      state.root.rotation.z = state.baseRotationZ;
      state.root.position.y = state.baseY;
      if (state.overlay) {
        state.root.remove(state.overlay);
        state.overlay.geometry.dispose();
        state.overlay.material.dispose();
      }
    }
    for (const overlay of this.overlays) {
      overlay.geometry.dispose();
      overlay.material.dispose();
    }
    this.overlays.length = 0;
    for (const { mesh } of this.groups.values()) {
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.groups.clear();
    for (const geometry of this.unitGeometries) geometry.dispose();
    this.unitGeometries.length = 0;
    for (const mesh of [this.barsBg, this.barsFill]) {
      if (!mesh) continue;
      this.group.remove(mesh);
      mesh.material.dispose();
      mesh.dispose();
    }
    this.barsBg = null;
    this.barsFill = null;
    for (const { mesh } of this.projectilePools?.values() || []) {
      this.group.remove(mesh);
      mesh.material.dispose();
      mesh.dispose();
    }
    this.projectilePools?.clear();
    for (const field of Object.values(this.particles || {})) {
      this.group.remove(field.mesh);
      field.dispose();
    }
    this.particles = null;
    if (this.deployRing) {
      this.deployRing.traverse((node) => {
        if (node.isMesh) {
          node.geometry.dispose();
          node.material.dispose();
        }
      });
      this.group.remove(this.deployRing);
      this.deployRing = null;
    }
    this.structureStates.clear();
    this.projectiles.length = 0;
    this.facing.clear();
    this._renderRecords.length = 0; this._renderRecordsById.clear();
    this.characterSystem.releaseExcept(new Set());
    this.characterSystem.setRenderStats({ visible: 0, animated: 0, fallback: 0, culled: 0 });
    this.mounted = false;
    this.sim = null;
    this.group.visible = false;
  }

  /* ------------------------------------------------------------------- events */

  /** رویدادهای شبیه‌ساز → جلوه‌های دیداری. */
  handleEvents(events) {
    if (!this.mounted || !events) return;
    const bursts = this.battleData.particles?.bursts || {};
    for (const event of events) {
      switch (event.type) {
        case 'spawn':
        case 'deploy':
          this.burstAt('spawn', event.x, event.z, 0.05);
          break;
        case 'attack':
          this.spawnProjectile(event);
          if (!event.projectile) this.burstAt('attack', event.toX, event.toZ, 0.6);
          break;
        case 'hit':
          this.burstAt('unitHit', event.x, event.z, 0.7);
          this.characterSystem.get(event.unitId)?.playTransient('hit', 0.34);
          break;
        case 'heal':
          this.burstAt('spawn', event.toX, event.toZ, 0.9);
          break;
        case 'structure-hit':
          this.burstAt('structureHit', event.x, event.z, 0.8);
          break;
        case 'structure-down':
        case 'wall-breach':
          this.burstAt('structureDown', event.x, event.z, 1.2);
          break;
        case 'unit-down':
          this.burstAt('unitDown', event.x, event.z, 0.4);
          break;
        default:
          break;
      }
    }
    void bursts;
  }

  burstAt(kind, x, z, height = 0.4) {
    const config = this.battleData.particles?.bursts?.[kind];
    if (!config || !this.particles) return;
    const ground = this.particles.dust ? 0.05 : 0;
    if (config.dust > 0) this.particles.dust.burst(x, ground + height, z, { count: config.dust });
    if (config.spark > 0) this.particles.spark.burst(x, ground + height + 0.3, z, { count: config.spark });
  }

  spawnProjectile(event) {
    const pool = this.projectilePools?.get(event.projectile);
    if (!pool) return;
    // سرعت تیر از داده می‌آید (واحد دنیا بر ثانیه) تا زمان پرواز دیداری
    // با فاصله هم‌خوان باشد.
    const speeds = this.battleData?.particles?.projectileSpeeds || {};
    const speed = speeds[event.projectile] || 20;
    const dx = event.toX - event.fromX;
    const dz = event.toZ - event.fromZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const duration = Math.min(0.5, Math.max(0.12, distance / speed));
    this.projectiles.push({
      kind: event.projectile,
      ax: event.fromX,
      az: event.fromZ,
      bx: event.toX,
      bz: event.toZ,
      t: 0,
      duration,
    });
  }

  /* ---------------------------------------------------------------- deploy UI */

  setDeployType(type) {
    this.deployType = type || null;
    if (this.deployRing) this.deployRing.visible = Boolean(type) && this.mounted;
  }

  setPointer(x, z, valid = true) {
    if (!this.deployRing) return;
    this.markerValid = valid;
    this.deployRing.position.set(x, 0.12, z);
    const color = valid ? 0x8ff0e0 : 0xd9822f;
    this.deployRing.traverse((node) => {
      if (node.isMesh) node.material.color.setHex(color);
    });
  }

  clearPointer() {
    if (this.deployRing) this.deployRing.visible = false;
  }

  /* -------------------------------------------------------------------- frame */

  update(dt) {
    if (!this.mounted || !this.sim) return;
    this.elapsed += dt;
    const pose = this.unitMaterial.userData.pose;
    pose.time.value = this.elapsed;
    const policy = this.unitsData.rendering || {};
    pose.strength.value = this.reducedMotion || (this.rig?.distance > policy.shaderPoseDistance) || (this.engine?.stats?.frameMs > policy.poseMaxFrameMs) ? 0 : 1;
    const battle = this.getBattle ? this.getBattle() : null;
    const alpha = battle && battle.alpha != null ? Math.max(0, Math.min(1, battle.alpha)) : 1;
    const camera = this.rig?.camera || null;

    this.renderUnits(alpha, camera);
    this.renderProjectiles(dt);
    for (const field of Object.values(this.particles || {})) field.update(dt, camera);
    this.renderStructures();

    if (this.deployRing && this.deployRing.visible) {
      this.deployRing.rotation.y += dt * 0.7;
      const pulse = 1 + Math.sin(this.elapsed * 3.2) * 0.06;
      this.deployRing.scale.setScalar(pulse);
    }
  }

  renderUnits(alpha, camera) {
    for (const group of this.groups.values()) group.used = 0;
    let barCount = 0;
    let culled = 0;
    let animated = 0;
    let fallbackCount = 0;
    const bars = { bg: this.barsBg, fill: this.barsFill };
    const barQuat = camera ? camera.quaternion : null;
    const records = this._renderRecords;
    records.length = 0;

    if (camera) {
      camera.updateMatrixWorld(true);
      this._viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this._frustum.setFromProjectionMatrix(this._viewProjection);
    }

    for (const unit of this.sim.units) {
      if (unit.removed) continue;
      const x = unit.prevX + (unit.x - unit.prevX) * alpha;
      const z = unit.prevZ + (unit.z - unit.prevZ) * alpha;
      this._frustumPoint.set(x, 0.9, z);
      if (camera && !this._frustum.containsPoint(this._frustumPoint)) {
        culled += 1;
        continue;
      }

      const dx = unit.x - unit.prevX;
      const dz = unit.z - unit.prevZ;
      if (dx || dz) this.facing.set(unit.id, Math.atan2(dx, dz));

      let scale = 1;
      let tint = 1;
      if (unit.state === 'down' || unit.state === 'retreat') {
        const fadeTicks = this.sim.ticksOf(unit, unit.state === 'down' ? 'fade' : 'retreat');
        const progress = Math.min(1, unit.stateTicks / Math.max(1, fadeTicks));
        scale = unit.state === 'down' ? Math.max(0, 1 - progress) : 0.82 - progress * 0.1;
        tint = 0.72 + progress * 0.2;
      } else if (unit.state === 'attack') {
        scale = 1 + Math.max(0, Math.sin((unit.stateTicks % 12) / 12 * Math.PI)) * 0.03;
      }
      if (scale <= 0.02) continue;

      const id = String(unit.id);
      let record = this._renderRecordsById.get(id);
      if (!record) {
        record = { id };
        this._renderRecordsById.set(id, record);
      }
      record.unit = unit;
      record.x = x;
      record.z = z;
      record.dx = dx;
      record.dz = dz;
      record.scale = scale;
      record.tint = tint;
      record.heading = this.facing.get(unit.id) ?? 0;
      record.distanceSq = camera
        ? camera.position.distanceToSquared(this._frustumPoint)
        : 0;
      record.profile = this._profileForUnit(unit.type);
      record.rigged = false;
      records.push(record);
    }

    // Spend the animation budget on nearby, visible units; first select one
    // representative per role/faction, then fill remaining slots by distance.
    records.sort((a, b) => (a.distanceSq - b.distanceSq) || (a.unit.id - b.unit.id));
    const selected = this._selectedCharacterIds;
    selected.clear();
    const diverse = this._preferredCharacterKeys;
    diverse.clear();
    const maxAnimated = this.proceduralOnly ? 0 : this.characterSystem.maxAnimatedUnits;
    const maxDistanceSq = this.characterSystem.maxAnimationDistance ** 2;
    let chosen = 0;
    for (const record of records) {
      if (chosen >= maxAnimated) break;
      if (!record.profile || record.distanceSq > maxDistanceSq) continue;
      const preference = `${record.profile.modelId}:${record.unit.faction}`;
      if (diverse.has(preference)) continue;
      record.rigged = true;
      selected.add(record.id);
      diverse.add(preference);
      chosen += 1;
    }
    if (chosen < maxAnimated) {
      for (const record of records) {
        if (chosen >= maxAnimated) break;
        if (record.rigged || !record.profile || record.distanceSq > maxDistanceSq) continue;
        record.rigged = true;
        selected.add(record.id);
        chosen += 1;
      }
    }
    this.characterSystem.releaseExcept(selected);

    for (const record of records) {
      const unit = record.unit;
      let isRigged = false;
      if (record.rigged) {
        const character = this.characterSystem.acquire(record.id, record.profile.id, unit.faction);
        if (character) {
          character.setTransform({
            x: record.x,
            y: 0,
            z: record.z,
            rotation: record.heading + (Number(this.characterSystem.registry.getModel(record.profile.modelId)?.yawOffset) || 0),
            scale: record.scale,
          });
          character.setAnimation(this._animationForUnit(unit));
          character.setVisible(character.ready);
          isRigged = character.ready;
          if (isRigged) animated += 1;
        }
      }

      if (!isRigged) {
        const key = `${unit.faction}:${unit.type}`;
        const group = this.groups.get(key);
        if (group && group.used < group.capacity) {
          this._euler.set(0, record.heading, 0);
          this._quat.setFromEuler(this._euler);
          this._position.set(record.x, 0, record.z);
          this._scale.setScalar(record.scale);
          this._matrix.compose(this._position, this._quat, this._scale);
          group.mesh.setMatrixAt(group.used, this._matrix);
          this._color.setScalar(record.tint);
          group.mesh.setColorAt(group.used, this._color);
          const state = unit.state === 'down' ? 5 : unit.state === 'retreat' ? 4 : unit.state === 'move' ? 1 : unit.state === 'attack' ? (unit.role === 'support' ? 3 : 2) : 0;
          const fade = unit.state === 'down' ? Math.min(1, unit.stateTicks / this.sim.ticksOf(unit, 'fade')) : 0;
          group.mesh.geometry.attributes.aPose.setXYZW(group.used, state, unit.id * 1.618, unit.stateTicks, fade);
          group.used += 1;
          fallbackCount += 1;
        }
      }

      // Health bars remain instanced and only use visible units.
      if (barCount < 96 && unit.state !== 'down') {
        const ratio = Math.max(0, Math.min(1, unit.hp / unit.maxHp));
        const barY = 1.85;
        this._quat.copy(barQuat || IDENTITY_Q);
        this._position.set(record.x - this.barWidth / 2, barY, record.z);
        this._scale.set(this.barWidth, 1, 1);
        this._matrix.compose(this._position, this._quat, this._scale);
        bars.bg.setMatrixAt(barCount, this._matrix);
        this._position.set(record.x - this.barWidth / 2, barY, record.z - 0.01);
        this._scale.set(this.barWidth * ratio, 1, 1);
        this._matrix.compose(this._position, this._quat, this._scale);
        bars.fill.setMatrixAt(barCount, this._matrix);
        this._color.setHex(healthColor(ratio));
        bars.fill.setColorAt(barCount, this._color);
        barCount += 1;
      }
    }

    for (const group of this.groups.values()) {
      group.mesh.count = group.used;
      group.mesh.instanceMatrix.needsUpdate = true;
      group.mesh.geometry.attributes.aPose.needsUpdate = true;
      if (group.mesh.instanceColor) group.mesh.instanceColor.needsUpdate = true;
    }
    bars.bg.count = barCount;
    bars.fill.count = barCount;
    bars.bg.instanceMatrix.needsUpdate = true;
    bars.fill.instanceMatrix.needsUpdate = true;
    if (bars.fill.instanceColor) bars.fill.instanceColor.needsUpdate = true;
    this.characterSystem.setRenderStats({ visible: records.length, animated, fallback: fallbackCount, culled });
  }

  _animationForUnit(unit) {
    if (unit.state === 'down') return 'death';
    if (unit.state === 'retreat' || unit.state === 'move') return 'run';
    if (unit.state === 'attack') {
      const definition = this.unitDefs.get(unit.type);
      if (unit.role === 'support' || definition?.kind === 'support') return 'support';
      return definition?.projectile ? 'ranged' : 'melee';
    }
    return 'idle';
  }

  renderProjectiles(dt) {
    for (const pool of this.projectilePools?.values() || []) pool.used = 0;
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];
      projectile.t += dt;
      const ratio = Math.min(1, projectile.t / projectile.duration);
      if (ratio >= 1) {
        this.projectiles.splice(i, 1);
        continue;
      }
      const pool = this.projectilePools.get(projectile.kind);
      if (!pool || pool.used >= 28) continue;
      const x = projectile.ax + (projectile.bx - projectile.ax) * ratio;
      const z = projectile.az + (projectile.bz - projectile.az) * ratio;
      const arcHeight = projectile.kind === 'arrow' ? 1.35 : 0.9;
      const y = arcHeight + 0.4 + Math.sin(ratio * Math.PI) * 0.6;
      const dx = projectile.bx - projectile.ax;
      const dz = projectile.bz - projectile.az;
      this._euler.set(0, Math.atan2(dx, dz), 0);
      this._quat.setFromEuler(this._euler);
      this._position.set(x, y, z);
      this._scale.setScalar(1);
      this._matrix.compose(this._position, this._quat, this._scale);
      pool.mesh.setMatrixAt(pool.used, this._matrix);
      pool.used += 1;
    }
    for (const pool of this.projectilePools?.values() || []) {
      pool.mesh.count = pool.used;
      pool.mesh.visible = pool.used > 0;
      pool.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  /** نشانهٔ آسیب سازه‌ها: تیرگی، کج‌شدن دیوار شکسته و فرونشستن ملایم. */
  renderStructures() {
    for (const structure of this.sim.structures) {
      const state = this.structureStates.get(structure.index);
      if (!state) continue;
      const ratio = structure.maxHp > 0 ? structure.hp / structure.maxHp : 1;
      const level = structure.destroyed ? 2 : ratio < 1 ? 1 : 0;
      if (state.applied === level) continue;
      state.applied = level;
      if (level === 0) {
        if (state.overlay) state.overlay.visible = false;
        state.root.rotation.z = state.baseRotationZ;
        state.root.position.y = state.baseY;
        continue;
      }
      if (!state.overlay) {
        const entity = this.state.entities.get(structure.sourceId);
        const def = this.buildings?.byId?.get(structure.type) || null;
        const size = def?.size || (entity && entity.size) || [structure.w, structure.h];
        const tile = this.sim.tileSize;
        const box = new THREE.BoxGeometry(size[0] * tile * 0.9, 1.6 + size[1] * 0.15, size[1] * tile * 0.9);
        box.translate(0, 0.8 + size[1] * 0.1, 0);
        state.overlay = new THREE.Mesh(box, new THREE.MeshBasicMaterial({
          color: 0x2a1d13,
          transparent: true,
          opacity: 0.22,
          depthWrite: false,
        }));
        state.overlay.name = `damage:${structure.type}`;
        state.root.add(state.overlay);
      }
      state.overlay.visible = true;
      state.overlay.material.opacity = level === 2 ? 0.42 : 0.2;
      if (level === 2) {
        state.root.rotation.z = state.baseRotationZ + 0.012 * ((structure.index % 5) - 2);
        state.root.position.y = state.baseY - (structure.kind === 'wall' ? 0.3 : 0.12);
      }
    }
  }

  /** دوربین روی میدان نبرد (برج/مرکز شهر) می‌نشیند. */
  focusCamera(townCenter) {
    if (!this.rig) return;
    if (townCenter) this.rig.setFocus(townCenter.x, townCenter.z);
    const distance = this.battleData.camera?.battleDistance;
    if (distance) this.rig.setDistance(distance);
  }

  dispose() {
    this.unmount();
    for (const off of this._eventUnsubscribers) off();
    this._eventUnsubscribers.length = 0;
    this.characterSystem.dispose();
    this.unitMaterial.userData.depthMaterial.dispose();
    this.unitMaterial.dispose();
    this.parent.remove(this.group);
  }
}

/** رنگ نوار جان: سبز → کهربایی → آجری (هیچ رنگ خونی در بازی نیست). */
function healthColor(ratio) {
  if (ratio > 0.6) return 0x6fbf73;
  if (ratio > 0.3) return 0xd9a441;
  return 0xb2563a;
}
