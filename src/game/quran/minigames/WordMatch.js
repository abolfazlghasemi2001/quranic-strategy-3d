/**
 * مینی‌گیم «تطبیق واژه و معنی» — منطق خالص، بدون DOM و بدون Three.js.
 *
 * دو حالت:
 *   - «واژه‌نامهٔ درس» (پیش‌فرض): جفت‌های { term, meaning } از wordBank خود درس
 *     در فایل داده می‌آیند.
 *   - «آیه ↔ ترجمه» (جانشین): اگر درس واژه‌نامه نداشت، جفت‌ها از متن آیه و
 *     ترجمهٔ همان آیه در دیتاست ساخته می‌شوند تا بازی همیشه قابل اجرا باشد.
 *
 * هیچ واژه یا معنی‌ای در کد نوشته نشده است؛ همه از دیتاست می‌آید.
 * انتخاب نادرست جریمه ندارد: فقط کاشی‌ها آزاد می‌شوند و می‌توان دوباره کوشید.
 */
import { Rng } from '../../../core/RNG.js';

export const WORD_MATCH_ID = 'word-match';

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * ساخت جفت‌های بازی از داده.
 * @param {object} options
 * @param {object[]} [options.wordBank] — [{ term, meaning }]
 * @param {object[]} [options.verses] — آیه‌های درس (برای حالت جانشین)
 * @returns {{pairs:object[], mode:string}}
 */
export function buildPairs({ wordBank = [], verses = [] } = {}) {
  const clean = wordBank
    .filter((pair) => pair && pair.term && pair.meaning)
    .map((pair, index) => ({ id: `term-${index}`, term: pair.term, meaning: pair.meaning, kind: 'word' }));
  if (clean.length >= 2) return { pairs: clean, mode: 'word-bank' };

  const versesPairs = verses
    .filter((verse) => verse && verse.textUthmani && verse.translationFa)
    .map((verse) => ({
      // شناسه = شناسهٔ آیه، تا با اقلام Leitner یکی باشد.
      id: verse.id,
      term: verse.textUthmani,
      meaning: verse.translationFa,
      kind: 'ayah',
      verseId: verse.id,
    }));
  return { pairs: versesPairs, mode: 'ayah-translation' };
}

export class WordMatchGame {
  /**
   * @param {object} options
   * @param {object[]} options.pairs — جفت‌های [{ id, term, meaning }]
   * @param {number} [options.pairsPerRound]
   * @param {object} [options.config] — learning.minigames['word-match']
   * @param {number} [options.seed]
   * @param {string} [options.mode] — 'word-bank' | 'ayah-translation'
   */
  constructor({ pairs, pairsPerRound, config = {}, seed = 1, mode = 'word-bank' }) {
    this.gameId = WORD_MATCH_ID;
    this.config = config;
    this.rng = new Rng(seed >>> 0);
    this.mode = mode;
    const wanted = Math.max(2, Number(pairsPerRound) || config.pairsPerRound || 4);
    const usable = pairs.filter((p) => p && p.term && p.meaning);
    this.pairs = shuffle(usable, this.rng).slice(0, Math.min(wanted, usable.length));
    this.terms = shuffle(this.pairs.map((p) => p.id), this.rng);
    this.meanings = shuffle(this.pairs.map((p) => p.id), this.rng);
    this.selectedTerm = null;
    this.matched = new Set();
    this.disabled = [];
    this.mistakes = [];
    this.attempts = 0;
    this.items = [];
  }

  byPair(id) {
    return this.pairs.find((p) => p.id === id) || null;
  }

  get total() {
    return this.pairs.length;
  }

  get done() {
    return this.pairs.length > 0 && this.matched.size === this.pairs.length;
  }

  selectTerm(id) {
    if (this.done || !this.byPair(id) || this.matched.has(id)) return null;
    this.selectedTerm = this.selectedTerm === id ? null : id;
    return this.selectedTerm;
  }

  /**
   * انتخاب معنی برای واژهٔ گزیده‌شده.
   * @returns {{correct:boolean, termId:string|null, meaningId:string, resolved:boolean, done:boolean}}
   */
  selectMeaning(meaningId) {
    const termId = this.selectedTerm;
    if (!termId || this.done) return { correct: false, termId, meaningId, resolved: false, done: this.done };
    if (this.matched.has(meaningId)) return { correct: false, termId, meaningId, resolved: false, done: this.done };
    this.attempts += 1;
    const correct = termId === meaningId;
    if (correct) {
      this.matched.add(termId);
      this.selectedTerm = null;
      this.items.push({ itemId: termId, correct: !this.mistakes.some((m) => m.termId === termId) });
    } else {
      const pair = this.byPair(termId);
      this.mistakes.push({ termId, term: pair?.term, meaningId, pickedMeaning: this.byPair(meaningId)?.meaning });
      this.selectedTerm = null;
    }
    return { correct, termId, meaningId, resolved: correct, done: this.done };
  }

  /** راهنمای بی‌جریمه: یک جفت درست را نشان می‌دهد. */
  hint() {
    const pair = this.pairs.find((p) => !this.matched.has(p.id));
    if (!pair) return null;
    return { termId: pair.id, meaningId: pair.id, term: pair.term, meaning: pair.meaning };
  }

  /** مرور درون‌نشستی: جفت‌هایی که بازیکن در آن‌ها خطا داشته برجسته می‌شوند. */
  tricky() {
    return [...new Set(this.mistakes.map((m) => m.termId))];
  }

  snapshot() {
    const byId = new Map(this.pairs.map((p) => [p.id, p]));
    return {
      gameId: this.gameId,
      mode: this.mode,
      done: this.done,
      selectedTerm: this.selectedTerm,
      terms: this.terms.map((id) => ({
        id,
        label: byId.get(id)?.term || '',
        matched: this.matched.has(id),
        selected: this.selectedTerm === id,
        tricky: this.tricky().includes(id),
        kind: byId.get(id)?.kind || 'word',
      })),
      meanings: this.meanings.map((id) => ({
        id,
        label: byId.get(id)?.meaning || '',
        matched: this.matched.has(id),
        tricky: this.tricky().includes(id),
      })),
      matchedCount: this.matched.size,
      total: this.total,
      mistakes: this.mistakes.length,
    };
  }

  report() {
    const correct = this.pairs.filter((p) => !this.mistakes.some((m) => m.termId === p.id)).length;
    return {
      gameId: this.gameId,
      mode: this.mode,
      total: this.total,
      correct,
      mistakes: this.mistakes.length,
      accuracy: this.total === 0 ? 1 : Math.max(0, (correct / this.total) * (1 - Math.min(0.5, this.mistakes.length * 0.05))),
      items: this.items,
      details: this.mistakes.map((m) => ({ ...m })),
    };
  }
}
