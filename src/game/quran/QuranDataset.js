/**
 * QuranDataset — خواندن، اعتبارسنجی و یکسان‌سازی دیتاست قرآن (لایهٔ منطق، بدون DOM).
 *
 * قاعدهٔ قطعی پروژه:
 *   متن آیه و ترجمه هرگز در کد نوشته نمی‌شود. این ماژول فقط «خواننده» است:
 *   هر آیه از یک فایل داده می‌آید — یا دیتاست معتبر بیرونی
 *   (`public/quran/quran.json` مثل Tanzil) یا فایل نمونهٔ داخلی
 *   (`src/data/quran-sample.json`) که همهٔ متن‌هایش جای‌نگهدار و برچسب‌دار است.
 *
 * ساختار پذیرفته‌شده (هر دو شکل بدون تغییر کد خوانده می‌شود):
 *   ۱) ساختار پروژه/نمونه:  { meta, surahs:[{ index, name, ayahs:[{ index, textUthmani, translationFa, audio, source, reviewed }] }], lessons:[…] }
 *   ۲) ساختار سبک Tanzil:    { source, sourceUrl, license, version, script, reviewed?, surahs:[{ index, name, ayahCount, ayahs:[{ index, text, translation }] }] }
 *
 * خروجی نرمال‌شده: { meta, verses:Map, verseList, lessons, issues, stats }
 */
import { clamp } from '../../core/MathUtils.js';

/** برچسب‌های ثابت رابط کاربری (بدون هیچ متن قرآنی). */
export const PLACEHOLDER_LABEL = 'نمونه — جایگزین شود';
export const REVIEW_PENDING_LABEL = 'در انتظار بازبینی';
export const PLACEHOLDER_TOKEN = 'نمونه';

/** بازهٔ اعراب عربی: U+064B–U+0652 (تنوین/فتحه/ضمه/کسره/شده/سکون) + U+0670 + U+06D6–U+06ED. */
const DIACRITICS_RE = /[\u064B-\u0652\u0670\u06D6-\u06ED]/;

/** یک آیه وقتی «متن عثمانی با اعراب کامل» است که اعراب داشته باشد. */
export function hasDiacritics(text) {
  return typeof text === 'string' && DIACRITICS_RE.test(text);
}

/** شناسهٔ استاندارد یک آیه: ayah:سوره:آیه */
export function verseId(surahIndex, ayahIndex) {
  return `ayah:${Number(surahIndex)}:${Number(ayahIndex)}`;
}

export function parseVerseId(id) {
  const match = /^ayah:(\d+):(\d+)$/.exec(String(id || ''));
  if (!match) return null;
  return { surahIndex: Number(match[1]), ayahIndex: Number(match[2]) };
}

