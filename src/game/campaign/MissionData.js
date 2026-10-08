/**
 * MissionData — نرمال‌سازی و اعتبارسنجی دادهٔ مأموریت‌های کمپین (فاز ۶).
 *
 * قاعده‌های ثابت (سیاست محتوایی، نقض‌نشدنی):
 *   • دادهٔ مأموریت هرگز متن آیه ندارد؛ فقط شناسهٔ ارجاع (`ayah:سوره:آیه`).
 *   • هیچ رشته‌ای در دادهٔ مأموریت نباید اعراب کامل داشته باشد (نگارش از حافظه ممنوع).
 *   • متن آیه فقط در لایهٔ رابط و فقط از دیتاست قرآنی خوانده می‌شود.
 *   • هر مأموریت: روایت کوتاه، سه هدف سه‌ستاره، پاداش و «درس‌آموخته».
 *   • زنجیرهٔ باز شدن: هر مأموریت پس از تکمیل مأموریت پیشین باز می‌شود.
 */
import { getRuleModule } from './rules/index.js';

export const MISSION_SCHEMA = 1;
export const REFERENCE_PATTERN = /^ayah:(\d{1,3}):(\d{1,3})$/;
export const MISSION_POLICY = {
  reviewStatus: 'pending',
  reviewLabel: 'روایت پروژه — در انتظار بازبینی',
  noDepiction: 'بدون تصویر یا مدل پیامبران، ائمه و فرشتگان',
  noVerseMemory: 'متن آیه فقط از دیتاست قرآنی',
};

/** نشانه‌های اعراب (تشکیل) در بازهٔ عربی/قرآنی. */
const DIACRITIC_RE = /[\u064B-\u0652\u0670\u06D6-\u06ED]/;

/** آیا این متن، اعراب کامل دارد؟ (آستانه: هر نشانهٔ دارای ≥۲ اعراب) */
export function containsVocalisedArabic(text) {
  if (typeof text !== 'string') return false;
  return text.split(/\s+/).some((token) => {
    const marks = token.match(DIACRITIC_RE);
    return !!marks && marks.length >= 2;
  });
}

/** اسکن بازگشتی یک ساختار داده و برگرداندن مسیر هر رشتهٔ اعراب‌دار. */
export function scanForVocalisedArabic(value, path = '$', found = []) {
  if (typeof value === 'string') {
    if (containsVocalisedArabic(value)) found.push(path);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanForVocalisedArabic(item, `${path}[${index}]`, found));
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) scanForVocalisedArabic(item, `${path}.${key}`, found);
  }
  return found;
}

/** «ayah:12:47» → { id, surahIndex:12, ayahIndex:47 } (یا null). */
export function parseRefId(id) {
  const match = REFERENCE_PATTERN.exec(String(id ?? '').trim());
  if (!match) return null;
  const surahIndex = Number(match[1]);
  const ayahIndex = Number(match[2]);
  if (surahIndex < 1 || surahIndex > 114 || ayahIndex < 1) return null;
  return { id: `ayah:${surahIndex}:${ayahIndex}`, surahIndex, ayahIndex };
}

export function makeRefId(surahIndex, ayahIndex) {
  return `ayah:${Number(surahIndex)}:${Number(ayahIndex)}`;
}

function normalizeAction(raw) {
  const cost = {};
  for (const [resource, value] of Object.entries(raw?.cost || {})) {
    const amount = Math.max(0, Math.round(Number(value) || 0));
    if (amount > 0) cost[resource] = amount;
  }
  return {
    label: typeof raw?.label === 'string' ? raw.label : '',
    icon: typeof raw?.icon === 'string' ? raw.icon : '',
    cost,
    seconds: Math.max(0, Number(raw?.seconds) || 0),
    amount: raw?.amount != null ? Math.max(0, Number(raw.amount) || 0) : null,
  };
}

