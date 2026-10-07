/**
 * ArmyState — شکل دادهٔ سپاه و سابقهٔ نبرد (منطق خالص، بدون Three.js و بدون DOM).
 *
 * این ماژول هیچ عدد تعادلی و هیچ داده‌ای از واحدها ندارد؛ فقط «شکل» داده‌ای را
 * تعریف می‌کند که در ذخیره‌سازی می‌نشیند و نرمال‌سازی مقادیر قدیمی/خراب را انجام
 * می‌دهد. کلیدهای سپاه را پادگان از units.json می‌سازد تا هیچ‌جا فهرست گونه‌ها
 * دستی تکرار نشود.
 */

export const ARMY_SCHEMA = 1;

/** سپاه: گونهٔ واحد → شمار نیروی آماده + صف آموزش. */
export function createArmyState() {
  return {
    garrison: {}, // { [unitType]: count }
    training: [], // { id, unit, status: 'active'|'queued', startedAt, endsAt, durationMs }
    nextJobId: 1,
    trained: 0, // شمار کل نیروهای آموزش‌دیده (آمار، فقط برای گزارش)
    deployed: 0, // شمار کل نیروهای فرستاده‌شده به نبرد
    lost: 0, // شمار کل نیروهای ازدست‌رفته در نبرد
  };
}

/** سابقهٔ نبردها: بذر، دستورها و نتیجهٔ هر نبرد برای بازپخش. */
export function createBattleState() {
  return {
    seq: 0, // شمارهٔ نبردها؛ در بذر نبرد بعدی اثر می‌گذارد
    history: [], // { id, at, encounterId, seed, scenarioHash, result, ticks, commands, checkpoints, report }
    wins: 0,
    losses: 0,
    lastSeed: 0,
    lastResult: null,
  };
}

function intOr(value, fallback = 0) {
  const num = Math.floor(Number(value));
  return Number.isFinite(num) ? num : fallback;
}

export function normalizeArmyState(raw) {
  const base = createArmyState();
  if (!raw || typeof raw !== 'object') return base;

  const garrison = {};
  for (const [type, count] of Object.entries(raw.garrison || {})) {
    const value = Math.max(0, intOr(count));
    if (value > 0) garrison[type] = value;
  }

  let autoId = 0;
  const training = Array.isArray(raw.training)
    ? raw.training
      .filter((job) => job && typeof job.unit === 'string')
      .map((job) => {
        autoId += 1;
        return {
          id: typeof job.id === 'string' ? job.id : `train-${autoId}`,
          unit: job.unit,
          status: job.status === 'active' ? 'active' : 'queued',
          startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
          endsAt: Number.isFinite(job.endsAt) ? job.endsAt : null,
          durationMs: Math.max(0, Number(job.durationMs) || 0),
        };
      })
    : [];

  return {
    garrison,
    training,
    nextJobId: Math.max(1, intOr(raw.nextJobId, 1)),
    trained: Math.max(0, intOr(raw.trained)),
    deployed: Math.max(0, intOr(raw.deployed)),
    lost: Math.max(0, intOr(raw.lost)),
  };
}

export function normalizeBattleState(raw, { keep = 3 } = {}) {
  const base = createBattleState();
  if (!raw || typeof raw !== 'object') return base;
  const history = Array.isArray(raw.history)
    ? raw.history.filter((record) => record && typeof record.seed === 'number' && record.scenario)
    : [];
  return {
    seq: Math.max(0, intOr(raw.seq)),
    history: history.slice(-Math.max(1, keep)),
    wins: Math.max(0, intOr(raw.wins)),
    losses: Math.max(0, intOr(raw.losses)),
    lastSeed: Number(raw.lastSeed) >>> 0,
    lastResult: typeof raw.lastResult === 'string' ? raw.lastResult : null,
  };
}