/** توکن‌های متنی یک آیه (برای مینی‌گیم‌ها). */
export function tokenize(text) {
  return String(text || '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeAudio(audio) {
  if (!audio || typeof audio !== 'object') return null;
  const url = typeof audio.url === 'string' && audio.url.trim() ? audio.url.trim() : null;
  if (!url) return null;
  const license = typeof audio.license === 'string' && audio.license.trim() ? audio.license.trim() : null;
  return {
    url,
    // Audio without an explicit license is never played (project rule).
    license,
    licenseUrl: typeof audio.licenseUrl === 'string' ? audio.licenseUrl : null,
    reciter: typeof audio.reciter === 'string' ? audio.reciter : null,
    playable: license != null,
  };
}

function normalizeSource(source, meta, surah, ayah) {
  const base = {
    datasetId: meta.datasetId || meta.source || 'unknown',
    datasetTitle: meta.title || null,
    version: meta.version || null,
    url: meta.sourceUrl || null,
    license: meta.license || null,
    script: meta.script || 'uthmani',
    surahIndex: surah.index,
    surahName: surah.name,
    ayahIndex: ayah.index,
  };
  if (!source || typeof source !== 'object') return base;
  return {
    ...base,
    datasetId: source.datasetId || base.datasetId,
    version: source.version || base.version,
    url: source.url || base.url,
    license: source.license || base.license,
    script: source.script || base.script,
  };
}

/** یک آیهٔ خام را به شکل یکسان تبدیل می‌کند. */
function normalizeAyah({ raw, meta, surah, defaultReviewed }) {
  const index = Number(raw.index ?? raw.number ?? raw.ayah ?? 0);
  const textUthmani = String(raw.textUthmani ?? raw.text ?? '').trim();
  const translationFa = String(raw.translationFa ?? raw.translation ?? '').trim();
  const id = raw.id || verseId(surah.index, index);
  const reviewed = typeof raw.reviewed === 'boolean' ? raw.reviewed : defaultReviewed === true;
  const placeholder =
    typeof raw.placeholder === 'boolean' ? raw.placeholder : meta.placeholder === true;

  return {
    id,
    surahIndex: Number(surah.index),
    surahName: surah.name,
    surahNamePlaceholder: surah.namePlaceholder === true,
    ayahIndex: index,
    textUthmani,
    translationFa,
    audio: normalizeAudio(raw.audio),
    source: normalizeSource(raw.source, meta, surah, raw),
    reviewed,
    placeholder,
    tokens: tokenize(textUthmani),
  };
}

function cloneLesson(lesson, datasetStats) {
  const steps = Array.isArray(lesson.steps) ? lesson.steps.map((step) => ({ ...step })) : [];
  const stepsSeconds = steps.reduce((sum, step) => sum + (Number(step.seconds) || 0), 0);
  return {
    id: lesson.id,
    title: lesson.title || lesson.id,
    summary: lesson.summary || '',
    theme: lesson.theme || '',
    order: Number(lesson.order) || 0,
    ayahIds: Array.isArray(lesson.ayahIds) ? [...lesson.ayahIds] : [],
    wordBank: Array.isArray(lesson.wordBank) ? lesson.wordBank.map((pair) => ({ ...pair })) : [],
    steps,
    targetSeconds: Number(lesson.targetSeconds) || stepsSeconds || 0,
    source: lesson.source || datasetStats.datasetId,
  };
}

/**
 * نرمال‌سازی یک دیتاست خام.
 * @param {object} raw
 * @param {object} [options]
 * @param {string} [options.origin] — «bundled» یا «remote»
 * @returns {{meta:object, verses:Map<string,object>, verseList:object[], surahs:object[], lessons:object[], issues:object[], stats:object}}
 */
export function normalizeDataset(raw, { origin = 'bundled' } = {}) {
  const issues = [];
  if (!raw || typeof raw !== 'object') {
    return { meta: {}, verses: new Map(), verseList: [], surahs: [], lessons: [], issues: [{ level: 'error', code: 'invalid', message: 'دیتاست خوانده نشد.' }], stats: emptyStats(origin) };
  }

  const rawMeta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const meta = {
    datasetId: rawMeta.datasetId || raw.datasetId || raw.source || (origin === 'remote' ? 'external' : 'quran-sample'),
    title: rawMeta.title || raw.title || null,
    status: rawMeta.status || (rawMeta.placeholder ? 'placeholder' : 'unknown'),
    placeholder: rawMeta.placeholder === true || raw.placeholder === true,
    reviewed: rawMeta.reviewed === true || raw.reviewed === true,
    script: rawMeta.script || raw.script || 'uthmani',
    version: rawMeta.version || raw.version || null,
    source: rawMeta.source || raw.source || null,
    sourceUrl: rawMeta.sourceUrl || raw.sourceUrl || null,
    license: rawMeta.license || raw.license || null,
    translator: rawMeta.translator || raw.translator || null,
    notice: rawMeta.notice || null,
    replacement: rawMeta.replacement || null,
    audio: rawMeta.audio || null,
    fieldNotes: rawMeta.fieldNotes || null,
    label: rawMeta.label || (rawMeta.placeholder ? PLACEHOLDER_LABEL : null),
    origin,
  };

  const surahs = [];
  const verseList = [];
  const verses = new Map();

  for (const rawSurah of Array.isArray(raw.surahs) ? raw.surahs : []) {
    const surah = {
      index: Number(rawSurah.index ?? rawSurah.number ?? surahs.length + 1),
      name: rawSurah.name || `سورهٔ ${rawSurah.index ?? surahs.length + 1}`,
      namePlaceholder: rawSurah.namePlaceholder === true,
      ayahCount: Number(rawSurah.ayahCount) || (Array.isArray(rawSurah.ayahs) ? rawSurah.ayahs.length : 0),
    };
    surahs.push(surah);
    for (const rawAyah of Array.isArray(rawSurah.ayahs) ? rawSurah.ayahs : []) {
      const verse = normalizeAyah({ raw: rawAyah, meta, surah, defaultReviewed: meta.reviewed });
      if (verses.has(verse.id)) {
        issues.push({ level: 'warn', code: 'duplicate-id', ref: verse.id, message: `شناسهٔ تکراری: ${verse.id}` });
        continue;
      }
      verses.set(verse.id, verse);
      verseList.push(verse);
    }
  }

  verseList.sort((a, b) => a.surahIndex - b.surahIndex || a.ayahIndex - b.ayahIndex);

  const lessons = [];
  for (const rawLesson of Array.isArray(raw.lessons) ? raw.lessons : []) {
    const lesson = cloneLesson(rawLesson, meta);
    const missing = lesson.ayahIds.filter((id) => !verses.has(id));
    if (missing.length) {
      issues.push({
        level: 'warn',
        code: 'lesson-missing-ayah',
        ref: lesson.id,
        message: `آیه‌های یافت‌نشده در درس ${lesson.id}: ${missing.join(', ')}`,
      });
    }
    lessons.push(lesson);
  }
  lessons.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const stats = {
    origin,
    datasetId: meta.datasetId,
    placeholder: meta.placeholder,
    reviewed: meta.reviewed,
    surahCount: surahs.length,
    verseCount: verseList.length,
    lessonCount: lessons.length,
    reviewedVerseCount: verseList.filter((v) => v.reviewed).length,
    placeholderVerseCount: verseList.filter((v) => v.placeholder).length,
    audioVerseCount: verseList.filter((v) => v.audio && v.audio.playable).length,
  };

  return { meta, surahs, verses, verseList, lessons, issues, stats };
}

function emptyStats(origin) {
  return {
    origin,
    datasetId: 'unknown',
    placeholder: true,
    reviewed: false,
    surahCount: 0,
    verseCount: 0,
    lessonCount: 0,
    reviewedVerseCount: 0,
    placeholderVerseCount: 0,
    audioVerseCount: 0,
  };
}

/**
 * اعتبارسنجی محتوایی — هر مشکل با کد و پیام فارسی برگردانده می‌شود.
 * سطح «error» یعنی آیه قابل نمایش نیست، «warn» یعنی نمایش با برچسب.
 */
export function validateDataset(dataset) {
  const issues = [];
  const { verseList = [], lessons = [], meta = {} } = dataset || {};

  if (!verseList.length) {
    issues.push({ level: 'error', code: 'empty', message: 'هیچ آیه‌ای در دیتاست نیست.' });
  }
  if (!meta.source && !meta.datasetId) {
    issues.push({ level: 'warn', code: 'no-source', message: 'منبع دیتاست مشخص نیست.' });
  }

  for (const verse of verseList) {
    const ref = verse.id;
    if (!verse.textUthmani) {
      issues.push({ level: 'error', code: 'missing-textUthmani', ref, message: `متن عثمانی آیه ${ref} خالی است.` });
      continue;
    }
    if (!verse.translationFa) {
      issues.push({ level: 'error', code: 'missing-translationFa', ref, message: `ترجمهٔ فارسی آیه ${ref} خالی است.` });
    }
    if (!hasDiacritics(verse.textUthmani)) {
      issues.push({
        level: verse.reviewed ? 'error' : 'warn',
        code: 'no-diacritics',
        ref,
        message: `متن آیهٔ ${ref} اعراب کامل ندارد.`,
      });
    }
    if (verse.reviewed) {
      if (!verse.source.subtitle && !verse.source.url && !verse.source.datasetId) {
        issues.push({ level: 'warn', code: 'no-source-ref', ref, message: `منبع آیهٔ ${ref} ثبت نشده است.` });
      }
    } else {
      issues.push({ level: 'info', code: 'unreviewed', ref, message: `آیهٔ ${ref} بازبینی نشده و با نشان «${REVIEW_PENDING_LABEL}» نمایش داده می‌شود.` });
    }
    if (verse.audio && !verse.audio.license) {
      issues.push({ level: 'warn', code: 'audio-without-license', ref, message: `صوت آیهٔ ${ref} مجوز ندارد و پخش نمی‌شود.` });
    }
  }

  for (const lesson of lessons) {
    if (!lesson.steps.length) {
      issues.push({ level: 'error', code: 'lesson-without-steps', ref: lesson.id, message: `درس ${lesson.id} مرحله‌ای ندارد.` });
    }
    if (lesson.targetSeconds && (lesson.targetSeconds < 100 || lesson.targetSeconds > 260)) {
      issues.push({
        level: 'warn',
        code: 'lesson-duration',
        ref: lesson.id,
        message: `طول درس ${lesson.id} خارج از بازهٔ ۲ تا ۳ دقیقه است (${lesson.targetSeconds} ثانیه).`,
      });
    }
    for (const pair of lesson.wordBank) {
      if (!pair.term || !pair.meaning) {
        issues.push({ level: 'warn', code: 'wordbank-incomplete', ref: lesson.id, message: `جفت واژهٔ ناقص در درس ${lesson.id}.` });
      }
    }
  }

  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.filter((i) => i.level === 'warn').length;
  return { ok: errors === 0, issues, errors, warnings };
}

/** برچسب‌های نمایشی یک آیه (نمونه/بازبینی‌نشده) — همه در رابط درس. */
export function verseBadges(verse) {
  const badges = [];
  if (!verse) return badges;
  if (verse.placeholder || !verse.reviewed) {
    if (verse.placeholder) badges.push({ kind: 'placeholder', label: PLACEHOLDER_LABEL });
  }
  if (!verse.reviewed) badges.push({ kind: 'pending', label: REVIEW_PENDING_LABEL });
  if (verse.reviewed && !verse.placeholder) badges.push({ kind: 'reviewed', label: 'بازبینی‌شده' });
  return badges;
}

/** نشانی منبع یک آیه برای نمایش در رابط درس. */
export function verseReference(verse) {
  if (!verse) return '';
  const surah = verse.surahNamePlaceholder ? `${verse.surahName} (نام جای‌نگهدار)` : verse.surahName;
  return `${surah} — آیهٔ ${toFaDigits(verse.ayahIndex)}`;
}

/** ارقام فارسی (بدون وابستگی به DOM). */
export function toFaDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
}

