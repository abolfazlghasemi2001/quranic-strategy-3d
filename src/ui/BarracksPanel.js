/**
 * BarracksPanel — پنل آموزش سپاه (فقط DOM).
 *
 * اینجا هیچ عددی سخت‌کد نمی‌شود: هزینه، زمان، جان، آسیب، برد و سرعت همه از
 * units.json خوانده می‌شود و ظرفیت/صف از battle.json. پنل وقتی پادگانی در شهر
 * نباشد راهنمای ساخت نشان می‌دهد.
 */
import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';
import characterData from '../data/characters.json';
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
  constructor({ config, bus, barracks, economy, unitsData, onOpenShop, onOpenCharacters = null, onRetryCharacters = null }) {
    this.config = config;
    this.bus = bus;
    this.barracks = barracks;
    this.economy = economy;
    this.unitsData = unitsData;
    this.onOpenShop = onOpenShop;
    this.onOpenCharacters = onOpenCharacters;
    this.onRetryCharacters = onRetryCharacters;
    this.characterAssetStates = new Map();
    this.characterProfileById = new Map((characterData.profiles || []).map((profile) => [profile.id, profile]));
    this.characterModelIds = [...new Set((characterData.profiles || []).map((profile) => profile.modelId))];
    this.selectedProfileByUnit = new Map(Object.entries(characterData.unitBindings || {}));
    this.visible = false;
    this.t = (key, fallback) => config.t(key, fallback);
    this._rows = [];
    this._acc = 0;

    this.capacityBar = el('i');
    this.capacityText = el('b', { text: '۰/۰' });
    this.unitList = el('div', { className: 'barracks-units' });
    this.queueList = el('div', { className: 'barracks-queue' });
    this.hint = el('small', { className: 'barracks-hint' });
    this.characterStatus = el('small', { className: 'barracks-character-status', text: this.t('army.charactersIdle', 'مدل‌های کاراکتر هنگام بازشدن پادگان آماده می‌شوند.') });
    this.retryCharactersButton = button(this.t('army.retryCharacters', 'تلاش دوباره'), {
      className: 'ui-btn',
      onClick: () => this._requestCharacterLoad(true),
    });
    this.retryCharactersButton.hidden = true;
    this.characterStatusRow = el('div', {
      className: 'barracks-character-status-row',
      children: [this.characterStatus, this.retryCharactersButton],
    });

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
            this.characterStatusRow,
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
      bus.on(EVENTS.CHARACTER_ASSET_STATUS, (status) => {
        if (!status?.modelId) return;
        this.characterAssetStates.set(status.modelId, status.status);
        this._renderCharacterStatus();
        if (this.visible) this.render();
      }),
    ];
  }

  _requestCharacterLoad(retry = false) {
    const loader = retry ? this.onRetryCharacters : this.onOpenCharacters;
    if (typeof loader !== 'function') return;
    try {
      Promise.resolve(loader()).catch(() => {});
    } catch {
      // Asset loading is optional; the battle's instanced fallback remains available.
    }
  }

  _renderCharacterStatus() {
    const statuses = this.characterModelIds.map((modelId) => this.characterAssetStates.get(modelId) || 'idle');
    const loading = statuses.filter((status) => status === 'loading').length;
    const ready = statuses.filter((status) => status === 'ready').length;
    const failed = statuses.filter((status) => status === 'fallback').length;
    if (loading > 0) {
      this.characterStatus.textContent = this.t('army.charactersLoading', 'مدل‌های سه‌بعدی در حال آماده‌سازی‌اند؛ بازی در همین حال قابل استفاده است.');
    } else if (failed > 0) {
      this.characterStatus.textContent = this.t('army.charactersFallback', 'برای برخی کاراکترها نمای جایگزین فعال است.');
    } else if (ready === statuses.length && ready > 0) {
      this.characterStatus.textContent = this.t('army.charactersReady', 'مدل‌های سه‌بعدی کاراکترها آماده‌اند.');
    } else {
      this.characterStatus.textContent = this.t('army.charactersIdle', 'مدل‌های کاراکتر هنگام بازشدن پادگان آماده می‌شوند.');
    }
    this.retryCharactersButton.hidden = failed === 0;
  }

  _createCharacterSelector(unitId, unitName) {
    const selector = el('select', {
      className: 'barracks-character-select',
      attrs: {
        'aria-label': `${this.t('army.characterChoice', 'ظاهر کاراکتر')} ${unitName}`,
        dataset: { unit: unitId },
      },
    });
    for (const profile of characterData.selection.map((id) => this.characterProfileById.get(id)).filter(Boolean)) {
      const option = el('option', { text: profile.name, attrs: { value: profile.id } });
      selector.append(option);
    }
    selector.value = this.selectedProfileByUnit.get(unitId) || characterData.unitBindings?.[unitId] || '';
    selector.addEventListener('change', () => {
      const profile = this.characterProfileById.get(selector.value);
      if (!profile) return;
      this.selectedProfileByUnit.set(unitId, profile.id);
      this.bus.emit(EVENTS.CHARACTER_PROFILE_SELECTED, { unitId, profileId: profile.id });
      this.render();
    });
    return el('label', {
      className: 'barracks-character-choice',
      children: [el('span', { text: this.t('army.characterChoice', 'ظاهر کاراکتر') }), selector],
    });
  }

  _appearanceText(unitId) {
    const profileId = this.selectedProfileByUnit.get(unitId) || characterData.unitBindings?.[unitId];
    const profile = this.characterProfileById.get(profileId);
    if (!profile) return '';
    const status = this.characterAssetStates.get(profile.modelId) || 'idle';
    const stateText = status === 'ready'
      ? this.t('army.characterReady', 'مدل آماده')
      : status === 'fallback'
        ? this.t('army.characterFallback', 'نمای جایگزین')
        : status === 'loading'
          ? this.t('army.characterLoading', 'در حال بارگذاری')
          : this.t('army.characterPending', 'مدل سه‌بعدی');
    return `${this.t('army.characterRole', 'کاراکتر')}: ${profile.name} · ${stateText}`;
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
      const characterSelector = this._createCharacterSelector(def.id, def.name);
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
          el('small', { className: 'barracks-unit__appearance', text: this._appearanceText(def.id) }),
          characterSelector,
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
    this._requestCharacterLoad(false);
    this._renderCharacterStatus();
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