function normalizePlots(raw) {
  return (Array.isArray(raw) ? raw : []).map((plot, index) => {
    const size = Array.isArray(plot?.size) && plot.size.length >= 2
      ? [Math.max(1, Math.round(Number(plot.size[0]) || 1)), Math.max(1, Math.round(Number(plot.size[1]) || 1))]
      : [1, 1];
    return {
      id: String(plot?.id ?? `plot-${index + 1}`),
      kind: String(plot?.kind ?? 'plot'),
      label: String(plot?.label ?? ''),
      col: Math.max(0, Math.round(Number(plot?.col) || 0)),
      row: Math.max(0, Math.round(Number(plot?.row) || 0)),
      size,
    };
  });
}

/**
 * نرمال‌سازی فهرست مأموریت‌ها از missions.json.
 * @returns {{ list: object[], byId: Map<string, object> }}
 */
export function normalizeMissions(raw) {
  const source = Array.isArray(raw) ? raw : Array.isArray(raw?.list) ? raw.list : Array.isArray(raw?.missions) ? raw.missions : [];
  const list = source.map((mission, index) => {
    const kind = String(mission?.rules?.kind ?? '').trim();
    const refs = [];
    const seen = new Set();
    for (const entry of Array.isArray(mission?.refs) ? mission.refs : []) {
      const parsed = parseRefId(typeof entry === 'string' ? entry : entry?.id);
      if (parsed && !seen.has(parsed.id)) {
        seen.add(parsed.id);
        refs.push(parsed.id);
      }
    }
    const objectives = (Array.isArray(mission?.objectives) ? mission.objectives : []).map((objective, objectiveIndex) => ({
      id: String(objective?.id ?? `objective-${objectiveIndex + 1}`),
      label: String(objective?.label ?? ''),
      hint: String(objective?.hint ?? ''),
      primary: objective?.primary === true || objectiveIndex === 0,
    }));
    const actions = {};
    for (const [id, value] of Object.entries(mission?.actions || {})) {
      actions[id] = normalizeAction(value);
    }
    const briefing = (Array.isArray(mission?.briefing) ? mission.briefing : [])
      .filter((line) => line && typeof line.text === 'string' && line.text.trim())
      .map((line) => ({ text: String(line.text).trim(), ref: parseRefId(line.ref)?.id ?? null }));
    const lessonLines = (Array.isArray(mission?.lesson?.lines) ? mission.lesson.lines : Array.isArray(mission?.lessonPoints) ? mission.lessonPoints : [])
      .map((point) => String(point))
      .filter(Boolean);

    return {
      id: String(mission?.id ?? `mission-${index + 1}`),
      order: Number.isFinite(Number(mission?.order)) ? Number(mission.order) : index + 1,
      icon: String(mission?.icon ?? '☼'),
      title: String(mission?.title ?? ''),
      subtitle: String(mission?.subtitle ?? ''),
      hint: String(mission?.hint ?? ''),
      qasas: {
        surahIndex: Number(mission?.qasas?.surahIndex) || 0,
        surahName: String(mission?.qasas?.surahName ?? ''),
        theme: String(mission?.qasas?.theme ?? ''),
      },
      refs,
      briefing,
      lessonLearned: String(mission?.lesson?.title ?? mission?.lessonLearned ?? ''),
      lessonPoints: lessonLines,
      objectives,
      reward: {
        nur: Math.max(0, Math.round(Number(mission?.reward?.nur) || 0)),
        hekmat: Math.max(0, Math.round(Number(mission?.reward?.hekmat) || 0)),
        gohar: Math.max(0, Math.round(Number(mission?.reward?.gohar) || 0)),
        speedupSeconds: Math.max(0, Math.round(Number(mission?.reward?.speedupSeconds) || 0)),
      },
      unlock: {
        after: mission?.unlock?.after ? String(mission.unlock.after) : null,
        minStars: Math.max(0, Math.round(Number(mission?.unlock?.minStars) || 0)),
      },
      rules: { ...(mission?.rules || {}), kind },
      plots: normalizePlots(mission?.plots ?? mission?.rules?.plots),
      actions,
      rule: getRuleModule(kind),
    };
  });

  list.sort((a, b) => a.order - b.order);
  // زنجیرهٔ باز شدن: پیش‌فرض هر مأموریت پس از مأموریت پیشین باز می‌شود.
  list.forEach((mission, index) => {
    if (!mission.unlock.after && index > 0) mission.unlock.after = list[index - 1].id;
  });
  const byId = new Map(list.map((mission) => [mission.id, mission]));
  return { list, byId };
}

