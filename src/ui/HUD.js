import buildingData from '../data/buildings.json';
import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

/** mm:ss (Persian digits) countdown, or h:mm:ss past an hour. */
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? faDigits(`${h}:${pad(m)}:${pad(s)}`) : faDigits(`${pad(m)}:${pad(s)}`);
}

function resourceChip(icon, label) {
  return el('div', {
    className: 'game-resource',
    children: [el('span', { text: icon }), el('b', { text: '۰' }), el('small', { text: label })],
  });
}

export class HUD {
  /**
   * @param {object} options
   * @param {import('../game/BuildingSystem.js').BuildingSystem} options.buildings
   * @param {import('../game/EconomySystem.js').EconomySystem} options.economy
   * @param {import('../game/BuildQueue.js').BuildQueue} options.queue
   */
  constructor({ config, engine, bus, monitor, rig, buildings, economy, queue, onOpenQuran }) {
    Object.assign(this, { config, engine, bus, monitor, rig, buildings, economy, queue });
    const t = (key, fallback) => config.t(key, fallback);

    this.levelValue = el('b', { text: '۱' });
    this.builderValue = el('b', { text: '۰/۰' });
    this.chips = {};
    for (const [key, meta] of Object.entries(economy.data.resources)) {
      this.chips[key] = resourceChip(meta.icon, meta.name);
    }

    this.player = el('div', {
      className: 'game-player',
      children: [el('span', { className: 'game-avatar', text: 'ن' }), el('div', { children: [el('small', { text: 'سطح شهر' }), this.levelValue] })],
    });
    this.buildersView = el('div', {
      className: 'game-builders',
      children: [el('span', { text: '⚒' }), el('div', { children: [el('small', { text: t('economy.builders', 'بنّاها') }), this.builderValue] })],
    });
    this.resourcesView = el('div', { className: 'game-resources', children: Object.values(this.chips) });

    /* ---------------------------------------------------------- shop */
    this.shopList = el('div', { className: 'shop-list' });
    for (const def of buildingData.buildings) {
      const cost = economy.costOf(def.id, 1) || {};
      const costText = Object.entries(cost)
        .filter(([, v]) => v)
        .map(([k, v]) => `${t(`economy.${k}`, k)} ${formatFa(v)}`)
        .join(' · ');
      const seconds = economy.secondsOf(def.id, 1);
      const timeText = seconds ? ` — ⏱ ${formatFa(seconds)} ${t('economy.seconds', 'ثانیه')}` : '';
      const item = el('button', {
        className: 'shop-item',
        attrs: { type: 'button' },
        children: [
          el('span', { className: 'shop-item__icon', text: def.icon }),
          el('span', {
            className: 'shop-item__body',
            children: [
              el('b', { text: def.name }),
              el('small', { text: `${formatFa(def.size[0])}×${formatFa(def.size[1])} — ${costText}${timeText}` }),
              el('em', { text: def.description }),
            ],
          }),
        ],
      });
      item.addEventListener('click', () => {
        if (buildings.startPlacement(def.id)) this.toggleShop(false);
      });
      this.shopList.append(item);
    }
    this.shop = el('section', {
      className: 'game-shop is-hidden',
      children: [
        el('header', { children: [el('h2', { text: 'فروشگاه ساختمان' }), button('×', { className: 'ui-icon-btn', onClick: () => this.toggleShop(false) })] }),
        this.shopList,
      ],
    });
    this.shopButton = button('ساخت‌وساز', { className: 'game-corner-btn game-shop-btn', onClick: () => this.toggleShop() });
    this.shopButton.prepend(el('span', { text: '🏛' }));
    this.questButton = button('مأموریت‌ها', {
      className: 'game-corner-btn game-quest-btn',
      onClick: () => this.toast('مأموریت‌ها در فاز بعد فعال می‌شوند.'),
    });
    this.questButton.prepend(el('span', { text: '☼' }));

    /* --------------------------------------------------- queue panel */
    this.queueList = el('div', { className: 'queue-list' });
    this.queueBadge = el('span', { className: 'queue-badge', text: '۰' });
    this.queuePanel = el('div', {
      className: 'game-queue is-hidden',
      children: [
        el('header', {
          children: [el('b', { text: t('economy.queue', 'صف ساخت') }), this.queueBadge],
        }),
        this.queueList,
      ],
    });

    /* ---------------------------------------------------- placement */
    this.confirmButton = button('تأیید ساخت', { className: 'ui-btn ui-btn--primary', onClick: () => buildings.confirmPlacement() });
    this.placementBar = el('div', {
      className: 'placement-bar is-hidden',
      children: [
        el('span', { className: 'placement-title', text: '' }),
        this.confirmButton,
        button('لغو', { className: 'ui-btn', onClick: () => buildings.cancelPlacement() }),
      ],
    });

    /* -------------------------------------------------- selection menu */
    this.selection = el('div', { className: 'building-menu is-hidden' });
    this._selectionEntity = null;
    this._selectionTimerNode = null;
    this._selectionSpeedupBtn = null;
    this._selectionHarvestBtn = null;
    this._selectionSpeedupJobId = null;

    this.toastNode = el('div', { className: 'game-toast' });
    this.pauseBadge = el('div', { className: 'ui-pause', text: 'متوقف' });
    this.root = el('div', {
      className: 'ui-root game-hud',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [
        el('div', { className: 'ui-vignette' }),
        this.player,
        this.buildersView,
        this.resourcesView,
        this.shopButton,
        this.questButton,
        this.queuePanel,
        this.shop,
        this.placementBar,
        this.selection,
        this.toastNode,
        this.pauseBadge,
        button('راهنمای متن', { className: 'quran-policy-btn', onClick: () => onOpenQuran?.() }),
      ],
    });
    document.body.append(this.root);

    this._unsubscribers = [
      bus.on(EVENTS.GAME_PAUSED, ({ paused }) => this.pauseBadge.classList.toggle('is-visible', paused)),
      bus.on(EVENTS.ECONOMY_CHANGED, (v) => this.renderEconomy(v)),
      bus.on(EVENTS.BUILD_QUEUE_CHANGED, (v) => this.renderQueue(v)),
      bus.on(EVENTS.JOB_FINISHED, () => {
        if (this._selectionEntity) this.renderSelection({ entity: this._selectionEntity, def: this.buildings.byId.get(this._selectionEntity.type) });
      }),
      bus.on(EVENTS.PLACEMENT_CHANGED, (v) => this.renderPlacement(v)),
      bus.on(EVENTS.BUILDING_SELECTED, (v) => this.renderSelection(v)),
      bus.on(EVENTS.UI_TOAST, (v) => this.toast(typeof v === 'string' ? v : v?.message || '')),
    ];
  }

