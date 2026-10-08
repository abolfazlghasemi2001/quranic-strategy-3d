/**
 * MissionZone — نشانگرهای سه‌بعدی مأموریت‌های کمپین (فاز ۶). لایهٔ رندر.
 *
 * قواعد این فایل:
 *   • فقط هندسهٔ low-poly ساخته‌شده با کد؛ نه تکسچر باینری، نه فایل بیرونی.
 *   • هیچ متنی — و به‌ویژه هیچ متن قرآنی — روی هیچ سطح یا نشانگری نمی‌آید
 *     (نه روی زمین، نه روی سازه و نه در افکت‌ها). این ماژول هیچ چیزی از لایهٔ
 *     قرآنی import نمی‌کند و فقط وضعیت عددی مأموریت را از یک provider می‌خواند.
 *   • هیچ تصویری از پیامبران/فرشتگان و هیچ عنصر خشن (سلاح، خون، جسد) ندارد؛
 *     نشانگرها سنگ، آب، باغ و بنا هستند.
 *
 * نشانگرها فقط زمانی ساخته می‌شوند که مأموریتی فعال باشد؛ در حالت عادی گروه
 * خالی است و هزینهٔ رسم صفر دارد.
 */
import * as THREE from 'three';
import { EVENTS } from '../core/EventBus.js';

const PLOT_KIND = {
  DAM: 'dam-segment',
  CANAL: 'canal',
  GARDEN: 'garden',
};