/**
 * اعتبارسنجی دادهٔ نرمال‌شده (قبل از اجرا؛ خروجی برای گزارش بوت).
 * @returns {{ ok:boolean, issues:{level:'error'|'warning', code:string, missionId:string, message:string}[] }}
 */
export function validateMissions(model) {
  const issues = [];
  const error = (missionId, code, message) => issues.push({ level: 'error', code, missionId, message });
  const warn = (missionId, code, message) => issues.push({ level: 'warning', code, missionId, message });

  const list = model?.list || [];
  if (!list.length) error('-', 'empty', 'هیچ مأموریتی تعریف نشده است.');

  const seen = new Set();
  for (const mission of list) {
    if (!mission.id || seen.has(mission.id)) error(mission.id, 'duplicate-id', `شناسهٔ تکراری یا خالی: «${mission.id}»`);
    seen.add(mission.id);
    if (!mission.title) error(mission.id, 'no-title', 'عنوان مأموریت خالی است.');
    if (!mission.subtitle) warn(mission.id, 'no-subtitle', 'زیرعنوان مأموریت خالی است.');
    if (!mission.qasas.surahName) error(mission.id, 'no-surah', 'نام سوره ثبت نشده است.');
    if (!(mission.qasas.surahIndex >= 1 && mission.qasas.surahIndex <= 114)) error(mission.id, 'bad-surah-index', `شمارهٔ سوره نامعتبر: ${mission.qasas.surahIndex}`);
    if (!mission.refs.length) error(mission.id, 'no-refs', 'هیچ ارجاع آیه‌ای ثبت نشده است.');
    if (mission.briefing.length < 2) error(mission.id, 'short-narrative', 'روایت کوتاه‌تر از دو سطر است.');
    if (!mission.lessonLearned || mission.lessonPoints.length < 2) error(mission.id, 'no-lesson', '«درس‌آموخته» یا نکته‌های آن کامل نیست.');
    if (mission.objectives.length !== 3) error(mission.id, 'bad-objectives', `باید دقیقاً سه هدف داشته باشد (اکنون ${mission.objectives.length}).`);
    if (mission.objectives.filter((objective) => objective.primary).length !== 1) error(mission.id, 'bad-primary', 'باید دقیقاً یک هدف اصلی داشته باشد.');
    if (!mission.rules.kind) error(mission.id, 'no-rule', 'نوع قاعدهٔ مأموریت ثبت نشده است.');
    if (!mission.rule) error(mission.id, 'bad-rule', `قاعدهٔ ناشناخته: «${mission.rules.kind}»`);
    if (mission.rule && mission.objectives.length === 3) {
      const ids = new Set(mission.objectives.map((objective) => objective.id));
      for (const required of mission.rule.OBJECTIVES) {
        if (!ids.has(required)) error(mission.id, 'objective-mismatch', `هدف «${required}» در دادهٔ مأموریت نیست.`);
      }
    }
    for (const line of mission.briefing) {
      if (!line.ref) warn(mission.id, 'line-without-ref', 'سطر روایت بدون ارجاع است.');
      else if (!mission.refs.includes(line.ref)) error(mission.id, 'line-ref-missing', `ارجاع «${line.ref}» در فهرست ارجاع‌های مأموریت نیست.`);
    }
    // کنش‌های موردنیاز قاعده باید در داده باشند تا هیچ برچسبی در کد نماند.
    if (mission.rule && Array.isArray(mission.rule.ACTIONS)) {
      for (const id of mission.rule.ACTIONS) {
        if (!mission.actions[id]) warn(mission.id, 'missing-action', `کنش «${id}» در دادهٔ مأموریت نیست.`);
      }
    }
  }

  for (const mission of list) {
    if (mission.unlock.after && !model.byId.has(mission.unlock.after)) {
      error(mission.id, 'unlock-order', `مأموریت پیشین «${mission.unlock.after}» وجود ندارد.`);
    } else if (mission.unlock.after) {
      const previous = model.byId.get(mission.unlock.after);
      if (previous && previous.order >= mission.order) error(mission.id, 'unlock-order', 'ترتیب باز شدن مأموریت‌ها نادرست است.');
    }
  }

  // سیاست محتوایی: هیچ متن اعراب‌داری در دادهٔ مأموریت نباید باشد.
  for (const path of scanForVocalisedArabic(list)) {
    error('-', 'vocalised-text', `متن اعراب‌دار در دادهٔ مأموریت (${path}) — نگارش متن دینی از حافظه ممنوع است.`);
  }

  return { ok: issues.every((issue) => issue.level !== 'error'), issues };
}

