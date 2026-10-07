/**
 * content.js — پل بین دیتاست قرآن و مینی‌گیم‌ها (منطق خالص، بدون DOM).
 *
 * هرچه این‌جا ساخته می‌شود از داده می‌آید: واژه‌های آیه، واژه‌نامهٔ درس یا
 * ترجمهٔ آیه. هیچ واژه یا آیه‌ای در کد نوشته نشده است.
 */

/** واژه‌های همهٔ آیه‌های دیتاست (برای گزینه‌های نادرست) با حذف تکرار. */
export function tokensPool(dataset, { excludeVerseId = null, limit = 60 } = {}) {
  const seen = new Set();
  const pool = [];
  for (const verse of dataset?.verseList || []) {
    if (excludeVerseId && verse.id === excludeVerseId) continue;
    for (const token of verse.tokens || []) {
      if (seen.has(token)) continue;
      seen.add(token);
      pool.push(token);
      if (pool.length >= limit) return pool;
    }
  }
  return pool;
}

/**
 * جفت‌های «واژه ↔ معنی» یک درس.
 *
 * ترتیب اولویت:
 *   ۱) واژه‌نامهٔ خود درس (wordBank) — شناسه‌ها با Leitner یکی است: word:<lessonId>:<index>
 *   ۲) جانشین: جفت «متن آیه ↔ ترجمهٔ همان آیه» (شناسه = شناسهٔ آیه) تا بازی همیشه اجرا شود.
 *
 * @param {object} options
 * @param {object} options.lesson
 * @param {object} options.dataset
 * @param {object} [options.config]
 * @param {string} [options.focusTerm] — واژهٔ سررسیده که باید حتماً در دست باشد
 * @returns {{pairs:object[], mode:'word-bank'|'ayah-translation'}}
 */
export function wordMatchPairsFor({ lesson, dataset, config = {}, focusTerm = null }) {
  const minPairs = Math.max(2, Number(config.minPairs) || 3);
  const wanted = Math.max(minPairs, Number(config.pairsPerRound) || 4);

  const fromBank = (lesson?.wordBank || [])
    .map((pair, index) => ({
      id: `word:${lesson.id}:${index}`,
      term: pair.term,
      meaning: pair.meaning,
      kind: 'word',
    }))
    .filter((pair) => pair.term && pair.meaning);

  if (fromBank.length >= minPairs) {
    let ordered = fromBank;
    if (focusTerm) {
      const focus = fromBank.find((p) => p.term === focusTerm) || fromBank.find((p) => p.id === focusTerm);
      if (focus) ordered = [focus, ...fromBank.filter((p) => p.id !== focus.id)];
    }
    return { pairs: ordered.slice(0, Math.max(wanted, focusTerm ? minPairs : wanted)), mode: 'word-bank' };
  }

  const verses = (lesson?.ayahIds || [])
    .map((id) => dataset?.verses.get(id))
    .filter((verse) => verse && verse.textUthmani && verse.translationFa);

  const fallback = verses.map((verse) => ({
    id: verse.id,
    term: verse.textUthmani,
    meaning: verse.translationFa,
    kind: 'ayah',
    verseId: verse.id,
  }));

  if (focusTerm) {
    const focus = fallback.find((p) => p.id === focusTerm || p.term === focusTerm);
    if (focus) return { pairs: [focus, ...fallback.filter((p) => p.id !== focus.id)].slice(0, Math.max(wanted, minPairs)), mode: 'ayah-translation' };
  }
  return { pairs: fallback.slice(0, wanted), mode: 'ayah-translation' };
}

/** خلاصهٔ مرحله‌های یک درس برای نمایش در فهرست درس‌ها. */
export function lessonOutline(lesson) {
  return (lesson?.steps || []).map((step) => ({
    kind: step.kind,
    title: step.title,
    game: step.game || null,
    seconds: step.seconds || 0,
  }));
}
