/**
 * LessonHub — «دارالقرآن»: گذرگاه درس‌ها و مرور فاصله‌دار (فاز ۴).
 *
 * این پنل تنها جایی در بازی است که متن قرآن دیده می‌شود؛ در حالت درس (LessonRunner)
 * و همیشه با کلاس `quran-text`. در فهرست درس‌ها هیچ آیه‌ای پیش از ورود به درس
 * نمایش داده نمی‌شود تا متن از دنیای بازی جدا بماند.
 */
import { el, button, faDigits, formatFa } from '../dom.js';
import { EVENTS } from '../../core/EventBus.js';
import { datasetSummary, PLACEHOLDER_LABEL, REVIEW_PENDING_LABEL, lessonDurationLabel, toFaDigits } from '../../game/quran/QuranDataset.js';
import { LessonRunner } from './LessonRunner.js';
import { MINIGAMES } from '../../game/quran/minigames/index.js';

export class LessonHub {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../../game/quran/LearningSystem.js').LearningSystem} options.learning
   * @param {import('../../core/EventBus.js').EventBus} options.bus
   * @param {HTMLElement} [options.parent]
   */
  constructor({ config, learning, bus, parent = document.body, hasBuilding = null }) {
    this.config = config;
    this.learning = learning;
    this.bus = bus;
    /** Optional provider: «آیا دارالقرآن ساخته شده است؟» (پیشنهاد ساخت، بدون قفل‌کردن درس‌ها). */
    this.hasBuilding = hasBuilding;
    this.mode = 'hub';
    this.open = false;

    this.card = el('div', { className: 'ui-modal__card lesson-hub__card' });
    this.root = el('div', {
      className: 'ui-modal lesson-hub is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'دارالقرآن' },
      children: [el('div', { className: 'ui-modal__backdrop' }), this.card],
    });
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.close());
    this._onKey = (event) => {
      if (event.key === 'Escape') this.close();
    };

