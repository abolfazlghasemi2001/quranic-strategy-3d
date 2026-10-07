/**
 * minigameViews — نمای سه مینی‌گیم فاز ۴ (فقط رابط کاربری، منطق در game/quran).
 *
 * همهٔ نماها یک قرارداد دارند:
 *   createXView({ game, onAnswer, note }) → { root, refresh(), dispose() }
 * و هیچ‌کدام متن قرآنی تولید نمی‌کنند؛ متن از `game` (که خودش از دیتاست می‌خواند)
 * می‌آید و همیشه با کلاس `quran-text` نمایش داده می‌شود.
 */
import { el, button, faDigits } from '../dom.js';
import { noPenaltyNote } from './verseCard.js';

const MAX_CHIP = 90; // بریدن متن‌های بسیار بلند در کاشی‌های بازی (نمایشی، امن)

function clip(text, max = MAX_CHIP) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function feedbackNode() {
  return el('p', { className: 'minigame__feedback', attrs: { role: 'status', 'aria-live': 'polite' } });
}

/* ------------------------------------------------ ۱) تکمیل آیه */

export function createAyahCompletionView({ game, onAnswer = () => {} }) {
  const feedback = feedbackNode();
  const board = el('div', { className: 'minigame__board' });
  const options = el('div', { className: 'mcg-options' });
  const hintBtn = button('راهنما (بدون جریمه)', { className: 'ui-btn ui-btn--ghost', onClick: () => { if (game.hint()) { feedback.textContent = 'یک گزینهٔ نادرست حذف شد — بدون جریمه.'; refresh(); } } });

  const root = el('section', {
    className: 'minigame minigame--completion',
    children: [
      el('header', {
        className: 'minigame__head',
        children: [
          el('h3', { className: 'minigame__title', text: 'تکمیل آیه' }),
          el('span', { className: 'minigame__counter' }),
        ],
      }),
      el('p', { className: 'minigame__hint', text: 'واژهٔ پنهان‌شده را از میان گزینه‌ها برگزین. متن آیه فقط همین‌جا نمایش داده می‌شود.' }),
      board,
      options,
      feedback,
      noPenaltyNote(),
      el('div', { className: 'minigame__actions', children: [hintBtn] }),
    ],
  });

  function refresh() {
    const snap = game.snapshot();
    root.querySelector('.minigame__counter').textContent = `${faDigits(Math.min(snap.solvedCount + 1, snap.total))} / ${faDigits(snap.total)}`;
    board.replaceChildren();
    const line = el('p', { className: 'quran-text minigame__verse', attrs: { dir: 'rtl', lang: 'ar' } });
    for (const part of snap.parts) {
      if (part.type === 'blank') {
        const round = game.current;
        line.append(el('span', {
          className: `mcg-blank${round?.solved ? ' is-solved' : ''}`,
          text: round?.solved ? round.answer : '⋯',
        }));
      } else {
        line.append(el('span', { className: 'mcg-token', text: part.text }), document.createTextNode(' '));
      }
    }
    board.append(line);

    options.replaceChildren();
    for (const option of snap.options) {
      const btn = button(option.label, { className: `mcg-option${option.disabled ? ' is-off' : ''}` });
      btn.disabled = !!option.disabled || snap.done;
      btn.addEventListener('click', () => {
        const result = game.answer(option.id);
        onAnswer({ itemId: result.itemId, correct: result.correct });
        feedback.textContent = result.correct
          ? '✓ درست است. واژهٔ بعدی…'
          : '✗ این گزینه درست نبود؛ دوباره تلاش کن — بدون جریمه.';
        feedback.className = `minigame__feedback ${result.correct ? 'is-ok' : 'is-bad'}`;
        refresh();
      });
      options.append(btn);
    }
    hintBtn.disabled = !snap.hintAvailable || snap.done;
    if (snap.done) feedback.textContent = 'هر سه واژه کامل شد.';
  }

  refresh();
  return { root, refresh, dispose: () => root.remove() };
}

