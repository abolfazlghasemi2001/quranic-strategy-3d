/**
 * MissionState — وضعیت پایدارِ کمپین (ستاره‌ها، تلاش‌ها، اجرای فعال).
 *
 * این فایل همان کاری را برای کمپین می‌کند که ArmyState برای سپاه می‌کند:
 * ساخت شکل خالی، نرمال‌سازی ورودی ذخیره (هر نسخه‌ای از گذشته) و تبدیل به JSON.
 * هیچ منطق گیم‌پلی این‌جا نیست.
 */

export const CAMPAIGN_SCHEMA_VERSION = 1;

const HISTORY_LIMIT = 24;

export function createMissionRecord() {
  return {
    attempts: 0,
    completions: 0,
    bestStars: 0,
    lastStars: 0,
    bestTimeSeconds: null,
    completedAt: null,
    failed: 0,
    objectives: {},
    firstPlayedAt: null,
  };
}

export function createCampaignState() {
  return {
    version: CAMPAIGN_SCHEMA_VERSION,
    missions: {},
    active: null, // اجرای در جریان: { missionId, startedAt, elapsed, paused, objectives, runtime, log }
    totals: { completed: 0, stars: 0, attempts: 0, failures: 0, nur: 0, hekmat: 0, gohar: 0 },
    history: [],
  };
}

const RESOURCE_KEYS = ['nur', 'hekmat', 'gohar'];

function asCount(value) {
  const number = Math.round(Number(value) || 0);
  return number > 0 ? number : 0;
}

function normalizeObjectives(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (typeof key === 'string' && key.trim()) out[key] = value === true;
  }
  return out;
}

/** سابقهٔ اجراها فقط برای نمایش است و هیچ متن آیه‌ای ندارد. */
function normalizeHistoryEntry(raw, index) {
  return {
    id: typeof raw?.id === 'string' && raw.id ? raw.id : `run-${index + 1}`,
    missionId: typeof raw?.missionId === 'string' ? raw.missionId : '',
    at: Number(raw?.at) || 0,
    stars: Math.max(0, Math.min(3, asCount(raw?.stars))),
    failed: raw?.failed === true,
    seconds: Math.max(0, Math.round(Number(raw?.seconds) || 0)),
    objectives: normalizeObjectives(raw?.objectives),
  };
}

/**
 * هر ورودی (حتی ناقص یا نسخهٔ قدیمی) را به شکل معتبر تبدیل می‌کند.
 * @returns {ReturnType<typeof createCampaignState>}
 */
export function normalizeCampaignState(raw) {
  const base = createCampaignState();
  if (!raw || typeof raw !== 'object') return base;

  for (const [id, record] of Object.entries(raw.missions || {})) {
    if (!id || typeof record !== 'object') continue;
    base.missions[id] = {
      ...createMissionRecord(),
      attempts: asCount(record.attempts),
      completions: asCount(record.completions),
      bestStars: Math.max(0, Math.min(3, asCount(record.bestStars))),
      lastStars: Math.max(0, Math.min(3, asCount(record.lastStars))),
      bestTimeSeconds: Number.isFinite(Number(record.bestTimeSeconds)) && record.bestTimeSeconds != null
        ? Math.max(0, Math.round(Number(record.bestTimeSeconds)))
        : null,
      completedAt: Number(record.completedAt) > 0 ? Number(record.completedAt) : null,
      failed: asCount(record.failed),
      objectives: normalizeObjectives(record.objectives),
      firstPlayedAt: Number(record.firstPlayedAt) > 0 ? Number(record.firstPlayedAt) : null,
    };
  }

  const totals = raw.totals || {};
  base.totals = {
    completed: asCount(totals.completed),
    stars: Math.min(base.totals.stars, 0) + Math.max(0, asCount(totals.stars)),
    attempts: asCount(totals.attempts),
    failures: asCount(totals.failures),
    ...Object.fromEntries(RESOURCE_KEYS.map((key) => [key, asCount(totals[key])])),
  };

  base.history = (Array.isArray(raw.history) ? raw.history : [])
    .slice(-HISTORY_LIMIT)
    .map(normalizeHistoryEntry)
    .filter((entry) => entry.missionId);

  // اجرای در جریان: همیشه با `paused` بازمی‌گردد تا قحطی و سیل در غیبت بازیکن پیش نرود.
  const active = raw.active;
  if (active && typeof active === 'object' && typeof active.missionId === 'string' && active.missionId) {
    base.active = {
      missionId: active.missionId,
      startedAt: Number(active.startedAt) || 0,
      elapsed: Math.max(0, Number(active.elapsed) || 0),
      paused: true,
      stars: Math.max(0, Math.min(3, asCount(active.stars))),
      objectives: normalizeObjectives(active.objectives),
      runtime: active.runtime && typeof active.runtime === 'object' ? JSON.parse(JSON.stringify(active.runtime)) : null,
      log: Array.isArray(active.log)
        ? active.log.slice(-8).map((entry) => ({ at: Math.max(0, Number(entry?.at) || 0), text: String(entry?.text ?? ''), kind: String(entry?.kind ?? 'info') }))
        : [],
    };
  }
  return base;
}

export function missionRecordView(record) {
  const safe = { ...createMissionRecord(), ...(record || {}) };
  return safe;
}

export { HISTORY_LIMIT };