  toggleShop(force) {
    this.shop.classList.toggle('is-hidden', force === undefined ? !this.shop.classList.contains('is-hidden') : !force);
  }

  /* ------------------------------------------------------------ economy */

  renderEconomy({ resources, capacity, cityLevel, builders }) {
    this.levelValue.textContent = formatFa(cityLevel ?? 1);
    this.builderValue.textContent = `${formatFa(builders.free)}/${formatFa(builders.total)}`;
    for (const [key, chip] of Object.entries(this.chips)) {
      const value = Math.floor(resources[key] || 0);
      const node = chip.querySelector('b');
      if (capacity && capacity[key] != null) {
        node.textContent = `${formatFa(value)}/${formatFa(capacity[key])}`;
        chip.classList.toggle('is-full', value >= capacity[key]);
      } else {
        node.textContent = formatFa(value);
        chip.classList.toggle('is-full', false);
      }
    }
  }

  /* -------------------------------------------------------------- queue */

  renderQueue({ jobs, free, total }) {
    this.queueBadge.textContent = `${formatFa(free)}/${formatFa(total)}`;
    this.queuePanel.classList.toggle('is-hidden', !jobs || jobs.length === 0);
    this.queueList.replaceChildren();
    if (!jobs || jobs.length === 0) return;

    const now = Date.now();
    this._queueRows = [];
    for (const job of jobs) {
      const def = buildingData.buildings.find((b) => b.id === job.type);
      const name = def ? def.name : job.type;
      const levelText = job.targetLevel > 1 ? ` ← سطح ${formatFa(job.targetLevel)}` : '';
      const timer = el('span', { className: 'queue-timer', text: job.status === 'active' ? formatCountdown(job.endsAt - now) : '' });
      const row = el('div', {
        className: `queue-row queue-row--${job.status}`,
        children: [
          el('span', { className: 'queue-icon', text: def?.icon || '▣' }),
          el('span', { className: 'queue-name', children: [el('b', { text: name }), el('small', { text: levelText.trim() || name })] }),
          job.status === 'active'
            ? timer
            : el('span', { className: 'queue-waiting', text: this.config.t('economy.queued', 'در انتظار بنّا') }),
        ],
      });
      if (job.status === 'active') {
        const remaining = Math.max(0, job.endsAt - now);
        const cost = this.economy.speedupCost(job, now);
        const speedBtn = button(`◈ ${formatFa(cost)}`, {
          className: 'ui-btn queue-speedup',
          title: this.config.t('economy.speedup', 'سرعت‌بخشی'),
          onClick: () => this.buildings.speedup(job.id),
        });
        row.append(speedBtn);
        this._queueRows.push({ job, timer, remaining, duration: job.durationMs, row });
      }
      this.queueList.append(row);
    }
    this._renderQueueProgress();
  }

