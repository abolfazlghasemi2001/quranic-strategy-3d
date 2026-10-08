/**
 * BarracksPanel — پنل آموزش سپاه (فقط DOM).
 *
 * اینجا هیچ عددی سخت‌کد نمی‌شود: هزینه، زمان، جان، آسیب، برد و سرعت همه از
 * units.json خوانده می‌شود و ظرفیت/صف از battle.json. پنل وقتی پادگانی در شهر
 * نباشد راهنمای ساخت نشان می‌دهد.
 */
import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';
import { formatCountdown } from './HUD.js';

const ROLE_KEYS = { melee: 'melee', ranged: 'ranged', support: 'support', siege: 'siege' };
const REASON_KEYS = {
  'no-barracks': 'army.noBarracksShort',
  'queue-full': 'army.queueFull',
  'capacity-full': 'army.capacityFull',
  cost: 'army.notEnough',
  'unknown-unit': 'army.unknownUnit',
};

export class BarracksPanel {
  constructor({ config, bus, barracks, economy, unitsData, onOpenShop }) {
    this.config = config;
    this.bus = bus;
    this.barracks = barracks;
    this.economy = economy;
    this.unitsData = unitsData;
    this.onOpenShop = onOpenShop;
    this.visible = false;
    this.t = (key, fallback) => config.t(key, fallback);
    this._rows = [];
    this._acc = 0;

    this.capacityBar = el('i');
    this.capacityText = el('b', { text: '۰/۰' });
    this.unitList = el('div', { className: 'barracks-units' });
    this.queueList = el('div', { className: 'barracks-queue' });
    this.hint = el('small', { className: 'barracks-hint' });

    this.root = el('div', {
      className: 'ui-root barracks-ui is-hidden',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [
        el('section', {
          className: 'battle-card barracks-card',
          children: [
            el('header', {
              children: [
                el('b', { text: this.t('army.panel', 'پادگان') }),
                button('×', { className: 'ui-icon-btn', onClick: () => this.hide() }),
              ],
            }),
            el('div', {
              className: 'barracks-capacity',
              children: [
                el('small', { text: this.t('army.capacity', 'ظرفیت سپاه') }),
                el('div', { className: 'barracks-capacity-bar', children: [this.capacityBar] }),
                this.capacityText,
              ],
            }),
            this.unitList,
            el('div', { className: 'barracks-queue-head', children: [el('b', { text: this.t('army.queue', 'صف آموزش') })] }),
            this.queueList,
            this.hint,
            el('small', { className: 'battle-note', text: this.t('battle.peaceNote', '') }),
          ],
        }),
      ],
    });
    document.body.append(this.root);

    this._unsubscribers = [
      bus.on(EVENTS.ARMY_CHANGED, () => {
        if (this.visible) this.render();
      }),
      bus.on(EVENTS.ECONOMY_CHANGED, () => {
        if (this.visible) this.render();
      }),
    ];
  }

  /* ------------------------------------------------------------------ render */

  render() {
    const t = this.t;
    const readiness = this.barracks.readiness();
    const hasBarracks = this.barracks.hasBarracks();
    this.capacityText.textContent = `${faDigits(readiness.used)}/${faDigits(readiness.capacity)}`;
    const pct = readiness.capacity > 0 ? Math.min(100, (readiness.used / readiness.capacity) * 100) : 0;
    this.capacityBar.style.setProperty('--progress', `${pct}%`);
    this.capacityBar.classList.toggle('is-full', readiness.capacity > 0 && readiness.used >= readiness.capacity);
    this.hint.textContent = hasBarracks
      ? (readiness.free > 0
        ? `${t('army.slots', 'خط آموزش')}: ${faDigits(readiness.freeSlots)}/${faDigits(readiness.slots)} · ${t('army.housing', 'جای سپاه')} ${faDigits(readiness.free)}`
        : t('army.capacityFull', 'ظرفیت سپاه پر است'))
      : t('army.needBarracks', 'برای آموزش نیرو، نخست پادگان بسازید.');

    this.unitList.replaceChildren();
    for (const def of this.unitsData.units) {
      const count = this.barracks.countOf(def.id);
      const job = this.barracks.jobFor(def.id);
      const allowed = this.barracks.canTrain(def.id);
      const cost = Object.entries(def.cost || {})
        .filter(([, value]) => value)
        .map(([key, value]) => `${t(`economy.${key}`, key)} ${formatFa(value)}`)
        .join(' · ');
      const trainBtn = button(`${t('army.train', 'آموزش')} (${cost})`, {
        className: 'ui-btn ui-btn--primary',
        onClick: () => {
          const result = this.barracks.startTraining(def.id);
          if (!result.ok) this.bus.emit(EVENTS.UI_TOAST, this._reasonText(result.reason));
          this.render();
        },
      });
      trainBtn.disabled = !allowed.ok;
      if (!allowed.ok) trainBtn.title = this._reasonText(allowed.reason);

      const card = el('div', {
        className: `barracks-unit${count > 0 ? ' is-owned' : ''}`,
        attrs: { dataset: { unit: def.id } },
        children: [
          el('div', {
            className: 'barracks-unit__head',
            children: [
              el('span', { className: 'barracks-unit__icon', text: def.icon }),
              el('div', {
                children: [
                  el('b', { text: def.name }),
                  el('small', { text: `${t(`army.${ROLE_KEYS[def.role] || 'melee'}`, def.role)} · ${def.description || ''}` }),
                ],
              }),
              el('span', { className: 'barracks-unit__count', text: `${faDigits(count)}/${faDigits(this.barracks.maxPerType())}` }),
            ],
          }),
          el('div', {
            className: 'barracks-unit__stats',
            children: [
              el('span', { text: `${t('army.hp', 'جان')} ${faDigits(def.hp)}` }),
              el('span', { text: `${t('defense.damage', 'آسیب')} ${faDigits(def.damage)}` }),
              el('span', { text: `${t('defense.range', 'برد')} ${formatFa(def.rangeTiles, 1)}` }),
              el('span', { text: `${t('army.speed', 'سرعت')} ${formatFa(def.speedTilesPerSecond, 1)}` }),
              el('span', { text: `${t('army.time', 'زمان')} ${faDigits(def.trainSeconds)}${t('army.secondsShort', 'ث')}` }),
            ],
          }),
          el('div', {
            className: 'barracks-unit__actions',
            children: [
              trainBtn,
              job
                ? el('span', {
                  className: 'barracks-unit__job',
                  text: job.status === 'active'
                    ? `${t('army.training', 'در آموزش')} ${formatCountdown(job.endsAt - Date.now())}`
                    : t('army.queued', 'در صف'),
                })
                : null,
            ],
          }),
        ],
      });
      this.unitList.append(card);

      if (!hasBarracks) card.classList.add('is-locked');
    }

    this.renderQueue();
  }