    this.runner = new LessonRunner({ config, learning, bus });
    this._unsubscribers = [
      bus.on(EVENTS.QURAN_REVIEW_DUE, (payload) => {
        this._due = payload;
        if (this.open && this.mode === 'hub') this.renderHub();
      }),
    ];
    parent.append(this.root);
  }

  /* ------------------------------------------------------------------- open */

  /** @param {{lessonId?:string, review?:boolean}} [options] */
  show({ lessonId = null, review = false } = {}) {
    this.open = true;
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
    this.bus.emit(EVENTS.QURAN_PANEL_OPENED, { kind: 'hub' });
    if (lessonId) {
      const started = this.learning.startLesson(lessonId);
      if (started) {
        this.renderSession(started);
        return;
      }
    }
    if (review && this.learning.reviewQueue().length) {
      const started = this.learning.startReview();
      if (started) {
        this.renderSession({ session: started.session, lesson: null, review: true });
        return;
      }
    }
    this.renderHub();
  }

  hide() {
    this.open = false;
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
    this.mode = 'hub';
    this.runner.unmount();
    this.bus.emit(EVENTS.QURAN_PANEL_CLOSED, {});
  }

  /** بستن از سمت کاربر (دکمهٔ × / کلید Escape / تپ روی پس‌زمینه). */
  close() {
    this.hide();
  }

  /* -------------------------------------------------------------------- hub */

  renderHub() {
    this.mode = 'hub';
    this.runner.unmount();
    const learning = this.learning;
    const summary = datasetSummary(learning.dataset);
    const stats = learning.stats();
    const progress = learning.progress;

    this.card.replaceChildren(
      el('header', {
        className: 'ui-modal__header',
        children: [
          el('h2', { className: 'ui-modal__title', text: '۞ دارالقرآن — درس و مرور' }),
          button('×', { className: 'ui-icon-btn', title: 'بستن', onClick: () => this.close() }),
        ],
      }),

      // ------------------------------------------------ وضعیت ساختمان
      this.hasBuilding && !this.hasBuilding()
        ? el('section', {
          className: 'hub-card hub-card--build',
          children: [
            el('h3', { className: 'ui-modal__subtitle', text: 'دارالقرآن ساخته نشده است' }),
            el('p', { className: 'ui-modal__text', text: 'درس‌ها از همین‌جا هم اجرا می‌شوند، ولی با ساخت «دارالقرآن» از فروشگاه (۳×۳) حکمت هم تولید می‌شود و تپ روی ساختمان، همین پنل را باز می‌کند.' }),
          ],
        })
        : null,

      // ------------------------------------------------ وضعیت دیتاست
      el('section', {
        className: 'hub-card hub-card--dataset',
        children: [
          el('h3', { className: 'ui-modal__subtitle', text: 'دیتاست متن' }),
          el('div', {
            className: 'hub-chips',
            children: [
              el('span', { className: 'hub-chip', text: `${summary.datasetId}${summary.version ? ` · ${summary.version}` : ''}` }),
              el('span', { className: 'hub-chip', text: `منبع: ${summary.origin === 'remote' ? 'دیتاست بیرونی' : 'نمونهٔ داخلی'}` }),
              el('span', { className: 'hub-chip', text: `آیه: ${faDigits(summary.verseCount)}` }),
              el('span', { className: 'hub-chip', text: `درس: ${faDigits(summary.lessonCount)}` }),
              el('span', { className: `hub-chip ${summary.reviewedVerseCount > 0 ? 'is-ok' : 'is-pending'}`, text: `بازبینی‌شده: ${faDigits(summary.reviewedVerseCount)} / ${faDigits(summary.verseCount)}` }),
            ],
          }),
          summary.placeholder || summary.reviewedVerseCount < summary.verseCount
            ? el('p', {
              className: 'hub-notice',
              children: [
                el('span', { className: 'verse-badge verse-badge--placeholder', text: PLACEHOLDER_LABEL }),
                el('span', { className: 'verse-badge verse-badge--pending', text: REVIEW_PENDING_LABEL }),
                el('small', { text: 'آیه‌های قابل‌نمایش تا جایگزینی دیتاست معتبر، همین نشان‌ها را دارند.' }),
              ],
            })
            : null,
          el('p', { className: 'ui-modal__hint', text: `جایگزینی بدون تغییر کد: فایل دیتاست معتبر را در ${summary.expectedPath} بگذارید (راهنما: public/quran/README.md) یا با ?quran=./مسیر/فایل.json بار کنید.` }),
          summary.source ? el('p', { className: 'ui-modal__text', text: `منبع ثبت‌شدهٔ دیتاست: ${summary.source}${summary.license ? ` — مجوز: ${summary.license}` : ''}` }) : null,
        ],
      }),

      // ------------------------------------------------ مرور فاصله‌دار
      el('section', {
        className: 'hub-card hub-card--review',
        children: [
          el('h3', { className: 'ui-modal__subtitle', text: 'مرور فاصله‌دار (لایتنر)' }),
          el('div', {
            className: 'hub-chips',
            children: [
              el('span', { className: `hub-chip ${stats.dueCount > 0 ? 'is-alert' : ''}`, text: `در نوبت مرور: ${faDigits(stats.dueCount)}` }),
              el('span', { className: 'hub-chip', text: `آموخته‌شده: ${faDigits(stats.learned)}` }),
              el('span', { className: 'hub-chip', text: `اقلام ثبت‌شده: ${faDigits(stats.total)}` }),
              el('span', { className: 'hub-chip', text: `استخر تسریع: ${faDigits(stats.speedupPool)} ثانیه` }),
            ],
          }),
          el('div', {
            className: 'leitner-bars',
            children: Object.entries(stats.byBox).map(([box, count]) => el('div', {
              className: 'leitner-bar',
              children: [
                el('span', { className: 'leitner-bar__label', text: `جعبه ${faDigits(box)}` }),
                el('span', {
                  className: 'leitner-bar__fill',
                  style: { width: `${Math.min(100, (count / Math.max(1, stats.total || 1)) * 100)}%` },
                }),
                el('b', { className: 'leitner-bar__count', text: faDigits(count) }),
              ],
            })),
          }),
          el('p', { className: 'ui-modal__text', text: 'موارد اشتباه به جعبهٔ ۱ برمی‌گردند و زودتر دوباره نشان داده می‌شوند؛ این کار هیچ جریمهٔ اقتصادی ندارد.' }),
          el('div', {
            className: 'hub-actions',
            children: [
              button(stats.dueCount > 0 ? `شروع مرور (${faDigits(stats.dueCount)} مورد)` : 'شروع مرور (چیزی در نوبت نیست)', {
                className: 'ui-btn ui-btn--primary',
                onClick: () => {
                  const started = this.learning.startReview();
                  if (!started) return;
                  this.renderSession({ session: started.session, lesson: null, review: true });
                },
              }),
              stats.speedupPool > 0
                ? button(`خرج استخر تسریع (${faDigits(stats.speedupPool)}ث)`, {
                  className: 'ui-btn',
                  onClick: () => {
                    const result = this.learning.useSpeedupPool();
                    this.bus.emit(EVENTS.UI_TOAST, {
                      message: result.ok
                        ? `تسریع ساخت اعمال شد: −${toFaDigits(result.appliedSeconds)} ثانیه`
                        : result.reason === 'no-active-job'
                          ? 'بنّای فعالی برای تسریع وجود ندارد.'
                          : 'استخر تسریع خالی است.',
                      type: result.ok ? 'success' : 'info',
                    });
                    if (this.open && this.mode === 'hub') this.renderHub();
                  },
                })
                : null,
            ],
          }),
        ],
      }),

      // ------------------------------------------------ درس‌ها
      el('section', {
        className: 'hub-card hub-card--lessons',
        children: [
          el('h3', { className: 'ui-modal__subtitle', text: 'درس‌ها (۲ تا ۳ دقیقه)' }),
          el('div', {
            className: 'lesson-list',
            children: learning.dataset.lessons.map((lesson) => {
              const status = learning.lessonStatus(lesson.id);
              return el('article', {
                className: `lesson-row${status.completed ? ' is-done' : ''}`,
                children: [
                  el('div', {
                    className: 'lesson-row__body',
                    children: [
                      el('b', { className: 'lesson-row__title', text: lesson.title }),
                      el('small', { className: 'lesson-row__summary', text: lesson.summary || '' }),
                      el('div', {
                        className: 'lesson-row__meta',
                        children: [
                          el('span', { text: `⏱ ${lessonDurationLabel(lesson)}` }),
                          el('span', { text: `آیه: ${faDigits(lesson.ayahIds.length)}` }),
                          el('span', { text: `واژه: ${faDigits(lesson.wordBank.length)}` }),
                          el('span', { text: lesson.steps.map((s) => (s.game ? MINIGAMES[s.game]?.name || s.game : s.kind === 'read' ? 'خوانش' : 'جمع‌بندی')).join(' · ') }),
                        ],
                      }),
                      status.completed
                        ? el('div', {
                          className: 'lesson-row__stats',
                          children: [
                            el('span', { text: `تکمیل: ${faDigits(status.completions)} بار` }),
                            el('span', { text: `بهترین دقت: ${formatFa(Math.round(status.bestAccuracy * 100))}٪` }),
                            el('span', { text: `مجموع زمان: ${faDigits(Math.round(status.totalSeconds / 60))} دقیقه` }),
                          ],
                        })
                        : null,
                    ],
                  }),
                  button(status.completed ? 'دوباره' : 'شروع درس', {
                    className: 'ui-btn ui-btn--primary',
                    onClick: () => {
                      const started = this.learning.startLesson(lesson.id);
                      if (started) this.renderSession(started);
                    },
                  }),
                ],
              });
            }),
          }),
          progress.totals.lessonsCompleted > 0
            ? el('p', {
              className: 'ui-modal__text',
              text: `مجموع پاداش‌های درسی: نور ${faDigits(Math.round(progress.totals.nurEarned))} · حکمت ${faDigits(Math.round(progress.totals.hekmatEarned))} · تسریع ${faDigits(Math.round(progress.totals.speedupSecondsUsed))} ثانیه (${faDigits(progress.totals.reviewSessions)} نشست مرور)`,
            })
            : null,
        ],
      }),

      // ------------------------------------------------ سیاست محتوایی
      el('section', {
        className: 'hub-card hub-card--policy',
        children: [
          el('h3', { className: 'ui-modal__subtitle', text: 'قواعد نمایش متن قرآن' }),
          el('ul', {
            className: 'hub-policy',
            children: [
              el('li', { text: 'متن آیه فقط داخل رابط درس نمایش داده می‌شود؛ هرگز روی زمین، ساختمان یا افکت.' }),
              el('li', { text: 'نمایش همیشه با کلاس quran-text (فونت قرآنی) و اعراب کامل انجام می‌شود.' }),
              el('li', { text: 'هیچ آیه یا ترجمه‌ای از حافظه نوشته نشده است؛ همهٔ متن‌ها از فایل داده می‌آیند.' }),
              el('li', { text: 'آیه‌های بازبینی‌نشده با نشان «در انتظار بازبینی» دیده می‌شوند.' }),
              el('li', { text: 'هیچ تصویر یا مدلی از پیامبران، ائمه و فرشتگان ساخته نمی‌شود؛ مدل دارالقرآن فقط هندسه و کاشی‌کاری است.' }),
            ],
          }),
        ],
      }),
    );
  }

  /* ---------------------------------------------------------------- session */

  renderSession({ session, lesson, review = false }) {
    this.mode = 'session';
    this.bus.emit(EVENTS.QURAN_LESSON_STARTED, {
      sessionId: session.id,
      lessonId: lesson?.id || null,
      review,
    });
    const container = el('div', { className: 'lesson-host' });
    this.card.replaceChildren(container);
    this.runner.mount(container, session, {
      onFinish: (payload) => this.finishSession(payload),
      onExit: () => this.renderHub(),
    });
  }

  finishSession(payload) {
    this.renderHub();
    const granted = payload.granted;
    const parts = [];
    if (granted.nur > 0) parts.push(`نور +${faDigits(Math.round(granted.nur))}`);
    if (granted.hekmat > 0) parts.push(`حکمت +${faDigits(Math.round(granted.hekmat))}`);
    if (granted.speedup.appliedSeconds > 0) parts.push(`تسریع ساخت −${faDigits(granted.speedup.appliedSeconds)} ثانیه`);
    this.bus.emit(EVENTS.UI_TOAST, {
      message: parts.length ? `پاداش ثبت شد: ${parts.join('، ')}` : 'درس ثبت شد.',
      type: 'success',
    });
  }

  /* ------------------------------------------------------------------ loop */

  update(dt) {
    if (this.open && this.mode === 'session') this.runner.update(dt);
  }

  dispose() {
    for (const off of this._unsubscribers) off();
    window.removeEventListener('keydown', this._onKey);
    this.runner.unmount();
    this.root.remove();
  }
}
