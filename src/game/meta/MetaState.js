const LEVELS = ['low', 'medium', 'high'];
const LANGUAGES = ['fa-IR', 'fa-AF'];
const FONT_SCALES = ['normal', 'large', 'larger'];
const TUTORIAL_STATUSES = ['active', 'skipped', 'completed'];
const STAT_KEYS = [
  'buildingsBuilt',
  'harvests',
  'resourcesHarvested',
  'lessonsCompleted',
  'storiesCompleted',
  'campaignVisits',
];
const FLAG_KEYS = [
  'shopOpened',
  'farmSelected',
  'farmQueued',
  'firstBuilding',
  'firstHarvest',
  'firstLesson',
  'campaignViewed',
  'settingsViewed',
  'profileViewed',
  'secondBuilding',
];

function safeCount(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : fallback;
}

function safeTimestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function createMetaState({ now = Date.now(), qualityTier = 'medium', tutorialStatus = 'active' } = {}) {
  return {
    version: 1,
    xp: 0,
    level: 1,
    stats: Object.fromEntries(STAT_KEYS.map((key) => [key, 0])),
    achievements: {},
    dailyMission: {
      id: null,
      progress: 0,
      completed: false,
      assignedDate: null,
      completedDate: null,
      history: [],
    },
    onboarding: {
      status: TUTORIAL_STATUSES.includes(tutorialStatus) ? tutorialStatus : 'active',
      stepId: 'open-shop',
      flags: Object.fromEntries(FLAG_KEYS.map((key) => [key, false])),
      skippedSteps: [],
      replayIndex: null,
      playSeconds: 0,
      startedAt: now,
      completedAt: null,
    },
    settings: {
      language: 'fa-IR',
      soundEnabled: true,
      recitationEnabled: false,
      qualityTier: LEVELS.includes(qualityTier) ? qualityTier : 'medium',
      batterySaver: false,
      fontScale: 'normal',
      highContrast: false,
      reduceMotion: false,
    },
  };
}

/**
 * Shape and clamp player meta data at every save boundary. Invalid or partial
 * old data receives harmless defaults and never loses valid progress.
 */
export function normalizeMetaState(raw, {
  now = Date.now(),
  qualityTier = 'medium',
  legacySave = false,
} = {}) {
  const fallback = createMetaState({
    now,
    qualityTier,
    tutorialStatus: legacySave ? 'completed' : 'active',
  });
  if (!raw || typeof raw !== 'object') return fallback;

  const settings = raw.settings && typeof raw.settings === 'object' ? raw.settings : {};
  const onboarding = raw.onboarding && typeof raw.onboarding === 'object' ? raw.onboarding : {};
  const flags = onboarding.flags && typeof onboarding.flags === 'object' ? onboarding.flags : {};
  const daily = raw.dailyMission && typeof raw.dailyMission === 'object' ? raw.dailyMission : {};
  const status = TUTORIAL_STATUSES.includes(onboarding.status) ? onboarding.status : fallback.onboarding.status;
  const requestedReplay = onboarding.replayIndex == null ? null : Number(onboarding.replayIndex);
  const replayIndex = Number.isInteger(requestedReplay) && requestedReplay >= 0 ? requestedReplay : null;
  const history = Array.isArray(daily.history)
    ? daily.history.filter((item) => item && typeof item === 'object').slice(-30).map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      completedDate: typeof item.completedDate === 'string' ? item.completedDate : null,
    }))
    : [];

  const normalized = {
    version: 1,
    xp: safeCount(raw.xp),
    level: safeCount(raw.level, 1) || 1,
    stats: { ...fallback.stats },
    achievements: {},
    dailyMission: {
      id: typeof daily.id === 'string' ? daily.id : null,
      progress: safeCount(daily.progress),
      completed: Boolean(daily.completed),
      assignedDate: typeof daily.assignedDate === 'string' ? daily.assignedDate : null,
      completedDate: typeof daily.completedDate === 'string' ? daily.completedDate : null,
      history,
    },
    onboarding: {
      status,
      stepId: typeof onboarding.stepId === 'string' ? onboarding.stepId : 'open-shop',
      flags: { ...fallback.onboarding.flags },
      skippedSteps: Array.isArray(onboarding.skippedSteps)
        ? [...new Set(onboarding.skippedSteps.filter((id) => typeof id === 'string'))].slice(0, 32)
        : [],
      replayIndex,
      playSeconds: Math.min(1800, Math.max(0, Number(onboarding.playSeconds) || 0)),
      startedAt: safeTimestamp(onboarding.startedAt, now),
      completedAt: safeTimestamp(onboarding.completedAt),
    },
    settings: {
      language: LANGUAGES.includes(settings.language) ? settings.language : fallback.settings.language,
      soundEnabled: settings.soundEnabled == null ? fallback.settings.soundEnabled : Boolean(settings.soundEnabled),
      recitationEnabled: Boolean(settings.recitationEnabled),
      qualityTier: LEVELS.includes(settings.qualityTier) ? settings.qualityTier : fallback.settings.qualityTier,
      batterySaver: Boolean(settings.batterySaver),
      fontScale: FONT_SCALES.includes(settings.fontScale) ? settings.fontScale : fallback.settings.fontScale,
      highContrast: Boolean(settings.highContrast),
      reduceMotion: Boolean(settings.reduceMotion),
    },
  };

  for (const key of STAT_KEYS) normalized.stats[key] = safeCount(raw.stats?.[key]);
  for (const key of FLAG_KEYS) normalized.onboarding.flags[key] = Boolean(flags[key]);

  if (raw.achievements && typeof raw.achievements === 'object') {
    for (const [id, entry] of Object.entries(raw.achievements)) {
      const unlockedAt = typeof entry === 'number'
        ? safeTimestamp(entry)
        : entry && typeof entry === 'object'
          ? safeTimestamp(entry.unlockedAt)
          : null;
      if (unlockedAt != null) normalized.achievements[id] = { unlockedAt };
    }
  }

  return normalized;
}

export function metaSettingsAreValid(settings = {}) {
  return LEVELS.includes(settings.qualityTier)
    && LANGUAGES.includes(settings.language)
    && typeof settings.soundEnabled === 'boolean'
    && typeof settings.recitationEnabled === 'boolean'
    && typeof settings.batterySaver === 'boolean'
    && FONT_SCALES.includes(settings.fontScale)
    && typeof settings.highContrast === 'boolean'
    && typeof settings.reduceMotion === 'boolean';
}
