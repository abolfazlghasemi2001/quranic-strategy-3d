import { clamp } from '../core/MathUtils.js';
import { createLearningState, normalizeLearningState } from './quran/LearningState.js';
import { createCampaignState, normalizeCampaignState } from './campaign/MissionState.js';
import { createArmyState, createBattleState, normalizeArmyState, normalizeBattleState } from './barracks/ArmyState.js';

/**
 * GameState — pure data model for the fixed-timestep logic layer.
 * No rendering code and no DOM access. Serializes for SaveSystem.
 */
export class GameState {
  constructor(config) {
    this.version = 6; // logic schema (save schema handled by SaveSystem)
    this.tick = 0;
    this.elapsed = 0;
    this.paused = false;
    this.lastTap = null;
    this.tapCount = 0;

    // --- economy (phase 3) ---
    const starting = config?.economy?.starting || { rizq: 500, nur: 300, hekmat: 150, gohar: 20 };
    this.resources = { ...starting };
    this.jobs = []; // build queue (see BuildQueue)
    this.lastAccrualAt = Date.now(); // global resync marker (per-entity ts is authoritative)
    this.lastDailyAt = 0; // timestamp of last daily-gohar check
    this.dailyGranted = false; // starting gohar covers day one
    this.nextEntityId = 1;
    this.nextJobId = 1;

    // --- quran learning layer (phase 4) ---
    this.learning = createLearningState();

    // --- army + battle layer (phase 5) ---
    this.army = createArmyState();
    this.battles = createBattleState();

    // --- campaign layer (phase 6): missions, stars and the active run ---
    this.campaign = createCampaignState();

    this.entities = new Map();
    this.entitySeq = 1;
  }

  nextId() {
    const id = this.entitySeq;
    this.entitySeq += 1;
    return id;
  }

  createEntity(data) {
    const id = data.id ?? this.nextId();
    const entity = {
      id,
      type: data.type,
      name: data.name,
      col: data.col,
      row: data.row,
      size: data.size,
      level: data.level ?? 1,
      status: data.status ?? 'ready', // 'building' | 'ready' | 'upgrading'
      pending: data.pending ?? 0, // accrued but unharvested production
      lastAccrualAt: data.lastAccrualAt ?? null,
      // --- phase 5: battle damage (filled by StructureStats/BattleSystem) ---
      hp: data.hp ?? null,
      maxHp: data.maxHp ?? null,
      damaged: Boolean(data.damaged),
      root: data.root ?? null, // three.js Object3D (not serialized)
    };
    this.entities.set(id, entity);
    const maxId = typeof id === 'number' ? id + 1 : this.entitySeq;
    this.entitySeq = Math.max(this.entitySeq, maxId);
    return entity;
  }

  getEntity(id) {
    return this.entities.get(id) || null;
  }

  townCenter() {
    for (const e of this.entities.values()) if (e.type === 'town-center') return e;
    return null;
  }

  cityLevel() {
    return this.townCenter()?.level ?? 1;
  }

  update(dt) {
    this.tick += 1;
    this.elapsed += dt;
  }

  recordTap(tile, now) {
    this.lastTap = { col: tile.col, row: tile.row, t: now };
    this.tapCount += 1;
  }

  setPaused(paused) {
    this.paused = !!paused;
  }

  /** Plain-object payload for SaveSystem (no three.js roots). */
  serialize() {
    return {
      version: this.version,
      tick: this.tick,
      elapsed: this.elapsed,
      tapCount: this.tapCount,
      resources: { ...this.resources },
      jobs: this.jobs.map((j) => ({ ...j })),
      lastAccrualAt: this.lastAccrualAt,
      lastDailyAt: this.lastDailyAt,
      dailyGranted: this.dailyGranted,
      learning: JSON.parse(JSON.stringify(this.learning)),
      campaign: JSON.parse(JSON.stringify(this.campaign)),
      army: JSON.parse(JSON.stringify(this.army)),
      battles: JSON.parse(JSON.stringify(this.battles)),
      nextEntityId: this.nextEntityId,
      nextJobId: this.nextJobId,
      entitySeq: this.entitySeq,
      entities: [...this.entities.values()].map((e) => ({
        id: e.id,
        type: e.type,
        name: e.name,
        col: e.col,
        row: e.row,
        size: e.size,
        level: e.level,
        status: e.status,
        pending: e.pending,
        lastAccrualAt: e.lastAccrualAt,
        hp: e.hp,
        maxHp: e.maxHp,
        damaged: e.damaged,
      })),
    };
  }

  /** Restore from a SaveSystem payload (schema-migrated). Roots rebuilt by systems. */
  hydrate(payload) {
    if (!payload || typeof payload !== 'object') return false;
    this.tick = payload.tick ?? 0;
    this.elapsed = payload.elapsed ?? 0;
    this.tapCount = payload.tapCount ?? 0;
    this.resources = { ...this.resources, ...(payload.resources || {}) };
    this.resources.rizq = clamp(this.resources.rizq || 0, 0, 1e9);
    this.resources.nur = clamp(this.resources.nur || 0, 0, 1e9);
    this.resources.hekmat = clamp(this.resources.hekmat || 0, 0, 1e9);
    this.resources.gohar = clamp(this.resources.gohar || 0, 0, 1e9);
    this.jobs = Array.isArray(payload.jobs) ? payload.jobs.map((j) => ({ ...j })) : [];
    this.lastAccrualAt = payload.lastAccrualAt ?? Date.now();
    this.lastDailyAt = payload.lastDailyAt ?? 0;
    this.dailyGranted = payload.dailyGranted ?? true;
    this.nextEntityId = payload.nextEntityId ?? 1;
    this.nextJobId = payload.nextJobId ?? 1;

    this.learning = normalizeLearningState(payload.learning);
    this.campaign = normalizeCampaignState(payload.campaign);
    this.army = normalizeArmyState(payload.army);
    this.battles = normalizeBattleState(payload.battles, { keep: 3 });
    this.entities = new Map();
    this.entitySeq = payload.entitySeq ?? 1;
    for (const data of payload.entities || []) {
      this.createEntity(data);
    }
    this.lastTap = null;
    return true;
  }
}