  _renderQueueProgress() {
    if (!this._queueRows) return;
    for (const entry of this._queueRows) {
      const pct = entry.duration > 0 ? Math.min(100, Math.max(0, ((entry.duration - (entry.job.endsAt - Date.now())) / entry.duration) * 100)) : 100;
      entry.row.style.setProperty('--progress', `${pct}%`);
    }
  }

  /* ----------------------------------------------------------- placement */

  renderPlacement(v) {
    this.placementBar.classList.toggle('is-hidden', !v.active);
    this.shopButton.classList.toggle('is-hidden', v.active);
    if (v.active) {
      this.placementBar.querySelector('.placement-title').textContent = `جانمایی ${v.def.name}`;
      this.confirmButton.disabled = !v.valid;
    }
  }

  /* ---------------------------------------------------------- selection */

  renderSelection(v) {
    this.selection.replaceChildren();
    this._selectionEntity = v ? v.entity : null;
    this._selectionTimerNode = null;
    this._selectionSpeedupBtn = null;
    this._selectionHarvestBtn = null;
    this._selectionSpeedupJobId = null;
    this.selection.classList.toggle('is-hidden', !v);
    if (!v) return;

    const { entity, def } = v;
    const now = Date.now();
    this.selection.append(el('b', { text: def.name }));

    const produces = def.produces;
    const rate = this.economy.rateOf(entity);
    const job = this.queue.jobFor(entity.id);

    if (entity.status === 'building') {
      this.selection.append(el('small', { text: this.config.t('economy.building', 'در حال ساخت…') }));
    } else {
      this.selection.append(el('small', { text: `سطح ${formatFa(entity.level)} · ${def.description}` }));
    }

    if (produces && entity.status === 'ready') {
      const meta = this.economy.data.resources[produces];
      const pending = Math.floor(entity.pending);
      this.selection.append(
        el('div', {
          className: 'building-stats',
          children: [
            el('span', { text: `${this.config.t('economy.ratePerHour', 'در ساعت')}: ${formatFa(rate)}` }),
            el('span', { text: `${meta.name} انباشته: ${formatFa(pending)}` }),
          ],
        }),
      );
      if (pending >= 1) {
        const harvestBtn = button(`${this.config.t('economy.harvest', 'برداشت')} +${formatFa(Math.min(pending, Math.floor(this.economy.freeCapacity(produces))))}`, {
          className: 'ui-btn ui-btn--primary',
          onClick: () => {
            this.buildings.harvestSelected();
            this.renderSelection({ entity, def });
          },
        });
        this._selectionHarvestBtn = harvestBtn;
        this.selection.append(el('div', { children: [harvestBtn] }));
      }
    }

    // live job timer + speedup / waiting state
    if (job && job.status === 'active') {
      const timer = el('span', { className: 'building-timer', text: formatCountdown(job.endsAt - now) });
      const cost = this.economy.speedupCost(job, now);
      const speedBtn = button(`◈ ${formatFa(cost)}`, {
        className: 'ui-btn queue-speedup',
        onClick: () => this.buildings.speedup(job.id),
      });
      this._selectionTimerNode = timer;
      this._selectionSpeedupBtn = speedBtn;
      this._selectionSpeedupJobId = job.id;
      this.selection.append(el('div', { className: 'building-progress', children: [timer, speedBtn] }));
    } else if (job && job.status === 'queued') {
      this.selection.append(el('small', { text: this.config.t('economy.queued', 'در انتظار بنّا') }));
    } else if (entity.status === 'ready' && job == null) {
      // upgrade affordance
      const nextLevel = entity.level + 1;
      if (nextLevel > this.economy.maxLevel) {
        this.selection.append(el('small', { text: this.config.t('economy.maxLevel', 'حداکثر سطح') }));
      } else {
        const cost = this.economy.costOf(entity.type, nextLevel) || {};
        const seconds = this.economy.secondsOf(entity.type, nextLevel);
        const costText = Object.entries(cost)
          .filter(([, val]) => val)
          .map(([k, val]) => `${this.config.t(`economy.${k}`, k)} ${formatFa(val)}`)
          .join(' · ');
        const afford = this.economy.canAfford(cost);
        const upgradeBtn = button(`ارتقا ← سطح ${formatFa(nextLevel)} (${costText} · ⏱${formatFa(seconds)}ث)`, {
          className: 'ui-btn ui-btn--primary',
          onClick: () => {
            this.buildings.upgradeSelected();
            this.renderSelection({ entity, def });
          },
        });
        upgradeBtn.disabled = !afford;
        this.selection.append(el('div', { children: [upgradeBtn] }));
      }
    }
  }