/* ------------------------------------------------ ۲) تطبیق واژه و معنی */

export function createWordMatchView({ game, onAnswer = () => {} }) {
  const feedback = feedbackNode();
  const termsCol = el('div', { className: 'wm-col wm-col--terms' });
  const meaningsCol = el('div', { className: 'wm-col wm-col--meanings' });
  const modeNote = game.mode === 'ayah-translation'
    ? 'این درس واژه‌نامه ندارد؛ بازی روی جفت «متن آیه ↔ ترجمهٔ همان آیه» اجرا می‌شود.'
    : 'واژه را انتخاب کن، بعد معنی آن را بزن.';
  const hintBtn = button('راهنما (بدون جریمه)', {
    className: 'ui-btn ui-btn--ghost',
    onClick: () => {
      const hint = game.hint();
      if (!hint) return;
      feedback.textContent = `راهنما: «${clip(hint.term, 40)}» ↔ «${clip(hint.meaning, 60)}»`;
      feedback.className = 'minigame__feedback is-hint';
    },
  });

  const root = el('section', {
    className: 'minigame minigame--match',
    children: [
      el('header', {
        className: 'minigame__head',
        children: [
          el('h3', { className: 'minigame__title', text: 'تطبیق واژه و معنی' }),
          el('span', { className: 'minigame__counter' }),
        ],
      }),
      el('p', { className: 'minigame__hint', text: modeNote }),
      el('div', { className: 'wm-grid', children: [termsCol, meaningsCol] }),
      feedback,
      noPenaltyNote(),
      el('div', { className: 'minigame__actions', children: [hintBtn] }),
    ],
  });

  function refresh() {
    const snap = game.snapshot();
    root.querySelector('.minigame__counter').textContent = `${faDigits(snap.matchedCount)} / ${faDigits(snap.total)}`;
    termsCol.replaceChildren(el('h4', { className: 'wm-col__title', text: 'واژه' }));
    meaningsCol.replaceChildren(el('h4', { className: 'wm-col__title', text: 'معنی' }));

    for (const term of snap.terms) {
      const chip = button(clip(term.label), {
        className: `wm-chip wm-chip--term${term.matched ? ' is-matched' : ''}${term.selected ? ' is-selected' : ''}${term.tricky ? ' is-tricky' : ''}${term.kind === 'ayah' ? ' wm-chip--ayah' : ''}`,
      });
      chip.disabled = term.matched || snap.done;
      chip.addEventListener('click', () => {
        game.selectTerm(term.id);
        feedback.textContent = term.selected ? '' : 'واژه گزیده شد؛ حالا معنی آن را بزن.';
        refresh();
      });
      termsCol.append(chip);
    }

    for (const meaning of snap.meanings) {
      const chip = button(clip(meaning.label, 140), {
        className: `wm-chip wm-chip--meaning${meaning.matched ? ' is-matched' : ''}${meaning.tricky ? ' is-tricky' : ''}`,
      });
      chip.disabled = meaning.matched || snap.done || !snap.selectedTerm;
      chip.addEventListener('click', () => {
        const result = game.selectMeaning(meaning.id);
        onAnswer({ itemId: result.termId, correct: result.correct });
        feedback.textContent = result.correct
          ? '✓ جفت درست شد.'
          : '✗ این جفت درست نبود؛ دوباره تلاش کن — بدون جریمه.';
        feedback.className = `minigame__feedback ${result.correct ? 'is-ok' : 'is-bad'}`;
        refresh();
      });
      meaningsCol.append(chip);
    }
    if (snap.done && snap.total > 0) feedback.textContent = 'همهٔ جفت‌ها درست شد.';
  }

  refresh();
  return { root, refresh, dispose: () => root.remove() };
}

/* ------------------------------------------------ ۳) ترتیب آیات */