/**
 * آیه‌های یک درس به ترتیب دیتاست.
 * @returns {object[]}
 */
export function lessonVerses(dataset, lesson) {
  return (lesson?.ayahIds || []).map((id) => dataset.verses.get(id)).filter(Boolean);
}

/**
 * ادغام دیتاست بیرونی روی نمونهٔ داخلی:
 * متن/ترجمه/صوت/منبع/وضعیت بازبینی هر آیه از بیرونی می‌آید (اگر همان شناسه باشد)
 * و درس‌ها از بیرونی اگر داشته باشد، وگرنه از نمونه.
 */
export function mergeDatasets(base, override) {
  if (!override || !override.verseList?.length) return base;
  const merged = {
    meta: { ...base.meta, ...override.meta, origin: override.meta.origin, lessonsFrom: override.lessons.length ? 'remote' : 'bundled' },
    surahs: override.surahs.length ? override.surahs : base.surahs,
    verses: new Map(base.verses),
    verseList: [],
    lessons: override.lessons.length ? override.lessons : base.lessons,
    issues: [...base.issues, ...override.issues],
    stats: { ...base.stats },
  };
  let replaced = 0;
  for (const verse of override.verseList) {
    if (merged.verses.has(verse.id)) replaced += 1;
    merged.verses.set(verse.id, verse);
  }
  merged.verseList = [...merged.verses.values()].sort(
    (a, b) => a.surahIndex - b.surahIndex || a.ayahIndex - b.ayahIndex,
  );
  merged.stats = {
    ...base.stats,
    ...override.stats,
    origin: override.meta.origin,
    datasetId: override.meta.datasetId,
    placeholder: override.meta.placeholder,
    reviewed: override.meta.reviewed,
    verseCount: merged.verseList.length,
    lessonCount: merged.lessons.length,
    replacedFromBundled: replaced,
    reviewedVerseCount: merged.verseList.filter((v) => v.reviewed).length,
    placeholderVerseCount: merged.verseList.filter((v) => v.placeholder).length,
  };
  return merged;
}