  renderQueue() {
    const t = this.t;
    this.queueList.replaceChildren();
    this._rows = [];
    const jobs = [...this.barracks.activeJobs(), ...this.barracks.queuedJobs()];
    if (jobs.length === 0) {
      this.queueList.append(el('small', { className: 'barracks-empty', text: t('army.queueEmpty', 'صف آموزش خالی است.') }));
      return;
    }
    const now = Date.now();
    for (const job of jobs) {
      const def = this.barracks.defOf(job.unit);
      const timer = el('span', { className: 'queue-timer', text: job.status === 'active' ? formatCountdown(job.endsAt - now) : '' });
      const row = el('div', {
        className: `queue-row queue-row--${job.status}`,
        children: [
          el('span', { className: 'queue-icon', text: def ? def.icon : '▣' }),
          el('span', { className: 'queue-name', children: [el('b', { text: def ? def.name : job.unit })] }),
          job.status === 'active' ? timer : el('span', { className: 'queue-waiting', text: t('army.queued', 'در صف') }),
        ],
      });
      if (job.status === 'active') {
        const speedBtn = button(`◈ ${faDigits(this.barracks.speedupCost(job, now))}`, {
          className: 'ui-btn queue-speedup',
          title: t('economy.speedup', 'سرعت‌بخشی'),
          onClick: () => {
            const result = this.barracks.speedup(job.id, Date.now());
            if (!result.ok) this.bus.emit(EVENTS.UI_TOAST, t('army.noGoharShort', 'گوهر کافی نیست.'));
            this.render();
          },
        });
        row.append(speedBtn);
        this._rows.push({ job, timer, duration: job.durationMs });
      }
      const cancelBtn = button('✕', {
        className: 'ui-btn barracks-cancel',
        title: t('army.cancel', 'لغو (نیمی از هزینه بازمی‌گردد)'),
        onClick: () => {
          this.barracks.cancel(job.id);
          this.render();
        },
      });
      row.append(cancelBtn);
      this.queueList.append(row);
    }
    this._renderProgress();
  }

  _renderProgress() {
    for (const entry of this._rows) {
      const elapsed = entry.duration > 0 ? (entry.job.endsAt - Date.now()) / entry.duration : 0;
      const pct = Math.min(100, Math.max(0, (1 - elapsed) * 100));
      entry.row.style.setProperty('--progress', `${pct}%`);
    }
  }

  _reasonText(reason) {
    return this.t(REASON_KEYS[reason] || 'army.blocked', this.t('army.blocked', 'اکنون ممکن نیست.'));
  }

  /* -------------------------------------------------------------------- misc */

  show() {
    this.visible = true;
    this.root.classList.remove('is-hidden');
    this.render();
  }

  hide() {
    this.visible = false;
    this.root.classList.add('is-hidden');
  }

  toggle() {
    if (this.visible) this.hide();
    else this.show();
  }

  update(dt) {
    if (!this.visible) return;
    this._acc += dt;
    if (this._acc < 0.25) return;
    this._acc = 0;
    const now = Date.now();
    for (const entry of this._rows) entry.timer.textContent = formatCountdown(entry.job.endsAt - now);
    this._renderProgress();
  }

  dispose() {
    for (const off of this._unsubscribers) off();
    this.root.remove();
  }
}