export function createAyahOrderView({ game, onAnswer = () => {} }) {
  const list = el('div', { className: 'ao-list' });
  const feedback = feedbackNode();
  let selected = null;

  const checkBtn = button('بررسی ترتیب', {
    className: 'ui-btn ui-btn--primary',
    onClick: () => {
      const result = game.check();
      onAnswer({ itemId: game.verseId || game.snapshot().verseId, correct: result.correct });
      feedback.textContent = result.correct
        ? `✓ ترتیب درست است.`
        : result.locked.length
          ? `${faDigits(result.locked.length)} کارت در جای درست بود و قفل شد — ادامه بده (بدون جریمه).`
          : 'ترتیب هنوز درست نیست؛ دوباره بچین — بدون جریمه.';
      feedback.className = `minigame__feedback ${result.correct ? 'is-ok' : 'is-bad'}`;
      refresh();
    },
  });
  const hintBtn = button('راهنما (بدون جریمه)', {
    className: 'ui-btn ui-btn--ghost',
    onClick: () => {
      const hint = game.hint();
      if (!hint) return;
      feedback.textContent = `یک کارت در جای درستش گذاشته شد (جای ${faDigits(hint.at + 1)}).`;
      feedback.className = 'minigame__feedback is-hint';
      refresh();
    },
  });

  const root = el('section', {
    className: 'minigame minigame--order',
    children: [
      el('header', {
        className: 'minigame__head',
        children: [
          el('h3', { className: 'minigame__title', text: 'ترتیب آیات' }),
          el('span', { className: 'minigame__counter' }),
        ],
      }),
      el('p', { className: 'minigame__hint', text: 'دو کارت را پشت‌سرهم بزن تا جابه‌جا شوند، یا با فلش‌ها یک پله جابه‌جا کن؛ بعد «بررسی ترتیب».' }),
      list,
      feedback,
      noPenaltyNote(),
      el('div', { className: 'minigame__actions', children: [checkBtn, hintBtn] }),
    ],
  });

  function refresh() {
    const snap = game.snapshot();
    root.querySelector('.minigame__counter').textContent = `${faDigits(snap.lockedCount)} / ${faDigits(snap.total)}`;
    list.replaceChildren();
    snap.cards.forEach((card, index) => {
      const label = el('p', { className: 'quran-text ao-card__text', attrs: { dir: 'rtl', lang: 'ar' }, text: clip(card.text, 130) });
      const row = el('article', {
        className: `ao-card${card.locked ? ' is-locked' : ''}${selected === card.id ? ' is-selected' : ''}${card.correct ? ' is-correct' : ''}`,
        attrs: { 'data-card-id': card.id },
        children: [
          el('div', { className: 'ao-card__index', text: faDigits(index + 1) }),
          el('div', { className: 'ao-card__body', children: [label, card.caption ? el('small', { className: 'ao-card__caption', text: clip(card.caption, 100) }) : null] }),
          el('div', {
            className: 'ao-card__tools',
            children: [
              button('▲', { className: 'ui-icon-chip', title: 'یک پله بالا', onClick: () => { game.nudge(card.id, -1); refresh(); } }),
              button('▼', { className: 'ui-icon-chip', title: 'یک پله پایین', onClick: () => { game.nudge(card.id, 1); refresh(); } }),
            ],
          }),
        ],
      });
      row.addEventListener('click', (event) => {
        if (event.target.closest('.ui-icon-chip') || card.locked) return;
        if (selected === card.id) {
          selected = null;
        } else if (selected) {
          game.swap(selected, card.id);
          selected = null;
        } else {
          selected = card.id;
        }
        refresh();
      });
      list.append(row);
    });
    checkBtn.disabled = snap.done;
    hintBtn.disabled = snap.done;
  }

  refresh();
  return { root, refresh, dispose: () => root.remove() };
}

/** ساخت نمای مناسب برای بازی جاری. */
export function createMinigameView({ game, onAnswer }) {
  if (!game) return null;
  if (game.gameId === 'ayah-completion') return createAyahCompletionView({ game, onAnswer });
  if (game.gameId === 'word-match') return createWordMatchView({ game, onAnswer });
  if (game.gameId === 'ayah-order') return createAyahOrderView({ game, onAnswer });
  return null;
}
