import { EVENTS } from '../../core/EventBus.js';
import { createMetaState, normalizeMetaState, metaSettingsAreValid } from './MetaState.js';

const TUTORIAL_PROGRESS = [
  ['open-shop', 'shopOpened'],
  ['choose-farm', 'farmSelected'],
  ['place-farm', 'farmQueued'],
  ['wait-farm', 'firstBuilding'],
  ['harvest-first', 'firstHarvest'],
  ['first-lesson', 'firstLesson'],
  ['visit-campaign', 'campaignViewed'],
  ['visit-settings', 'settingsViewed'],
  ['visit-profile', 'profileViewed'],
  ['expand-city', 'secondBuilding'],
];

const finitePositive = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function dateKey(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function dayNumber(key) {
  const n = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(n) ? Math.floor(n / 86_400_000) : 0;
}

/**
 * MetaSystem — data-only player progression, optional daily task and FTUE.
 * All durable state lives in GameState.meta; the event bus is the only bridge
 * to the HUD. No streaks, expiry timers, absence penalties or paid rewards.
 */
export class MetaSystem {
  constructor({ state, bus, metaData, ftueData, persist = null, now = () => Date.now(), qualityTier = 'medium' }) {
    this.state = state;
    this.bus = bus;
    this.data = metaData || { progression: {}, achievements: [], dailyMissions: [] };
    this.ftue = ftueData || { steps: [], firstThirtyMinutes: [], activeSessionTargetSeconds: 1800 };
    this.persist = typeof persist === 'function' ? persist : null;
    this.now = now;
    this._timeSinceSave = 0;
    this._lastMinute = -1;
    this._lastDayKey = '';
    this.state.meta = normalizeMetaState(this.state.meta || createMetaState({ qualityTier }), { qualityTier });

    this._unsubscribers = [
      bus.on(EVENTS.SHOP_OPENED, () => this._markFlag('shopOpened')),
      bus.on(EVENTS.PLACEMENT_CHANGED, (event) => this._onPlacement(event)),
      bus.on(EVENTS.BUILDING_QUEUED, (event) => this._onBuildingQueued(event)),
      bus.on(EVENTS.JOB_FINISHED, (event) => this._onJobFinished(event)),
      bus.on(EVENTS.RESOURCE_HARVESTED, (event) => this._onHarvest(event)),
      bus.on(EVENTS.QURAN_LESSON_COMPLETED, (event) => this._onLessonCompleted(event)),
      bus.on(EVENTS.CAMPAIGN_PANEL_OPENED, () => {
        this.state.meta.stats.campaignVisits += 1;
        this._markFlag('campaignViewed', false);
        this._publishAndPersist();
      }),
      bus.on(EVENTS.SETTINGS_OPENED, () => {
        this._markFlag('settingsViewed');
      }),
      bus.on(EVENTS.META_PANEL_OPENED, () => {
        this._markFlag('profileViewed');
      }),
      bus.on(EVENTS.MISSION_FINISHED, (event) => this._onStoryCompleted(event)),
    ];

    this._syncDailyMission(this.now(), false);
    this._syncTutorialStep(false);
  }

  get meta() {
    return this.state.meta;
  }

  get settings() {
    return { ...this.meta.settings };
  }

  /* -------------------------------------------------------------- snapshots */

  levelInfo(xp = this.meta.xp) {
    const thresholds = Array.isArray(this.data.progression?.levelThresholds)
      ? this.data.progression.levelThresholds.map((v) => Math.max(0, Number(v) || 0))
      : [0, 100, 250, 450];
    const levelIndex = Math.max(0, thresholds.reduce((found, threshold, index) => (xp >= threshold ? index : found), 0));
    const currentXp = thresholds[levelIndex] ?? 0;
    const nextXp = thresholds[levelIndex + 1] ?? null;
    const progress = nextXp == null ? 1 : Math.max(0, Math.min(1, (xp - currentXp) / Math.max(1, nextXp - currentXp)));
    return {
      level: levelIndex + 1,
      xp,
      currentXp,
      nextXp,
      progress,
      xpToNext: nextXp == null ? 0 : Math.max(0, nextXp - xp),
    };
  }

  dailySnapshot() {
    const daily = this.meta.dailyMission;
    const definition = this.data.dailyMissions.find((entry) => entry.id === daily.id) || null;
    if (!definition) return null;
    const target = Math.max(1, Number(definition.target) || 1);
    return {
      ...definition,
      progress: Math.min(target, daily.progress),
      target,
      completed: Boolean(daily.completed),
      assignedDate: daily.assignedDate,
      completedDate: daily.completedDate,
      progressRatio: Math.min(1, daily.progress / target),
    };
  }

  tutorialSnapshot() {
    const onboarding = this.meta.onboarding;
    const replaying = Number.isInteger(onboarding.replayIndex);
    const steps = this.ftue.steps || [];
    const currentId = onboarding.stepId;
    const index = replaying ? onboarding.replayIndex : Math.max(0, steps.findIndex((step) => step.id === currentId));
    const step = replaying ? steps[onboarding.replayIndex] || null : steps.find((entry) => entry.id === currentId) || null;
    const coreKeys = this.ftue.coreMilestones || ['firstBuilding', 'firstHarvest', 'firstLesson'];
    const coreComplete = coreKeys.every((key) => Boolean(onboarding.flags[key]));
    return {
      ...onboarding,
      active: onboarding.status === 'active' || replaying,
      replaying,
      step,
      stepIndex: index,
      totalSteps: steps.length,
      coreComplete,
      playMinutes: Math.floor(onboarding.playSeconds / 60),
      targetMinutes: Math.ceil((this.ftue.activeSessionTargetSeconds || 1800) / 60),
    };
  }

  timelineSnapshot() {
    const flags = this.meta.onboarding.flags;
    return (this.ftue.firstThirtyMinutes || []).map((entry) => ({
      ...entry,
      done: this._timelineMilestoneDone(entry.milestone, flags),
      suggested: this.meta.onboarding.playSeconds >= Math.max(0, Number(entry.minute) || 0) * 60,
    }));
  }

  snapshot() {
    const level = this.levelInfo();
    const achievements = (this.data.achievements || []).map((definition) => ({
      ...definition,
      unlockedAt: this.meta.achievements[definition.id]?.unlockedAt ?? null,
      unlocked: this.meta.achievements[definition.id]?.unlockedAt != null,
      progress: Math.min(Number(definition.target) || 1, Number(this.meta.stats[definition.stat]) || 0),
      target: Math.max(1, Number(definition.target) || 1),
    }));
    return {
      ...level,
      stats: { ...this.meta.stats },
      achievements,
      dailyMission: this.dailySnapshot(),
      tutorial: this.tutorialSnapshot(),
      timeline: this.timelineSnapshot(),
      settings: this.settings,
    };
  }

  /* ------------------------------------------------------------- live time */

  onBoot(now = this.now()) {
    this._syncDailyMission(now, false);
    this._syncTutorialStep(false);
    this._lastDayKey = dateKey(now);
    this._lastMinute = Math.floor(this.meta.onboarding.playSeconds / 60);
    this._publish();
  }

  update(dt) {
    const delta = Math.max(0, Number(dt) || 0);
    if (delta <= 0) return;
    const now = this.now();
    const onboarding = this.meta.onboarding;
    const targetSeconds = Math.max(1, Number(this.ftue.activeSessionTargetSeconds) || 1800);
    onboarding.playSeconds = Math.min(targetSeconds, onboarding.playSeconds + delta);

    const currentMinute = Math.floor(onboarding.playSeconds / 60);
    let changed = currentMinute !== this._lastMinute;
    if (changed) this._lastMinute = currentMinute;

    const today = dateKey(now);
    if (today !== this._lastDayKey) {
      this._lastDayKey = today;
      changed = this._syncDailyMission(now, false) || changed;
    }

    if (onboarding.status === 'active' && onboarding.playSeconds >= targetSeconds && this.tutorialSnapshot().coreComplete) {
      onboarding.status = 'completed';
      onboarding.completedAt = now;
      onboarding.replayIndex = null;
      this.bus.emit(EVENTS.FTUE_COMPLETED, { at: now, playSeconds: onboarding.playSeconds });
      this._publishAndPersist();
      return;
    }

    this._timeSinceSave += delta;
    if (this._timeSinceSave >= 30) {
      this._timeSinceSave %= 30;
      this._persist();
    }
    if (changed) this._publish();
  }

  /* -------------------------------------------------------------- settings */

  setSetting(key, value) {
    const next = { ...this.meta.settings };
    if (key === 'qualityTier' && ['low', 'medium', 'high'].includes(value)) next.qualityTier = value;
    else if (key === 'batterySaver') next.batterySaver = Boolean(value);
    else if (key === 'soundEnabled') next.soundEnabled = Boolean(value);
    else if (key === 'language' && ['fa-IR', 'fa-AF'].includes(value)) next.language = value;
    else return false;
    if (!metaSettingsAreValid(next)) return false;
    if (JSON.stringify(next) === JSON.stringify(this.meta.settings)) return false;
    this.meta.settings = next;
    this.bus.emit(EVENTS.SETTINGS_CHANGED, { ...next });
    this._publishAndPersist();
    return true;
  }

  /* --------------------------------------------------------------- tutorial */

  _onPlacement(event) {
    if (!event?.active || event.def?.id !== 'farm') return;
    this._markFlag('farmSelected');
  }

  _onBuildingQueued({ job, entity } = {}) {
    if (!job || job.kind !== 'build') return;
    if (job.type === 'farm') {
      this.meta.onboarding.flags.shopOpened = true;
      this.meta.onboarding.flags.farmSelected = true;
      this._markFlag('farmQueued', false);
    }
    this._publishAndPersist();
  }

  _onJobFinished({ job, entity } = {}) {
    if (!job || job.kind !== 'build' || !entity) return;
    this.meta.stats.buildingsBuilt += 1;
    this._awardXp(this.data.progression?.eventXp?.buildingCompleted, 'building');
    this._advanceDaily('build', 1);
    const flags = this.meta.onboarding.flags;
    if (job.type === 'farm') {
      flags.shopOpened = true;
      flags.farmSelected = true;
      flags.farmQueued = true;
      flags.firstBuilding = true;
    }
    if (this.meta.stats.buildingsBuilt >= 2) flags.secondBuilding = true;
    this._checkAchievements();
    this._syncTutorialStep(false);
    this._publishAndPersist();
  }

  _onHarvest(event = {}) {
    const amount = finitePositive(event.moved);
    if (amount <= 0) return;
    this.meta.stats.harvests += 1;
    this.meta.stats.resourcesHarvested += amount;
    this._awardXp(this.data.progression?.eventXp?.harvest, 'harvest');
    this._advanceDaily('harvest', 1);
    if (event.type === 'farm' || event.resource === 'rizq') this._markFlag('firstHarvest');
    this._checkAchievements();
    this._publishAndPersist();
  }

  _onLessonCompleted(payload = {}) {
    if (payload.report?.kind && payload.report.kind !== 'lesson') return;
    this.meta.stats.lessonsCompleted += 1;
    this._awardXp(this.data.progression?.eventXp?.lessonCompleted, 'lesson');
    this._advanceDaily('lesson', 1);
    this._markFlag('firstLesson', false);
    this._checkAchievements();
    this._publishAndPersist();
  }

  _onStoryCompleted(report = {}) {
    if (report.failed) return;
    this.meta.stats.storiesCompleted += 1;
    this._awardXp(this.data.progression?.eventXp?.storyCompleted, 'story');
    this._checkAchievements();
    this._publishAndPersist();
  }

  _markFlag(flag, publish = true) {
    if (!Object.hasOwn(this.meta.onboarding.flags, flag) || this.meta.onboarding.flags[flag]) return false;
    this.meta.onboarding.flags[flag] = true;
    this._syncTutorialStep(false);
    if (publish) this._publishAndPersist();
    return true;
  }

  _syncTutorialStep(publish = true) {
    const onboarding = this.meta.onboarding;
    if (onboarding.status !== 'active' || Number.isInteger(onboarding.replayIndex)) return;
    const flags = onboarding.flags;
    const skipped = new Set(onboarding.skippedSteps);
    let nextId = 'free-play';
    for (const [stepId, flag] of TUTORIAL_PROGRESS) {
      if (!flags[flag] && !skipped.has(stepId)) {
        nextId = stepId;
        break;
      }
    }
    if (onboarding.stepId === nextId) return;
    onboarding.stepId = nextId;
    if (publish) this._publishAndPersist();
    else this.bus.emit(EVENTS.FTUE_CHANGED, this.tutorialSnapshot());
  }

  advanceTutorialHint() {
    const onboarding = this.meta.onboarding;
    if (onboarding.status !== 'active' || Number.isInteger(onboarding.replayIndex)) return false;
    const current = onboarding.stepId;
    if (!current || current === 'free-play') return false;
    if (!onboarding.skippedSteps.includes(current)) onboarding.skippedSteps.push(current);
    this._syncTutorialStep(false);
    this._publishAndPersist();
    return true;
  }

  skipTutorial() {
    const onboarding = this.meta.onboarding;
    if (onboarding.status !== 'active' && !Number.isInteger(onboarding.replayIndex)) return false;
    onboarding.status = 'skipped';
    onboarding.replayIndex = null;
    this._publishAndPersist();
    this.bus.emit(EVENTS.FTUE_SKIPPED, {});
    return true;
  }

  replayTutorial() {
    const onboarding = this.meta.onboarding;
    if (!this.ftue.steps?.length) return false;
    onboarding.replayIndex = 0;
    this._publishAndPersist();
    return true;
  }

  stepReplay(direction = 1) {
    const onboarding = this.meta.onboarding;
    if (!Number.isInteger(onboarding.replayIndex)) return false;
    const next = onboarding.replayIndex + Math.sign(Number(direction) || 0);
    if (next < 0) return false;
    if (next >= this.ftue.steps.length) {
      onboarding.replayIndex = null;
      this._publishAndPersist();
      return true;
    }
    onboarding.replayIndex = next;
    this._publishAndPersist();
    return true;
  }

  closeReplay() {
    const onboarding = this.meta.onboarding;
    if (!Number.isInteger(onboarding.replayIndex)) return false;
    onboarding.replayIndex = null;
    this._publishAndPersist();
    return true;
  }

  /* --------------------------------------------------------------- daily */

  _syncDailyMission(now, publish = true) {
    const key = dateKey(now);
    const daily = this.meta.dailyMission;
    const known = this.data.dailyMissions.find((entry) => entry.id === daily.id);
    let changed = false;

    // An unfinished task is deliberately carried across days. Only a completed
    // task can rotate, and missing a day never queues missed work or penalties.
    if (!known || (!daily.completed && !daily.id)) {
      const mission = this._missionForDay(key);
      Object.assign(daily, { id: mission?.id || null, progress: 0, completed: false, assignedDate: key, completedDate: null });
      changed = true;
    } else if (daily.completed && daily.completedDate !== key) {
      daily.history.push({ id: daily.id, completedDate: daily.completedDate });
      if (daily.history.length > 30) daily.history.splice(0, daily.history.length - 30);
      const mission = this._missionForDay(key);
      Object.assign(daily, { id: mission?.id || null, progress: 0, completed: false, assignedDate: key, completedDate: null });
      changed = true;
    }

    if (publish && changed) this._publishAndPersist();
    return changed;
  }

  _missionForDay(key) {
    const missions = this.data.dailyMissions || [];
    if (!missions.length) return null;
    const index = ((dayNumber(key) % missions.length) + missions.length) % missions.length;
    return missions[index];
  }

  _advanceDaily(eventName, amount) {
    const daily = this.meta.dailyMission;
    if (daily.completed) return false;
    const mission = this.data.dailyMissions.find((entry) => entry.id === daily.id);
    if (!mission || mission.event !== eventName) return false;
    daily.progress = Math.min(Math.max(1, Number(mission.target) || 1), daily.progress + Math.max(0, Number(amount) || 0));
    if (daily.progress >= Math.max(1, Number(mission.target) || 1)) {
      daily.completed = true;
      daily.completedDate = dateKey(this.now());
      this._awardXp(this.data.progression?.eventXp?.dailyMissionCompleted, 'daily-mission');
      this.bus.emit(EVENTS.DAILY_MISSION_COMPLETED, this.dailySnapshot());
    }
    return true;
  }

  /* ---------------------------------------------------------- XP/achievements */

  _awardXp(amount, source) {
    const value = Math.floor(finitePositive(amount));
    if (value <= 0) return null;
    const before = this.levelInfo();
    this.meta.xp += value;
    const after = this.levelInfo();
    const result = { amount: value, source, totalXp: this.meta.xp, level: after.level, levelUp: after.level > before.level };
    this.meta.level = after.level;
    this.bus.emit(EVENTS.META_XP_AWARDED, result);
    if (result.levelUp) this.bus.emit(EVENTS.META_LEVEL_UP, { ...after, source });
    return result;
  }

  _checkAchievements() {
    for (const definition of this.data.achievements || []) {
      if (this.meta.achievements[definition.id]?.unlockedAt != null) continue;
      const target = Math.max(1, Number(definition.target) || 1);
      const progress = Number(this.meta.stats[definition.stat]) || 0;
      if (progress < target) continue;
      const unlockedAt = this.now();
      this.meta.achievements[definition.id] = { unlockedAt };
      this._awardXp(definition.xp, `achievement:${definition.id}`);
      this.bus.emit(EVENTS.META_ACHIEVEMENT_UNLOCKED, {
        achievement: { ...definition, unlockedAt },
      });
    }
  }

  /* --------------------------------------------------------------- helpers */

  _timelineMilestoneDone(milestone, flags) {
    switch (milestone) {
      case 'firstBuilding': return Boolean(flags.firstBuilding);
      case 'firstHarvest': return Boolean(flags.firstHarvest);
      case 'firstLesson': return Boolean(flags.firstLesson);
      case 'secondBuilding': return Boolean(flags.secondBuilding);
      case 'campaignViewed': return Boolean(flags.campaignViewed);
      case 'settingsAndProfileViewed': return Boolean(flags.settingsViewed && flags.profileViewed);
      case 'thirtyMinutes': return this.meta.onboarding.playSeconds >= (this.ftue.activeSessionTargetSeconds || 1800);
      default: return false;
    }
  }

  _publish() {
    this.bus.emit(EVENTS.META_CHANGED, this.snapshot());
    this.bus.emit(EVENTS.FTUE_CHANGED, this.tutorialSnapshot());
  }

  _publishAndPersist() {
    this._publish();
    this._persist();
  }

  _persist() {
    if (this.persist) this.persist();
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;
  }
}
