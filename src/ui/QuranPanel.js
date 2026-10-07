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

const DIACRITICS_FIXTURE = '\u0640\u064B \u0640\u064C \u0640\u064D \u0640\u064E \u0640\u064F \u0640\u0650 \u0640\u0651 \u0640\u0652 \u0640\u0670';

export class QuranPanel {
  constructor({ config, parent }) {
    this.config = config;
    const t = (key, fallback) => config.t(key, fallback);

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

  show() {
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
