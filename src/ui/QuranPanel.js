/**
 * QuranPanel — the project's Quran content policy, made visible in the UI.
 *
 * Content red line for this project:
 *   - Quran text/translations are NEVER written from memory; they may only be
 *     read from a verified dataset (e.g. Tanzil).
 *   - Until such a dataset exists in the repo (public/quran/), only a placeholder
 *     explicitly labelled «نمونه — جایگزین شود» is shown.
 *   - Quran text never appears on the ground, on destructible structures or in
 *     battle effects; when shown it uses the Quranic font class with full
 *     diacritics.
 *
 * The technical fixture below is a font/diacritics test made of isolated marks —
 * it contains no Quranic words.
 */
import { el } from './dom.js';
import { datasetSummary, PLACEHOLDER_LABEL, REVIEW_PENDING_LABEL } from '../game/quran/QuranDataset.js';

const DIACRITICS_FIXTURE = '\u0640\u064B \u0640\u064C \u0640\u064D \u0640\u064E \u0640\u064F \u0640\u0650 \u0640\u0651 \u0640\u0652 \u0640\u0670';

export class QuranPanel {
  constructor({ config, parent, learning = null }) {
    this.config = config;
    this.learning = learning;
    const t = (key, fallback) => config.t(key, fallback);
    this.datasetSection = el('section', { className: 'ui-modal__section' });

    this.root = el('div', {
      className: 'ui-modal is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true' },
      children: [
        el('div', { className: 'ui-modal__backdrop' }),
        el('div', {
          className: 'ui-modal__card',
          children: [
            el('header', {
              className: 'ui-modal__header',
              children: [
                el('h2', { className: 'ui-modal__title', text: t('quran.title', 'سیاست نمایش متن قرآن') }),
                el('button', {
                  className: 'ui-icon-btn',
                  attrs: { type: 'button', 'aria-label': t('quran.close', 'بستن') },
                  text: '×',
                }),
              ],
            }),
            el('section', {
              className: 'ui-modal__section',
              children: [
                el('h3', { className: 'ui-modal__subtitle', text: t('quran.policyTitle', 'قاعدهٔ محتوایی پروژه') }),
                el('p', { className: 'ui-modal__text', text: t('quran.policyBody', '') }),
              ],
            }),
            this.datasetSection,
            el('section', {
              className: 'ui-modal__section',
              children: [
                el('figure', {
                  className: 'quran-card',
                  children: [
                    el('figcaption', { className: 'quran-card__label', text: t('quran.placeholderLabel', 'نمونه — جایگزین شود') }),
                    el('p', { className: 'quran-text', text: t('quran.placeholderBody', '') }),
                  ],
                }),
                el('p', { className: 'ui-modal__hint', text: t('quran.datasetHint', '') }),
              ],
            }),
            el('section', {
              className: 'ui-modal__section',
              children: [
                el('h3', { className: 'ui-modal__subtitle', text: t('quran.fixtureTitle', 'آزمون نمایش فونت و اعراب') }),
                el('p', { className: 'ui-modal__text', text: t('quran.fixtureBody', '') }),
                el('p', { className: 'quran-text quran-text--fixture', text: DIACRITICS_FIXTURE }),
              ],
            }),
            el('p', { className: 'ui-modal__note', text: t('quran.inWorldNote', '') }),
          ],
        }),
      ],
    });

    this.root.querySelector('.ui-icon-btn').addEventListener('click', () => this.hide());
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.hide());
    this._onKey = (event) => {
      if (event.key === 'Escape') this.hide();
    };
    parent.append(this.root);
  }

  /** وضعیت زندهٔ دیتاست (فاز ۴): مسیر جایگزینی، شمارش بازبینی، برچسب‌ها. */
  renderDatasetStatus() {
    if (!this.learning?.dataset) {
      this.datasetSection.replaceChildren();
      return;
    }
    const summary = datasetSummary(this.learning.dataset);
    this.datasetSection.replaceChildren(
      el('h3', { className: 'ui-modal__subtitle', text: this.config.t('quran.datasetTitle', 'دیتاست متن قرآن') }),
      el('div', {
        className: 'hub-chips',
        children: [
          el('span', { className: 'hub-chip', text: summary.datasetId }),
          el('span', {
            className: 'hub-chip',
            text: summary.origin === 'remote'
              ? this.config.t('quran.datasetLoaded', 'دیتاست بیرونی بارگذاری شد')
              : this.config.t('quran.datasetSample', 'نمونهٔ داخلی (جای‌نگهدار)'),
          }),
          el('span', { className: 'hub-chip', text: `آیه‌های بازبینی‌شده: ${summary.reviewedVerseCount}/${summary.verseCount}` }),
          el('span', { className: 'hub-chip is-pending', text: REVIEW_PENDING_LABEL }),
        ],
      }),
      el('p', { className: 'ui-modal__hint', text: `مسیر جایگزینی: ${summary.expectedPath} — یا بارگذاری با ?quran=./مسیر/فایل.json` }),
    );
  }

  show() {
    this.renderDatasetStatus();
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
  }

  hide() {
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    this.root.remove();
  }
}
