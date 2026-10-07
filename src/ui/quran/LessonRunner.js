/**
 * LessonRunner — اجرای یک درس یا نشست مرور (۲ تا ۳ دقیقه) در رابط کاربری.
 *
 * نکته‌های محتوایی:
 *   - متن قرآن فقط داخل همین رابط و با کلاس `quran-text` نمایش داده می‌شود.
 *   - متن قرآن هرگز روی زمین، ساختمان یا افکت نمی‌رود (این ماژول هیچ ارتباطی
 *     با لایهٔ world/engine ندارد).
 *   - خطا جریمه ندارد: هر پاسخ نادرست فقط بازخورد می‌گیرد و دوباره نشان داده می‌شود.
 */
import { el, button, formatFa, faDigits } from '../dom.js';
import { verseCard, stepCounter, noPenaltyNote } from './verseCard.js';
import { createMinigameView } from './minigameViews.js';
import { PLACEHOLDER_LABEL, REVIEW_PENDING_LABEL } from '../../game/quran/QuranDataset.js';

/** ثانیه → «۰۲:۳۵» */
export function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return faDigits(`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
}

export class LessonRunner {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../../game/quran/LearningSystem.js').LearningSystem} options.learning
   * @param {import('../../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ config, learning, bus = null }) {
    this.config = config;
    this.learning = learning;
    this.bus = bus;
    this.session = null;
    this.view = null;
    this.payload = null; // نتیجهٔ finishSession
    this._clockAcc = 0;

    this.clockNode = el('b', { className: 'lesson-meta__clock', text: '۰۰:۰۰' });
    this.mistakeNode = el('span', { className: 'lesson-meta__mistakes' });
    this.progressNode = el('div', { className: 'lesson-progress' });
    this.counterNode = el('span', { className: 'lesson-runner__counter' });
    this.body = el('div', { className: 'lesson-body' });
    this.footer = el('div', { className: 'lesson-footer' });

    this.root = el('div', {
      className: 'lesson-runner',
      children: [
        el('header', {
          className: 'lesson-runner__head',
          children: [
            el('div', {
              className: 'lesson-runner__titles',
              children: [
                el('h2', { className: 'lesson-runner__title', text: 'درس' }),
                this.counterNode,
              ],
            }),
            button('خروج', { className: 'ui-btn ui-btn--ghost', title: 'خروج از درس (بدون جریمه)', onClick: () => this.exit() }),
          ],
        }),
        el('div', {
          className: 'lesson-meta',
          children: [
            el('span', { className: 'lesson-meta__item', children: [el('span', { text: '⏱ ' }), this.clockNode] }),
            el('span', { className: 'lesson-meta__item lesson-meta__item--target', text: '' }),
            this.mistakeNode,
            this.progressNode,
          ],
        }),
        this.body,
        this.footer,
      ],
    });

    this.onExit = null;
    this.onFinish = null;
    this.onRequestClose = null;
  }

  /* ------------------------------------------------------------------ mount */

  /**
   * @param {HTMLElement} container
   * @param {import('../../game/quran/LessonEngine.js').LessonSession} session
   * @param {object} [handlers]
   */
  mount(container, session, { onExit = null, onFinish = null, onRequestClose = null } = {}) {
    this.session = session;
    this.payload = null;
    this.onExit = onExit;
    this.onFinish = onFinish;
    this.onRequestClose = onRequestClose;
    const step = session.current;
    if (step && !step.startedAt) step.startedAt = Date.now();
    container.replaceChildren(this.root);
    this.render();
    return this;
  }

  unmount() {
    this.session = null;
    this.view = null;
    this.root.remove();
  }

  /* ----------------------------------------------------------------- render */

  render() {
    const session = this.session;
    if (!session) return;
    const snap = session.snapshot(Date.now());
    this.root.querySelector('.lesson-runner__title').textContent = snap.lessonTitle;
    this.counterNode.textContent = stepCounter(snap.stepIndex, snap.stepTotal);
    this.root.querySelector('.lesson-meta__item--target').textContent = `از حدود ${formatClock(snap.targetSeconds)} · متن قرآن فقط در همین درس`;
    this.mistakeNode.textContent = `خطا: ${faDigits(snap.mistakes)} (بدون جریمه)`;
    this.mistakeNode.classList.toggle('is-zero', snap.mistakes === 0);
    this.progressNode.replaceChildren(el('span', { className: 'lesson-progress__fill', style: { width: `${Math.round(snap.ratio * 100)}%` } }));

    if (this.payload) {
      this.renderReward(snap);
      return;
    }

    this.renderStep(snap);
    this.renderFooter(snap);
    this.refreshClock();
  }

  renderStep(snap) {
    if (this.view?.dispose) this.view.dispose();
    this.view = null;
    this.body.replaceChildren();
    const step = snap.step;
    if (!step) {
      this.body.append(el('p', { className: 'ui-modal__text', text: 'مرحله‌ای برای نمایش نیست.' }));
      return;
    }

    if (step.kind === 'read') {
      this.body.append(
        el('section', {
          className: 'lesson-step lesson-step--read',
          children: [
            el('h3', { className: 'lesson-step__title', text: step.title }),
            // NOTE: the verse lives on step.verse — passing the step wrapper would
            // render an empty card (caught by tools/smoke.mjs, phase 4 ⑤).
            verseCard(step.verse, { showTranslation: true, showSource: true }),
            el('p', {
              className: 'lesson-step__note',
              text: `برچسب «${PLACEHOLDER_LABEL}» و «${REVIEW_PENDING_LABEL}» از وضعیت خود دیتاست می‌آید و پس از جایگزینی دیتاست معتبر و بازبینی انسانی برداشته می‌شود.`,
            }),
            noPenaltyNote('هیچ پاسخ یا زمانی در این مرحله شمرده نمی‌شود؛ با آرامش بخوان.'),
          ],
        }),
      );
      return;
    }

    if (step.kind === 'quiz') {
      const game = this.session.current?.game;
      const view = game ? createMinigameView({ game, onAnswer: (result) => this.handleAnswer(result) }) : null;
      if (!view) {
        this.body.append(el('p', { className: 'ui-modal__text', text: 'این مینی‌گیم با دیتاست فعلی قابل اجرا نیست.' }));
        return;
      }
      this.view = view;
      this.body.append(
        el('section', {
          className: 'lesson-step lesson-step--quiz',
          children: [
            step.requeue ? el('p', { className: 'lesson-step__requeue', text: 'مرور خطاهای همین درس — بدون جریمه' }) : null,
            view.root,
          ],
        }),
      );
      return;
    }

    // summary
    const stepTitles = this.session.steps.filter((s) => s.kind === 'quiz').map((s) => s.title);
    this.body.append(
      el('section', {
        className: 'lesson-step lesson-step--summary',
        children: [
          el('h3', { className: 'lesson-step__title', text: step.title || 'جمع‌بندی' }),
          el('p', { className: 'lesson-step__note', text: 'پاداش‌ها فقط تسریع‌کننده‌اند: نور، حکمت و کوتاه‌شدن تایمر بنّا. بازی بدون درس هم کامل می‌شود.' }),
          el('ul', {
            className: 'lesson-summary',
            children: [
              el('li', { text: `تمرین‌های این درس: ${stepTitles.join('، ') || '—'}` }),
              el('li', { text: `زمان سپری‌شده: ${formatClock(snap.elapsedSeconds)} (هدف حدود ${formatClock(snap.targetSeconds)})` }),
              el('li', { text: `خطاها: ${faDigits(snap.mistakes)} — هیچ جریمه‌ای اعمال نمی‌شود` }),
              el('li', { text: 'پس از پایان، موارد نیازمند مرور دوباره زمان‌بندی می‌شوند (مرور فاصله‌دار).' }),
            ],
          }),
        ],
      }),
    );
  }

  renderFooter(snap) {
    const step = snap.step;
    const actions = [];
    if (step?.kind === 'quiz' && this.session.current?.game?.hint) {
      actions.push(button('راهنما (بدون جریمه)', {
        className: 'ui-btn ui-btn--ghost',
        onClick: () => {
          this.session.hint();
          this.render();
        },
      }));
    }
    if (step?.kind === 'read') {
      actions.push(button('خواندم، ادامه', {
        className: 'ui-btn ui-btn--primary',
        onClick: () => {
          this.session.current.done = true;
          this.advance();
        },
      }));
    } else if (step?.kind === 'quiz') {
      actions.push(button('مرحلهٔ بعد', {
        className: 'ui-btn ui-btn--primary',
        onClick: () => this.advance(),
      }));
    } else {
      actions.push(button('پایان و دریافت پاداش', {
        className: 'ui-btn ui-btn--primary',
        onClick: () => this.finish(),
      }));
    }
    this.footer.replaceChildren(...actions);
    const advanceBtn = this.footer.querySelector('.ui-btn--primary');
    if (advanceBtn && step?.kind === 'quiz') advanceBtn.disabled = !snap.canAdvance;
    return actions;
  }

  renderReward(snap) {
    const { granted } = this.payload;
    const stats = this.payload.stats;
    this.footer.replaceChildren();
    this.body.replaceChildren(
      el('section', {
        className: 'lesson-step lesson-step--reward',
        children: [
          el('h3', { className: 'lesson-step__title', text: 'پاداش نشست' }),
          el('div', {
            className: 'reward-grid',
            children: [
              el('div', { className: 'reward-chip', children: [el('b', { text: `+${formatFa(Math.round(granted.nur))}` }), el('small', { text: 'نور' })] }),
              el('div', { className: 'reward-chip', children: [el('b', { text: `+${formatFa(Math.round(granted.hekmat))}` }), el('small', { text: 'حکمت' })] }),
              el('div', { className: 'reward-chip', children: [el('b', { text: `${formatFa(granted.speedup.appliedSeconds)} ثانیه` }), el('small', { text: 'تسریع ساخت' })] }),
              el('div', { className: 'reward-chip', children: [el('b', { text: `${formatFa(granted.speedup.poolTotal)} ثانیه` }), el('small', { text: 'ذخیرهٔ تسریع' })] }),
            ],
          }),
          el('ul', {
            className: 'lesson-summary',
            children: [
              el('li', { text: `زمان درس: ${formatClock(snap.elapsedSeconds)}` }),
              el('li', { text: `خطاها: ${faDigits(snap.mistakes)} — بدون جریمه` }),
              el('li', { text: `اقلام در نوبت مرور: ${faDigits(stats.dueCount)}` }),
              el('li', { text: `درس‌های کامل‌شده: ${faDigits(stats.lessonsCompleted)} · نشست‌های مرور: ${faDigits(stats.reviewSessions)}` }),
              granted.overflow && (granted.overflow.nur || granted.overflow.hekmat)
                ? el('li', { className: 'is-warn', text: 'انبار پر بود؛ بخشی از پاداش ذخیره نشد — این هم جریمه نیست، فقط سقف انبار.' })
                : null,
            ],
          }),
          el('p', { className: 'lesson-step__note', text: 'مرور فاصله‌دار: موارد اشتباه در فاصلهٔ کوتاه‌تر و موارد درست در فاصله‌های بلندتر دوباره نشان داده می‌شوند.' }),
        ],
      }),
    );
    const actions = [
      button('بازگشت به دارالقرآن', {
        className: 'ui-btn ui-btn--primary',
        onClick: () => this.onFinish?.(this.payload),
      }),
    ];
    this.footer.replaceChildren(...actions);
  }

  /* ---------------------------------------------------------------- actions */

  handleAnswer(result) {
    if (!this.session) return;
    this.session.registerAnswer(result);
    this.mistakeNode.textContent = `خطا: ${faDigits(this.session.mistakes)} (بدون جریمه)`;
    const advanceBtn = this.footer.querySelector('.ui-btn--primary');
    if (advanceBtn && this.session.stepDone()) advanceBtn.disabled = false;
  }

  advance() {
    if (!this.session) return;
    const step = this.session.current;
    if (step?.kind === 'quiz' && !this.session.stepDone()) return;
    const result = this.session.advance(Date.now());
    this.bus?.emit('quran:lesson-step', { sessionId: this.session.id, index: this.session.stepIndex });
    if (result.done) {
      this.finish();
      return;
    }
    this.render();
  }

  finish() {
    if (!this.session || this.payload) return;
    this.payload = this.learning.finishSession(this.session, Date.now());
    this.render();
  }

  exit() {
    if (this.payload) {
      this.onFinish?.(this.payload);
      return;
    }
    this.onExit?.();
  }

  /* ------------------------------------------------------------------ clock */

  update(dt) {
    if (!this.session || this.payload) return;
    this._clockAcc += dt;
    if (this._clockAcc < 0.5) return;
    this._clockAcc = 0;
    this.refreshClock();
  }

  refreshClock() {
    if (!this.session) return;
    const elapsed = this.session.elapsedSeconds(Date.now());
    this.clockNode.textContent = formatClock(elapsed);
    const target = this.session.targetSeconds || 0;
    this.clockNode.classList.toggle('is-over', target > 0 && elapsed > target);
  }
}
