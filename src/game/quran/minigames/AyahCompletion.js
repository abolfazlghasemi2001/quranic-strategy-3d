/**
 * مینی‌گیم «تکمیل آیه» — منطق خالص، بدون DOM و بدون Three.js.
 *
 * قاعدهٔ بازی: یک واژه از متن آیه پنهان می‌شود و بازیکن آن را از میان گزینه‌ها
 * برمی‌گزیند. همهٔ واژه‌ها (خودِ گزینهٔ درست و گزینه‌های نادرست) از دیتاست
 * می‌آیند؛ هیچ واژه‌ای در کد نوشته نشده است.
 *
 * بدون جریمه: انتخاب نادرست فقط آن گزینه را خاموش می‌کند و بازیکن دوباره
 * تلاش می‌کند. شمارش خطا فقط برای گزارش و مرور فاصله‌دار است.
 */
import { Rng } from '../../../core/RNG.js';
import { tokenize } from '../QuranDataset.js';

export const AYAH_COMPLETION_ID = 'ayah-completion';

/** حذف تکرار و برهم‌ریختن فهرست (قطعی، با بذر). */
function uniqueShuffled(list, rng) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class AyahCompletionGame {
  /**
   * @param {object} options
   * @param {object} options.verse — آیهٔ نرمال‌شده از QuranDataset
   * @param {number} [options.rounds]
   * @param {string[]} [options.distractorPool] — واژه‌های جانشین (از سایر آیه‌های دیتاست)
   * @param {object} [options.config] — learning.minigames['ayah-completion']
   * @param {number} [options.seed]
   */
  constructor({ verse, rounds, distractorPool = [], config = {}, seed = 1 }) {
    this.gameId = AYAH_COMPLETION_ID;
    this.verse = verse;
    this.config = config;
    this.rng = new Rng(seed >>> 0);
    this.tokens = tokenize(verse.textUthmani);
    this.rounds = [];
    this.roundIndex = 0;
    this.mistakes = [];
    this.attempts = 0;
    this.items = []; // برای مرور فاصله‌دار: [{ itemId, correct }]

    const requestedRounds = Math.max(1, Number(rounds) || config.rounds || 3);
    const positions = this.tokens.map((_, index) => index);
    for (let i = positions.length - 1; i > 0; i -= 1) {
      const j = this.rng.int(0, i);
      [positions[i], positions[j]] = [positions[j], positions[i]];
    }
    const chosen = positions.slice(0, Math.min(requestedRounds, Math.max(1, this.tokens.length)));

    const pool = uniqueShuffled(
      [...this.tokens, ...distractorPool, ...(verse.words || [])],
      this.rng,
    );

    this.rounds = chosen.map((tokenIndex) => {
      const answer = this.tokens[tokenIndex];
      const optionCount = Math.max(2, Number(config.optionCount) || 4);
      const distractors = pool.filter((token) => token !== answer).slice(0, optionCount - 1);
      const options = uniqueShuffled([answer, ...distractors], this.rng).map((label, index) => ({
        id: `opt-${index}-${label}`,
        label,
        correct: label === answer,
      }));
      return {
        tokenIndex,
        answer,
        options,
        solved: false,
        disabled: [],
        mistakesThisRound: 0,
      };
    });
  }

  get total() {
    return this.rounds.length;
  }

  get done() {
    return this.rounds.every((round) => round.solved);
  }

  get solvedCount() {
    return this.rounds.filter((round) => round.solved).length;
  }

  get current() {
    return this.rounds[this.roundIndex] || null;
  }

  /** بخش‌های آیه برای نمایش: متن‌ها + یک جای خالی. */
  parts(round = this.current) {
    if (!round) return [];
    return this.tokens.map((token, index) => (
      index === round.tokenIndex ? { type: 'blank' } : { type: 'text', text: token }
    ));
  }

  /**
   * انتخاب یک گزینه.
   * @returns {{correct:boolean, exhausted:boolean, roundSolved:boolean, done:boolean, itemId:string}}
   */
  answer(optionId, { now = Date.now() } = {}) {
    void now;
    const round = this.current;
    if (!round || round.solved) {
      return { correct: false, exhausted: false, roundSolved: !!round?.solved, done: this.done, itemId: this.verse.id };
    }
    this.attempts += 1;
    const option = round.options.find((o) => o.id === optionId);
    if (!option) {
      return { correct: false, exhausted: false, roundSolved: false, done: this.done, itemId: this.verse.id };
    }
    if (option.correct) {
      round.solved = true;
      this.items.push({ itemId: this.verse.id, correct: round.mistakesThisRound === 0 });
      if (this.solvedCount < this.total) this.roundIndex = this.rounds.findIndex((r) => !r.solved);
      return { correct: true, exhausted: false, roundSolved: true, done: this.done, itemId: this.verse.id };
    }

    round.mistakesThisRound += 1;
    if (!round.disabled.includes(optionId)) round.disabled.push(optionId);
    this.mistakes.push({
      itemId: this.verse.id,
      round: this.roundIndex,
      picked: option.label,
      answer: round.answer,
    });
    const remaining = round.options.filter((o) => o.correct || !round.disabled.includes(o.id));
    return {
      correct: false,
      exhausted: remaining.length <= 0,
      roundSolved: false,
      done: false,
      itemId: this.verse.id,
    };
  }

  /** راهنمای بی‌جریمه: یک گزینهٔ نادرست را حذف می‌کند. */
  hint() {
    const round = this.current;
    if (!round) return false;
    const candidates = round.options.filter((o) => !o.correct && !round.disabled.includes(o.id));
    if (!candidates.length) return false;
    round.disabled.push(candidates[0].id);
    round.hinted = true;
    return true;
  }

  /** نمایش وضعیت برای رابط کاربری. */
  snapshot() {
    const round = this.current;
    if (!round) {
      return { gameId: this.gameId, done: true, parts: this.tokens.map((text) => ({ type: 'text', text })), options: [], solvedCount: this.solvedCount, total: this.total, mistakes: this.mistakes.length };
    }
    return {
      gameId: this.gameId,
      done: this.done,
      verseId: this.verse.id,
      parts: this.parts(round),
      options: round.options.map((o) => ({ id: o.id, label: o.label, disabled: round.disabled.includes(o.id) })),
      solvedCount: this.solvedCount,
      total: this.total,
      roundIndex: this.roundIndex,
      mistakes: this.mistakes.length,
      hinted: !!round.hinted,
      hintAvailable: round.options.some((o) => !o.correct && !round.disabled.includes(o.id)),
    };
  }

  report() {
    const correct = this.rounds.filter((r) => r.mistakesThisRound === 0).length;
    return {
      gameId: this.gameId,
      verseIds: [this.verse.id],
      total: this.total,
      correct,
      mistakes: this.mistakes.length,
      accuracy: this.attempts === 0 ? 1 : Math.max(0, (correct / Math.max(1, this.rounds.length)) * (1 - Math.min(0.5, this.mistakes.length * 0.05))),
      items: this.items,
      details: this.mistakes.map((m) => ({ ...m })),
    };
  }
}