/** خلاصهٔ کوتاه دیتاست برای نمایش در پنل دارالقرآن. */
export function datasetSummary(dataset) {
  const { meta, stats } = dataset;
  return {
    datasetId: stats.datasetId,
    title: meta.title || stats.datasetId,
    origin: stats.origin,
    placeholder: stats.placeholder,
    reviewed: stats.reviewed,
    version: meta.version,
    source: meta.source,
    sourceUrl: meta.sourceUrl,
    license: meta.license,
    script: meta.script,
    surahCount: stats.surahCount,
    verseCount: stats.verseCount,
    lessonCount: stats.lessonCount,
    reviewedVerseCount: stats.reviewedVerseCount,
    placeholderVerseCount: stats.placeholderVerseCount,
    audioVerseCount: stats.audioVerseCount,
    expectedPath: meta?.replacement?.expectedPath || 'public/quran/quran.json',
    issues: dataset.issues.length,
  };
}

/**
 * QuranDatasetLoader — بارگذاری دیتاست با جایگزینی بدون تغییر کد.
 *
 * ترتیب تلاش:
 *   ۱) `?quran=<نشانی>` (برای اپراتور/توسعه)
 *   ۲) `public/quran/quran.json` (دیتاست معتبر، مثل Tanzil)
 *   ۳) نمونهٔ داخلی `src/data/quran-sample.json` (جای‌نگهدار)
 */
