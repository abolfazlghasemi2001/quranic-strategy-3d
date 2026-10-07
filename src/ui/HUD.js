/**
 * HUD — top bar (brand + live counters), the gesture help card and the pause badge.
 * All text comes from the Persian string table, all numbers are Persian digits.
 */
import { el, button, faDigits, formatFa } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

const TIER_LABEL = { low: 'پایین', medium: 'متوسط', high: 'بالا' };

export class HUD {
  constructor({ config, engine, bus, monitor, rig, onOpenQuran }) {
    this.config = config;
    this.engine = engine;
    this.bus = bus;
    this.monitor = monitor;
    this.rig = rig;

    const t = (key, fallback) => config.t(key, fallback);

    this.fpsValue = el('span', { className: 'ui-chip__value', text: '—' });
    this.drawValue = el('span', { className: 'ui-chip__value', text: '—' });
    this.zoomValue = el('span', { className: 'ui-chip__value', text: '—' });
    this.triValue = el('span', { className: 'ui-chip__value', text: '—' });

    this.chips = el('div', {
      className: 'ui-chips',
      children: [
        this._chip(t('hud.fps', 'فریم بر ثانیه'), this.fpsValue, 'ui-chip--good'),
        this._chip(t('hud.drawCalls', 'فراخوان رسم'), this.drawValue),
        this._chip(t('hud.triangles', 'مثلث'), this.triValue),
        this._chip(t('hud.zoom', 'زوم'), this.zoomValue),
        this._chip(t('hud.quality', 'کیفیت'), el('span', { className: 'ui-chip__value', text: TIER_LABEL[config.quality.tier] || '—' }), 'ui-chip--strong'),
      ],
    });

    this.topBar = el('div', {
      className: 'ui-top',
      children: [
        el('div', {
          className: 'ui-brand',
          children: [
            el('h1', { className: 'ui-brand__title', text: t('app.title', 'شهر نور') }),
            el('p', { className: 'ui-brand__subtitle', text: t('app.phase', '') }),
          ],
        }),
        this.chips,
      ],
    });

    // ---- gesture help ------------------------------------------------------
    this.helpClose = el('button', {
      className: 'ui-icon-btn',
      attrs: {
        type: 'button',
        'aria-label': t('hud.helpDismiss', 'بستن راهنما'),
        title: t('hud.helpDismiss', 'بستن راهنما'),
      },
      text: '×',
    });
    this.helpClose.addEventListener('click', () => this.helpCard.classList.add('is-hidden'));

    this.helpCard = el('div', {
      className: 'ui-help',
      children: [
        el('div', {
          className: 'ui-help__head',
          children: [el('h2', { className: 'ui-help__title', text: t('hud.helpTitle', 'راهنمای کنترل') }), this.helpClose],
        }),
        el('ul', {
          className: 'ui-help__list',
          children: [
            el('li', { text: t('hud.helpTouch', '') }),
            el('li', { text: t('hud.helpDesktop', '') }),
            el('li', { text: t('hud.helpKeys', '') }),
            el('li', {
              children: [
                button(t('hud.quranButton', 'سیاست متن قرآن'), {
                  className: 'ui-btn',
                  onClick: () => onOpenQuran && onOpenQuran(),
                }),
              ],
            }),
          ],
        }),
      ],
    });

    this.pauseBadge = el('div', { className: 'ui-pause', text: t('hud.paused', 'متوقف') });

    this.root = el('div', {
      className: 'ui-root',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [el('div', { className: 'ui-vignette' }), this.topBar, this.helpCard, this.pauseBadge],
    });
    document.body.append(this.root);

    this._unsubscribers = [
      bus.on(EVENTS.GAME_PAUSED, ({ paused }) => this.pauseBadge.classList.toggle('is-visible', paused)),
    ];
  }

  _chip(label, valueNode, extraClass = '') {
    return el('span', {
      className: `ui-chip ${extraClass}`.trim(),
      attrs: { role: 'status' },
      children: [el('span', { className: 'ui-chip__label', text: `${label}:` }), valueNode],
    });
  }

  /** Runs after the renderer has produced fresh stats (registered with priority 100). */
  update(dt, engine) {
    const snapshot = this.monitor.update(dt, engine.stats);
    if (!snapshot) return;

    this.fpsValue.textContent = faDigits(Math.round(snapshot.fps));
    this.drawValue.textContent = formatFa(snapshot.drawCalls);
    this.triValue.textContent = formatFa(Math.round(snapshot.triangles / 1000)) + ' هزار';
    const zoomPercent = this.rig ? Math.round(this.rig.zoomRatio * 100) : 0;
    this.zoomValue.textContent = `${formatFa(zoomPercent)}٪`;
  }

  dispose() {
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this.root.remove();
  }
}