export class MissionZone {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {THREE.Object3D} options.parent — معمولاً world.group
   * @param {() => object|null} options.getSnapshot — CampaignSystem.snapshot()
   * @param {import('../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ config, parent, getSnapshot, bus = null, engine = null }) {
    this.config = config;
    this.parent = parent;
    this.getSnapshot = getSnapshot;
    this.bus = bus;
    this.engine = engine;
    this.group = new THREE.Group();
    this.group.name = 'mission-zone';
    this.group.visible = false;
    parent?.add(this.group);

    const colors = config?.campaign?.zone?.colors || {};
    const heights = config?.campaign?.zone?.propHeight || {};
    this.heights = {
      damSegment: Number(heights.damSegment) || 1.25,
      canal: Number(heights.canal) || 0.22,
      garden: Number(heights.garden) || 0.5,
    };

    this.materials = {
      plot: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.plot || '#7fd0c3'), emissive: 0x0d3b3f, roughness: 0.6, transparent: true, opacity: 0.55 }),
      plotDone: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.plotDone || '#9ed67a'), emissive: 0x1c3a1a, roughness: 0.6, transparent: true, opacity: 0.5 }),
      stone: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.stone || '#9a938a'), roughness: 0.85 }),
      damaged: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.damaged || '#e0a13c'), roughness: 0.8 }),
      danger: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.danger || '#d9584a'), roughness: 0.8 }),
      water: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.water || '#4a9fd8'), emissive: 0x0f3a52, emissiveIntensity: 0.35, roughness: 0.22, transparent: true, opacity: 0.85 }),
      garden: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.garden || '#6fbf73'), roughness: 0.85 }),
      gardenDry: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.gardenDry || '#b6a15c'), roughness: 0.9 }),
      reserve: new THREE.MeshStandardMaterial({ color: new THREE.Color(colors.reserve || '#ffd77a'), emissive: 0x6b4a12, emissiveIntensity: 0.4, roughness: 0.4, transparent: true, opacity: 0.9 }),
    };

    /** @type {{mesh:THREE.Mesh, plot:object, kind:string, part:string}[]} */
    this.parts = [];
    this.signature = null;
    this.reserveBar = null;
    this._acc = 0;
    this._snapshot = null;
    this._unsubscribers = [];
    if (this.bus) {
      this._unsubscribers.push(this.bus.on(EVENTS.MISSION_FINISHED, () => this.clear()));
      this._unsubscribers.push(this.bus.on(EVENTS.MISSION_ABORTED, () => this.clear()));
    }
  }

  /* ------------------------------------------------------------------ build */

  _tileCenter(col, row, size) {
    const tile = this.config.tileSize;
    const w = (size?.[0] || 1) * tile;
    const d = (size?.[1] || 1) * tile;
    return { x: (col + (size?.[0] || 1) / 2) * tile, z: (row + (size?.[1] || 1) / 2) * tile, w, d };
  }

  /** مأموریت کامل (دارای نشانگرها) از نقشهٔ مأموریت‌ها خوانده می‌شود. */
  _missionFor(active) {
    return this._missions?.get?.(active?.missionId) || null;
  }

  /** شمارش نشانگرهای یک مأموریت (برای بازسازی در صورت تغییر داده). */
  plotCount(active) {
    return this._missionFor(active)?.plots?.length || 0;
  }

  /** ساخت نشانگرهای یک مأموریت. فقط وقتی مأموریت فعال است صدا زده می‌شود. */
  build(active) {
    this.clear();
    const mission = this._missionFor(active);
    const plots = mission?.plots || [];
    if (!mission) return this.group;

    for (const plot of plots) {
      const center = this._tileCenter(plot.col, plot.row, plot.size);
      // حلقهٔ نشانگر روی زمین (کم‌ارتفاع، بدون هیچ متن).
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(Math.min(center.w, center.d) * 0.42, Math.min(center.w, center.d) * 0.5, 20),
        this.materials.plot,
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(center.x, 0.06, center.z);
      ring.name = `plot:${plot.id}`;
      this.group.add(ring);
      this.parts.push({ mesh: ring, plot, kind: plot.kind, part: 'ring' });

      if (plot.kind === PLOT_KIND.DAM) {
        // پایهٔ سنگی دهانه + جبههٔ آب پشت آن.
        const base = new THREE.Mesh(new THREE.BoxGeometry(center.w * 0.96, 0.22, center.d * 0.96), this.materials.stone);
        base.position.set(center.x, 0.11, center.z);
        base.receiveShadow = true;
        this.group.add(base);
        this.parts.push({ mesh: base, plot, kind: plot.kind, part: 'base' });

        const block = new THREE.Mesh(new THREE.BoxGeometry(center.w * 0.86, this.heights.damSegment, center.d * 0.86), this.materials.stone);
        block.castShadow = true;
        block.receiveShadow = true;
        block.position.set(center.x, this.heights.damSegment / 2 + 0.22, center.z);
        block.visible = false;
        this.group.add(block);
        this.parts.push({ mesh: block, plot, kind: plot.kind, part: 'block' });

        const spray = new THREE.Mesh(new THREE.ConeGeometry(center.w * 0.18, 0.7, 7), this.materials.water);
        spray.position.set(center.x, 0.55, center.z + center.d * 0.6);
        spray.visible = false;
        this.group.add(spray);
        this.parts.push({ mesh: spray, plot, kind: plot.kind, part: 'spray' });
      } else if (plot.kind === PLOT_KIND.CANAL) {
        const water = new THREE.Mesh(new THREE.BoxGeometry(center.w * 0.9, this.heights.canal, center.d * 0.5), this.materials.water);
        water.position.set(center.x, this.heights.canal / 2 + 0.02, center.z);
        water.visible = false;
        this.group.add(water);
        this.parts.push({ mesh: water, plot, kind: plot.kind, part: 'water' });
      } else if (plot.kind === PLOT_KIND.GARDEN) {
        const bed = new THREE.Mesh(new THREE.BoxGeometry(center.w * 0.8, this.heights.garden, center.d * 0.8), this.materials.gardenDry);
        bed.position.set(center.x, this.heights.garden / 2, center.z);
        bed.castShadow = true;
        bed.visible = false;
        this.group.add(bed);
        this.parts.push({ mesh: bed, plot, kind: plot.kind, part: 'bed' });
      }
    }

    // مأموریت انبارداری نشانگر زمینی ندارد؛ به‌جای آن یک ستون اندازهٔ ذخیره
    // نزدیک مرکز نقشه ساخته می‌شود که نسبت ذخیره به هدف را نشان می‌دهد.
    if (mission.rules?.kind === 'plenty-famine') {
      const center = this.config.mapCenter;
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 1, 10), this.materials.reserve);
      bar.position.set(center.x, 0.5, center.z - 8);
      bar.name = 'reserve-column';
      this.group.add(bar);
      this.reserveBar = bar;
    }

    this.group.visible = true;
    this.engine?.applyRuntimeSettingsTo(this.group);
    return this.group;
  }

  clear() {
    for (const part of this.parts) {
      part.mesh.geometry?.dispose?.();
      this.group.remove(part.mesh);
    }
    this.parts.length = 0;
    if (this.reserveBar) {
      this.reserveBar.geometry?.dispose?.();
      this.group.remove(this.reserveBar);
      this.reserveBar = null;
    }
    this.group.visible = false;
    this.signature = null;
  }

  /* ----------------------------------------------------------------- update */

  /**
   * هر فریم از حلقهٔ موتور صدا زده می‌شود، ولی فقط ~۵ بار در ثانیه کار می‌کند.
   */
  update(dt) {
    this._acc += dt;
    if (this._acc < 0.2) return;
    this._acc = 0;
    const snapshot = typeof this.getSnapshot === 'function' ? this.getSnapshot() : null;
    const active = snapshot?.active || null;
    this._snapshot = snapshot;
    if (!active) {
      if (this.group.visible) this.clear();
      return;
    }
    const signature = `${active.missionId}:${active.ruleKind}:${this.plotCount(active)}`;
    if (this.signature !== signature) {
      this.signature = signature;
      this.build(active);
    }
    this.refresh(active);
  }

  /** مأموریت‌ها را از بیرون می‌گیرد (بدون وابستگی به لایهٔ منطق). */
  setMissions(missionMap) {
    this._missions = missionMap;
    return this;
  }

  /** به‌روزرسانی رنگ/اندازهٔ نشانگرها بر پایهٔ وضعیت عددی مأموریت. */
  refresh(active) {
    if (!active || !this.group.visible) return;
    const progress = active.progress || {};
    const actions = active.actions || [];

    for (const part of this.parts) {
      if (part.kind !== PLOT_KIND.DAM) continue;
      const entry = actions.find((action) => action.plotId === part.plot.id) || null;
      const built = entry ? entry.status === 'ready' : false;
      const integrity = entry && typeof entry.integrity === 'number' ? entry.integrity : (built ? 1 : 0);
      if (part.part === 'ring') {
        part.mesh.material = built ? this.materials.plotDone : this.materials.plot;
      } else if (part.part === 'block') {
        part.mesh.visible = built || entry?.status === 'building';
        if (!built && entry?.status === 'building') {
          // در حال ساخت: بلوک کوتاه‌تر و کج (نمای کار نیمه‌کاره).
          part.mesh.scale.set(1, 0.45, 1);
        } else {
          part.mesh.scale.set(1, 1, 1);
        }
        if (built) {
          const ratio = Math.max(0, Math.min(1, integrity));
          part.mesh.material = ratio >= 0.7 ? this.materials.stone : ratio >= 0.35 ? this.materials.damaged : this.materials.danger;
        }
      } else if (part.part === 'spray') {
        part.mesh.visible = built && integrity < 0.5;
      }
    }

    for (const part of this.parts) {
      if (part.kind === PLOT_KIND.CANAL && part.part === 'water') {
        const entry = actions.find((action) => action.plotId === part.plot.id);
        part.mesh.visible = entry?.status === 'ready';
      }
      if (part.kind === PLOT_KIND.GARDEN && part.part === 'bed') {
        const entry = actions.find((action) => action.plotId === part.plot.id);
        part.mesh.visible = entry != null && entry.status !== 'empty';
        part.mesh.material = entry?.status === 'lost' ? this.materials.gardenDry : this.materials.garden;
      }
    }

    if (this.reserveBar) {
      const reserve = Number(progress.reserve) || 0;
      const target = Math.max(1, Number(progress.reserveTarget) || 1);
      const ratio = Math.max(0.05, Math.min(1, reserve / target));
      const height = 1 + ratio * 3.2;
      this.reserveBar.scale.set(1, height, 1);
      this.reserveBar.position.y = height / 2;
      this.reserveBar.material = ratio >= 0.7 ? this.materials.reserve : ratio >= 0.35 ? this.materials.damaged : this.materials.danger;
    }
  }

  /* ---------------------------------------------------------------- dispose */

  dispose() {
    for (const off of this._unsubscribers) off();
    this._unsubscribers.length = 0;
    this.clear();
    for (const material of Object.values(this.materials)) material.dispose?.();
    this.parent?.remove(this.group);
  }
}