export class QuranDatasetLoader {
  /**
   * @param {object} options
   * @param {object} options.sample — محتوای src/data/quran-sample.json
   * @param {object} options.learning — src/data/quran-learning.json
   * @param {string} [options.search] — location.search
   * @param {typeof fetch} [options.fetchImpl]
   * @param {string} [options.baseUrl]
   */
  constructor({ sample, learning, search = '', fetchImpl = null, baseUrl = '' }) {
    this.sample = sample;
    this.learning = learning;
    this.search = search;
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.dataset = null;
    this.loadReport = null;
  }

  resolveUrl() {
    const override = new URLSearchParams(this.search).get(this.learning?.dataset?.queryParam || 'quran');
    if (override) return override;
    const expected = this.learning?.dataset?.expectedPath || './quran/quran.json';
    if (/^https?:/i.test(expected) || expected.startsWith('./') || expected.startsWith('/')) return expected;
    return `./${expected}`;
  }

  /** @returns {Promise<{dataset:object, validation:object, loadReport:object}>} */
  async load() {
    const bundled = normalizeDataset(this.sample, { origin: 'bundled' });
    const bundledValidation = validateDataset(bundled);

    let remote = null;
    const url = this.resolveUrl();
    const report = { url, remoteLoaded: false, remoteError: null, usedSample: true, lessonsFrom: 'bundled' };

    const doFetch =
      this.fetchImpl ||
      (typeof fetch === 'function' ? fetch.bind(globalThis) : null);

    if (doFetch && url) {
      try {
        const response = await doFetch(url, { cache: this.learning?.dataset?.cacheBust ? 'no-store' : 'default' });
        if (response && response.ok) {
          const json = await response.json();
          const normalized = normalizeDataset(json, { origin: 'remote' });
          const validation = validateDataset(normalized);
          if (normalized.verseList.length > 0 && validation.errors === 0) {
            remote = normalized;
            report.remoteLoaded = true;
          } else if (normalized.verseList.length > 0) {
            report.remoteError = `validation-errors:${validation.errors}`;
          } else {
            report.remoteError = 'no-verses';
          }
        } else {
          report.remoteError = `http-${response ? response.status : 'error'}`;
        }
      } catch (error) {
        report.remoteError = String(error?.message || error);
      }
    } else {
      report.remoteError = 'fetch-unavailable';
    }

    const dataset = remote ? mergeDatasets(bundled, remote) : bundled;
    report.usedSample = !remote;
    report.lessonsFrom = dataset.meta.lessonsFrom || 'bundled';

    const validation = validateDataset(dataset);
    this.dataset = dataset;
    this.loadReport = { ...report, validation: { errors: validation.errors, warnings: validation.warnings } };
    return { dataset, validation, loadReport: this.loadReport };
  }
}

/** Parses a lesson duration budget into a human Persian phrase. */
export function lessonDurationLabel(lesson) {
  const seconds = clamp(Number(lesson?.targetSeconds) || 0, 0, 3600);
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `حدود ${toFaDigits(minutes)} دقیقه`;
}
