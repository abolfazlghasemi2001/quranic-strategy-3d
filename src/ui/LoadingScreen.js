/**
 * LoadingScreen + ErrorOverlay. Both are DOM only; they never touch Three.js.
 */
import { el } from './dom.js';

export class LoadingScreen {
  constructor({ config, parent }) {
    this.config = config;
    const t = (key, fallback) => config.t(key, fallback);

    this.stepLabel = el('p', { className: 'ui-loading__step', text: t('loading.steps.config', 'آماده‌سازی') });
    this.percent = el('span', { className: 'ui-loading__percent', text: '۰٪' });
    this.bar = el('div', { className: 'ui-loading__bar-fill' });
    this.hint = el('p', { className: 'ui-loading__hint', text: t('loading.title', 'در حال آماده‌سازی…') });

    this.root = el('div', {
      className: 'ui-loading',
      attrs: { role: 'status', 'aria-live': 'polite' },
      children: [
        el('div', {
          className: 'ui-loading__card',
          children: [
            el('div', { className: 'ui-loading__glyph', text: '✦' }),
            el('h1', { className: 'ui-loading__title', text: config.t('app.title', 'شهر نور') }),
            this.hint,
            el('div', { className: 'ui-loading__bar' }, ),
            el('div', { className: 'ui-loading__meta', children: [this.stepLabel, this.percent] }),
          ],
        }),
      ],
    });
    this.root.querySelector('.ui-loading__bar').append(this.bar);
    parent.append(this.root);
  }

  /** @param {string} step key from data/strings.fa.json (loading.steps.*) */
  setStep(step, ratio) {
    const label = this.config.t(`loading.steps.${step}`, step);
    this.stepLabel.textContent = label;
    this.setRatio(ratio);
  }

  setRatio(ratio) {
    const clamped = Math.max(0, Math.min(1, Number(ratio) || 0));
    this.bar.style.width = `${clamped * 100}%`;
    this.percent.textContent = `${Math.round(clamped * 100)}٪`;
    this.percent.textContent = this.percent.textContent.replace(/[0-9]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]);
  }

  hide() {
    this.root.classList.add('is-hidden');
    window.setTimeout(() => this.root.remove(), 420);
  }
}

export class ErrorOverlay {
  constructor({ config, parent }) {
    this.config = config;
    this.root = el('div', {
      className: 'ui-error is-hidden',
      children: [
        el('div', {
          className: 'ui-error__card',
          children: [
            el('h2', { className: 'ui-error__title', text: config.t('errors.title', 'خطا در اجرا') }),
            el('p', { className: 'ui-error__body' }),
            el('button', {
              className: 'ui-btn ui-btn--primary',
              attrs: { type: 'button' },
              text: config.t('errors.reload', 'تلاش دوباره'),
            }),
          ],
        }),
      ],
    });
    this.body = this.root.querySelector('.ui-error__body');
    this.root.querySelector('button').addEventListener('click', () => window.location.reload());
    parent.append(this.root);
  }

  show(message) {
    this.body.textContent = message;
    this.root.classList.remove('is-hidden');
  }
}