/** فهرست ارجاع‌های یک مأموریت با برچسب خوانا (بدون هیچ متن آیه). */
export function missionRefs(mission) {
  return (mission?.refs || []).map((id) => {
    const parsed = parseRefId(id);
    if (!parsed) return null;
    return {
      id: parsed.id,
      surahIndex: parsed.surahIndex,
      ayahIndex: parsed.ayahIndex,
      surahName: mission.qasas?.surahName || 'سوره',
      label: `${mission.qasas?.surahName || 'سوره'} ${parsed.surahIndex}:${parsed.ayahIndex}`,
    };
  }).filter(Boolean);
}

export function refLabel(mission, refId) {
  const ref = missionRefs(mission).find((item) => item.id === refId);
  return ref ? ref.label : '';
}

/** آیهٔ متناظر در دیتاست قرآنی (تنها منبع مجاز متن آیه) — یا null. */
export function resolveRef(dataset, refId) {
  if (!dataset || !dataset.verses || typeof dataset.verses.get !== 'function') return null;
  return dataset.verses.get(refId) || null;
}

/**
 * کارت‌های ارجاع برای رابط کاربری: متن فقط اگر دیتاست داشته باشد.
 * در غیر این صورت فقط ارجاع با وضعیت «نیازمند بازبینی» برمی‌گردد.
 */
export function missionRefCards(dataset, mission) {
  return missionRefs(mission).map((ref) => {
    const verse = resolveRef(dataset, ref.id);
    return {
      ...ref,
      status: verse ? 'in-dataset' : 'pending-review',
      verse: verse || null,
    };
  });
}

export function narrativeLines(mission) {
  return (mission?.briefing || []).map((line) => ({
    text: line.text,
    ref: line.ref,
    refLabel: line.ref ? refLabel(mission, line.ref) : '',
  }));
}

export function objectiveById(mission, id) {
  return (mission?.objectives || []).find((objective) => objective.id === id) || null;
}

/** شمار ستاره‌های یک اجرا از روی وضعیت هدف‌ها. */
export function starCount(objectives, mission) {
  const ids = new Set((mission?.objectives || []).map((objective) => objective.id));
  return Object.entries(objectives || {}).filter(([id, done]) => done === true && ids.has(id)).length;
}

export function narrativeBadges(campaignData, mission) {
  const values = campaignData?.values || {};
  return {
    reviewLabel: values.reviewLabel || MISSION_POLICY.reviewLabel,
    noDepiction: values.noDepiction || MISSION_POLICY.noDepiction,
    noVerseMemory: values.noVerseMemory || MISSION_POLICY.noVerseMemory,
    surah: mission?.qasas?.surahName || '',
  };
}
