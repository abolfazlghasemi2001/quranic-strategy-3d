/**
 * وضعیت لایهٔ آموزشی (فاز ۴) — دادهٔ خالص، قابل‌ذخیره، بدون وابستگی به سه‌بعدی.
 * این ماژول تنها شکل داده را تعریف می‌کند؛ منطق در LearningSystem است.
 */

export const LEARNING_SCHEMA_VERSION = 1;

/** حالت پیش‌فرض (بازی تازه یا مهاجرت از ذخیرهٔ فاز ۳). */
export function createLearningState() {
  return {
    version: LEARNING_SCHEMA_VERSION,
    reviews: {}, // itemId → { box, due, reps, lapses, correct, wrong, lastSeenAt, registeredAt, kind, ref }
    lessons: {}, // lessonId → { completions, firstCompletedAt, lastCompletedAt, bestAccuracy, totalSeconds, mistakes }
    totals: {
      lessonsCompleted: 0,
      reviewSessions: 0,
      itemsLearned: 0,
      nurEarned: 0,
      hekmatEarned: 0,
      speedupSecondsUsed: 0,
      speedupPool: 0,
    },
    history: [],
  };
}

/** پاک‌سازی و پرکردن مقادیر پیش‌فرض روی دادهٔ ذخیره‌شده (مهاجرت‌پذیر). */
export function normalizeLearningState(raw) {
  const base = createLearningState();
  if (!raw || typeof raw !== 'object') return base;
  const out = {
    ...base,
    version: Number(raw.version) || LEARNING_SCHEMA_VERSION,
    reviews: normalizeReviews(raw.reviews),
    lessons: normalizeLessons(raw.lessons),
    totals: { ...base.totals, ...(raw.totals && typeof raw.totals === 'object' ? raw.totals : {}) },
    history: Array.isArray(raw.history) ? raw.history.slice(0, 30).map((h) => ({ ...h })) : [],
  };
  for (const key of Object.keys(base.totals)) {
    const value = Number(out.totals[key]);
    out.totals[key] = Number.isFinite(value) ? value : 0;
  }
  return out;
}

function normalizeReviews(reviews) {
  if (!reviews || typeof reviews !== 'object') return {};
  const out = {};
  for (const [id, entry] of Object.entries(reviews)) {
    if (!entry || typeof entry !== 'object') continue;
    out[id] = {
      box: Math.max(1, Math.min(5, Math.round(Number(entry.box) || 1))),
      due: Number(entry.due) || 0,
      reps: Math.max(0, Math.round(Number(entry.reps) || 0)),
      lapses: Math.max(0, Math.round(Number(entry.lapses) || 0)),
      correct: Math.max(0, Math.round(Number(entry.correct) || 0)),
      wrong: Math.max(0, Math.round(Number(entry.wrong) || 0)),
      lastSeenAt: entry.lastSeenAt == null ? null : Number(entry.lastSeenAt) || null,
      registeredAt: Number(entry.registeredAt) || 0,
      kind: entry.kind === 'word' ? 'word' : 'ayah',
      ref: typeof entry.ref === 'string' ? entry.ref : id,
    };
  }
  return out;
}

function normalizeLessons(lessons) {
  if (!lessons || typeof lessons !== 'object') return {};
  const out = {};
  for (const [id, record] of Object.entries(lessons)) {
    if (!record || typeof record !== 'object') continue;
    out[id] = {
      completions: Math.max(0, Math.round(Number(record.completions) || 0)),
      firstCompletedAt: Number(record.firstCompletedAt) || null,
      lastCompletedAt: Number(record.lastCompletedAt) || null,
      bestAccuracy: Math.max(0, Math.min(1, Number(record.bestAccuracy) || 0)),
      totalSeconds: Math.max(0, Number(record.totalSeconds) || 0),
      mistakes: Math.max(0, Math.round(Number(record.mistakes) || 0)),
    };
  }
  return out;
}