  /* -------------------------------------------------------------- toast */

  toast(text) {
    if (!text) return;
    this.toastNode.textContent = text;
    this.toastNode.classList.add('is-visible');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.toastNode.classList.remove('is-visible'), 2400);
  }

  /** Welcome-back summary: «در غیبت شما…». */
  showOfflineReport(report) {
    if (!report) return;
    const { secondsAway, jobsDone, goharDaily, gained } = report;
    const interesting = secondsAway >= 60 || jobsDone > 0 || goharDaily > 0;
    if (!interesting) return;
    const parts = [];
    if (secondsAway >= 60) {
      const minutes = Math.floor(secondsAway / 60);
      const time = minutes >= 60 ? `${formatFa(Math.floor(minutes / 60))} ساعت و ${formatFa(minutes % 60)} دقیقه` : `${formatFa(minutes)} دقیقه`;
      parts.push(`${time} گذشته`);
    }
    const gainedText = Object.entries(gained || {})
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${this.config.t(`economy.${k}`, k)} ${formatFa(v)}`)
      .join('، ');
    if (gainedText) parts.push(`${gainedText} تولید شد`);
    if (jobsDone > 0) parts.push(`${formatFa(jobsDone)} ساختمان کامل شد`);
    if (goharDaily > 0) parts.push(`+${formatFa(goharDaily)} گوهر`);
    this.toast(`${this.config.t('economy.offline', 'در غیبت شما')}: ${parts.join('، ')}`);
  }

  /* --------------------------------------------------------------- loop */

  update(dt, engine) {
    this.monitor.update(dt, engine.stats);
    // live countdowns (~4 Hz, cheap string updates only)
    this._countdownAcc = (this._countdownAcc || 0) + dt;
    if (this._countdownAcc < 0.25) return;
    this._countdownAcc = 0;
    const now = Date.now();
    if (this._queueRows) {
      for (const entry of this._queueRows) entry.timer.textContent = formatCountdown(entry.job.endsAt - now);
      this._renderQueueProgress();
    }
    if (this._selectionTimerNode && this._selectionSpeedupJobId) {
      const job = this.queue.jobs.find((j) => j.id === this._selectionSpeedupJobId);
      if (job && job.status === 'active') {
        this._selectionTimerNode.textContent = formatCountdown(job.endsAt - now);
        if (this._selectionSpeedupBtn) {
          this._selectionSpeedupBtn.replaceChildren();
          this._selectionSpeedupBtn.append(el('span', { className: 'ui-btn__label', text: `◈ ${formatFa(this.economy.speedupCost(job, now))}` }));
        }
      }
    }
  }

  dispose() {
    clearTimeout(this.toastTimer);
    for (const fn of this._unsubscribers) fn();
    this.root.remove();
  }
}
