/**
 * HUD — the in-game shell (status bar on top, action dock at the bottom).
 *
 * Layout contract (phase 10 redesign):
 *   .hud-topbar   status ONLY: player/level chip · resource chips · settings gear
 *   .hud-dock     thumb-reachable actions (≥48 px), Construction first (RTL inline-start)
 *   .hud-bottom   bottom stack: build queue → selection menu → placement bar → dock
 * Every region carries `data-hud-region` so the layout tests can measure it, and
 * every interactive node carries `data-hud-action` so FTUE/smoke/dev tooling can
 * target it by role instead of by pixel position.
 *
 * No game logic lives here: the HUD only renders state it is handed through the
 * event bus and calls back into the systems it was given.
 */
import buildingData from '../data/buildings.json';
import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

/**
 * Self-authored SVG icon set; user input is never interpolated into markup. The HUD uses
 * a small, consistent glyph vocabulary instead of image icons or emoji soup.
 * The big emoji are kept as secondary marks only where they were already used
 * in the world markers (see Markers.js) — never as the primary affordance.
 */
const svg = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
const ICON = {
  level: svg('m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z'),
  build: svg('m4 20 10-10M10 4l2-2 10 10-2 2-4-4-4 4-4-4 4-4Z'),
  settings: svg('M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-5v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4'),
  study: svg('M3 5c4-1 6 0 9 2 3-2 5-3 9-2v14c-4-1-6 0-9 2-3-2-5-3-9-2Zm9 2v14'),
  missions: svg('M12 3v2m0 14v2M3 12h2m14 0h2m-9-3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M5.5 5.5 7 7m10 10 1.5 1.5M5.5 18.5 7 17M17 7l1.5-1.5'),
  community: svg('m12 3 9 9-9 9-9-9Zm0 5 4 4-4 4-4-4Z'),
  report: svg('M4 5h16M4 12h16M4 19h16'),
};

/**
 * Font-safety net for data-driven icons. Every entry is a glyph covered by the
 * UI font stack (Vazirmatn / IRANSans / Noto Sans Arabic / DejaVu), so a chip
 * can never degrade into a .notdef box on a device without an emoji font.
 */
const ICON_OVERRIDES = {
  '💎': '⬢', // gohar
  '🏛': '⚒',
  '🛡': '⛨',
  '🪙': '◉',
};
const safeIcon = (icon) => ICON_OVERRIDES[icon] || icon;

/** Small count bubble that can sit on any dock action or status chip. */
function badge(className, text = '۰') {
  return el('span', { className: `hud-badge${className ? ` ${className}` : ''}`, text, attrs: { 'aria-hidden': 'true' } });
}

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
    children: [el('span', { text: safeIcon(icon) }), el('b', { text: '۰' }), el('small', { text: label })],
  });
}

export class HUD {
  /**
   * @param {object} options
   * @param {import('../game/BuildingSystem.js').BuildingSystem} options.buildings
   * @param {import('../game/EconomySystem.js').EconomySystem} options.economy
   * @param {import('../game/BuildQueue.js').BuildQueue} options.queue
   */
  constructor({ config, engine, bus, monitor, rig, buildings, economy, queue, game = null, learning = null, onOpenQuran, onOpenStudy, onOpenBattle, onOpenBarracks, onOpenMissions, onOpenSettings, onOpenMeta, onOpenSocial }) {
    Object.assign(this, { config, engine, bus, monitor, rig, buildings, economy, queue, game, learning });
    this.onOpenStudy = onOpenStudy;
    this.onOpenSettings = onOpenSettings;
    this.onOpenMeta = onOpenMeta;
    this.onOpenMissions = onOpenMissions;
    this.onOpenBattle = onOpenBattle;
    this.onOpenBarracks = onOpenBarracks;
    this.onOpenSocial = onOpenSocial;
    const t = (key, fallback) => config.t(key, fallback);

    this.levelValue = el('b', { text: '۱' });
    this.builderValue = el('b', { text: '۰/۰' });
    this.buildersBadge = badge('hud-builders-badge', '۰/۰');
    this.chips = {};
    for (const [key, meta] of Object.entries(economy.data.resources)) {
      this.chips[key] = resourceChip(meta.icon, meta.name);
    }

    this.playerLevelValue = el('b', { text: '۱' });
    // Mirrors `levelValue`: the profile chip collapses to the avatar at ≤400 px
    // and the city level must stay readable (see hud.css).
    this.avatarLevel = el('span', { className: 'hud-badge game-avatar__badge', text: '۱', attrs: { 'aria-hidden': 'true' } });
    this.playerXpText = el('small', { className: 'game-player__xp-text', text: '۰ XP' });
    this.playerXpFill = el('i');
    this.playerXpBar = el('div', { className: 'game-player__xp-bar', children: [this.playerXpFill] });
    this.player = el('button', {
      className: 'game-player',
      dataset: { hudAction: 'meta' },
      attrs: { type: 'button', 'aria-label': 'بازکردن کارنامهٔ بازیکن', title: 'کارنامه، XP، دستاوردها و مأموریت اختیاری' },
      children: [
        el('span', {
          className: 'game-avatar',
          children: [el('span', { text: 'ن' }), this.avatarLevel],
        }),
        el('div', { className: 'game-player__info', children: [
          el('span', { className: 'game-player__cell', children: [el('small', { text: 'سطح شهر' }), el('span', { className: 'game-player__stat', children: [el('i', { className: 'game-player__icon', html: ICON.level, attrs: { 'aria-hidden': 'true' } }), this.levelValue] })] }),
          el('span', { className: 'game-player__cell game-player__cell--player', children: [el('small', { className: 'game-player__meta-label', text: 'سطح بازیکن' }), this.playerLevelValue] }),
          this.playerXpText, this.playerXpBar,
        ] }),
      ],
    });
    this.player.addEventListener('click', () => this.onOpenMeta?.());
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
        attrs: { type: 'button', dataset: { def: def.id } },
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
      item.querySelector('.shop-item__icon').textContent = safeIcon(def.icon);
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
    this.shopButton = button('ساخت‌وساز', {
      className: 'game-corner-btn game-shop-btn hud-action hud-action--primary',
      dataset: { hudAction: 'build' },
      onClick: () => {
        if (this.buildings.placing) return; // جانمایی فعال است؛ ابتدا تأیید یا لغو
        this.toggleShop();
      },
    });
    this.shopButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.build }));
    this.shopButton.classList.add('hud-action--has-badge');
    this.shopButton.append(this.buildersBadge);
    this.settingsButton = button('تنظیمات', {
      className: 'game-corner-btn game-settings-btn hud-action hud-action--compact',
      dataset: { hudAction: 'settings' },
      onClick: () => this.onOpenSettings?.(),
    });
    this.settingsButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.settings }));
    // Phase 6: دروازهٔ کمپین قصص (نشان = شمار ستاره‌ها و مأموریت باز).
    this.questBadge = el('span', { className: 'hud-badge game-corner-badge game-corner-badge--quest', text: '★۰' });
    this.questButton = button(t('campaign.button', 'قصه‌ها'), {
      className: 'game-corner-btn game-quest-btn hud-action',
      dataset: { hudAction: 'missions' },
      title: t('campaign.panelTitle', 'کمپین قصص'),
      onClick: () => this.onOpenMissions?.(),
    });
    this.questButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.missions }));
    this.questButton.append(this.questBadge);

    // Phase 4: دارالقرآن gateway + spaced-repetition badge (due count).
    this.studyBadge = badge('game-corner-badge is-hidden', '۰');
    this.studyButton = button('دارالقرآن', {
      className: 'game-corner-btn game-study-btn hud-action',
      dataset: { hudAction: 'study' },
      title: 'درس و مرور فاصله‌دار',
      onClick: () => onOpenStudy?.(),
    });
    this.studyButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.study }));
    this.studyButton.append(this.studyBadge);

    // Phase 5: پادگان (آموزش سپاه) و میدان نبرد — از پنل کارنامه/نبرد باز می‌شوند.
    this.armyBadge = badge('game-corner-badge game-corner-badge--army', '۰');
    this.armyButton = button(t('army.panel', 'پادگان'), {
      className: 'game-corner-btn game-army-btn hud-action hud-action--secondary',
      dataset: { hudAction: 'barracks' },
      title: t('army.garrisonTitle', 'سپاه آماده'),
      onClick: () => this.onOpenBarracks?.(),
    });
    this.armyButton.prepend(el('span', { className: 'hud-action__icon', text: safeIcon('🛡') }));
    this.armyButton.append(this.armyBadge);

    this.battleBadge = badge('game-corner-badge game-corner-badge--battle is-hidden', '۰');
    this.battleButton = button(t('battle.button', 'نبرد'), {
      className: 'game-corner-btn game-battle-btn hud-action hud-action--secondary',
      dataset: { hudAction: 'battle' },
      title: t('battle.title', 'میدان نبرد'),
      onClick: () => this.onOpenBattle?.(),
    });
    this.battleButton.prepend(el('span', { className: 'hud-action__icon', text: '⚔' }));
    this.battleButton.append(this.battleBadge);

    // Phase 8: جماعت — chat, mutual help and the weekly cooperative event.
    this.socialBadge = badge('game-corner-badge game-corner-badge--social is-hidden', '۰');
    this.socialButton = button(t('social.button', 'جماعت'), {
      className: 'game-corner-btn game-social-btn hud-action',
      dataset: { hudAction: 'community' },
      title: t('social.title', '◈ جماعت'),
      onClick: () => this.onOpenSocial?.(),
    });
    this.socialButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.community }));
    this.socialButton.append(this.socialBadge);

    // کارنامه: second entry point (the level chip above stays the primary one).
    this.reportButton = button('کارنامه', {
      className: 'game-corner-btn game-report-btn hud-action',
      dataset: { hudAction: 'report' },
      title: 'کارنامه، XP، دستاوردها و مأموریت روزانه',
      onClick: () => this.onOpenMeta?.(),
    });
    this.reportButton.prepend(el('span', { className: 'hud-action__icon', html: ICON.report }));

    // «راهنمای متن» moved out of the map: it is now a control inside the
    // report/settings flow so it can never float unlabelled over the terrain.
    this.policyButton = button(t('hud.quranButton', 'راهنمای متن'), {
      className: 'ui-btn quran-policy-btn',
      dataset: { hudAction: 'quran' },
      title: t('quran.title', 'سیاست نمایش متن قرآن'),
      onClick: () => onOpenQuran?.(),
    });

    /* --------------------------------------------------- queue panel */
    this.queueList = el('div', { className: 'queue-list' });
    this.queueBadge = el('span', { className: 'queue-badge', text: '۰' });
    this.queuePanel = el('div', {
      className: 'game-queue is-hidden',
      attrs: { dataset: { hudRegion: 'queue' } },
      children: [
        el('header', {
          children: [el('b', { text: t('economy.queue', 'صف ساخت') }), this.queueBadge],
        }),
        this.queueList,
      ],
    });

    /* ---------------------------------------------------- placement */
    this.confirmButton = button('تأیید ساخت', { className: 'ui-btn ui-btn--primary', dataset: { hudAction: 'confirm' }, onClick: () => buildings.confirmPlacement() });
    this.placementBar = el('div', {
      className: 'placement-bar is-hidden',
      attrs: { dataset: { hudRegion: 'placement' } },
      children: [
        el('span', { className: 'placement-title', text: '' }),
        this.confirmButton,
        button('لغو', { className: 'ui-btn', dataset: { hudAction: 'cancel' }, onClick: () => buildings.cancelPlacement() }),
      ],
    });

    /* -------------------------------------------------- selection menu */
    this.selection = el('div', { className: 'building-menu is-hidden', attrs: { dataset: { hudRegion: 'selection' } } });
    this._selectionEntity = null;
    this._selectionTimerNode = null;
    this._selectionSpeedupBtn = null;
    this._selectionHarvestBtn = null;
    this._selectionSpeedupJobId = null;

    // نوار کوچک پیگیری مأموریت فعال (فاز ۶): عنوان، هدف اصلی و دکمهٔ پنل.
    this.missionChipTitle = el('b', { text: '' });
    this.missionChipGoal = el('small', { text: '' });
    this.missionChipTimer = el('span', { className: 'game-mission-chip__timer', text: '' });
    this.missionChip = el('div', {
      className: 'game-mission-chip is-hidden',
      children: [
        el('span', { className: 'game-mission-chip__icon', text: '☼' }),
        el('div', { className: 'game-mission-chip__body', children: [this.missionChipTitle, this.missionChipGoal] }),
        this.missionChipTimer,
        button(t('campaign.open', 'پنل'), { className: 'ui-btn game-mission-chip__btn', onClick: () => this.onOpenMissions?.() }),
      ],
    });

    this.toastNode = el('div', { className: 'game-toast' });
    this.pauseBadge = el('div', { className: 'ui-pause', text: 'متوقف' });

    /* ------------------------------------------------------- HUD shell */
    // Status only, one row, safe-area aware. Grows downward, never overlaps
    // the bottom stack (both live in normal flow inside `.game-hud`).
    this.topBar = el('header', {
      className: 'hud-topbar',
      attrs: { dataset: { hudRegion: 'top' }, 'aria-label': 'نوار وضعیت شهر' },
      children: [this.player, this.resourcesView, this.settingsButton],
    });

    // Thumb-zone actions. DOM order = RTL visual order: Construction sits at
    // the inline-start (right) edge, exactly where the thumb rests.
    this.dockActions = el('nav', {
      className: 'hud-dock',
      attrs: { dataset: { hudRegion: 'dock' }, 'aria-label': 'کنش‌های اصلی' },
      children: [
        this.shopButton,
        this.studyButton,
        this.questButton,
        this.socialButton,
        this.reportButton,
      ],
    });

    // Panels that belong above the dock (mission → queue → selection →
    // placement) share one flow column, so they can never overlap each other
    // or the dock — at any width or font scale.
    this.panels = el('div', {
      className: 'hud-panels',
      attrs: { dataset: { hudRegion: 'panels' } },
      children: [this.missionChip, this.queuePanel, this.selection, this.placementBar],
    });
    this.bottom = el('div', {
      className: 'hud-bottom',
      attrs: { dataset: { hudRegion: 'bottom' } },
      children: [this.panels, this.dockActions],
    });

    this.root = el('div', {
      className: 'ui-root game-hud',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [
        el('div', { className: 'ui-vignette' }),
        this.topBar,
        this.bottom,
        el('div', { className: 'hud-toaster', attrs: { dataset: { hudRegion: 'toast' } }, children: [this.toastNode] }),
        this.shop,
        this.pauseBadge,
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
      bus.on(EVENTS.QURAN_REVIEW_DUE, (v) => this.renderStudyBadge(v)),
      bus.on(EVENTS.QURAN_LESSON_REQUESTED, () => this.toggleShop(false)),
      bus.on(EVENTS.ARMY_CHANGED, (readiness) => this.renderArmyBadge(readiness)),
      bus.on(EVENTS.CAMPAIGN_CHANGED, (snapshot) => this.renderCampaign(snapshot)),
      bus.on(EVENTS.MISSION_PROGRESS, (active) => this.renderMissionProgress(active)),
      bus.on(EVENTS.META_CHANGED, (snapshot) => this.renderMeta(snapshot)),
      bus.on(EVENTS.META_XP_AWARDED, ({ amount } = {}) => this.toast(`تجربهٔ بازیکن +${formatFa(amount || 0)} XP`)),
      bus.on(EVENTS.META_LEVEL_UP, ({ level } = {}) => this.toast(`سطح بازیکن به ${formatFa(level || 1)} رسید.`)),
      bus.on(EVENTS.META_ACHIEVEMENT_UNLOCKED, ({ achievement } = {}) => this.toast(`دستاورد «${achievement?.title || ''}» ثبت شد.`)),
      bus.on(EVENTS.DAILY_MISSION_COMPLETED, () => this.toast('مأموریت اختیاری انجام شد؛ XP ثبت شد.')),
      bus.on(EVENTS.BATTLE_STARTED, () => this.setBattleLive(true)),
      bus.on(EVENTS.BATTLE_SESSION_CLOSED, () => this.setBattleLive(false)),
      bus.on(EVENTS.BATTLE_PROGRESS, (status) => this.renderBattleBadge(status)),
      bus.on(EVENTS.SOCIAL_STATUS, () => this.renderSocial()),
      bus.on(EVENTS.SOCIAL_CHAT, () => this.renderSocial()),
      bus.on(EVENTS.SOCIAL_HELP, () => this.renderSocial()),
      bus.on(EVENTS.STRUCTURE_DAMAGED, ({ entityId }) => {
        if (this._selectionEntity && this._selectionEntity.id === entityId) {
          this.renderSelection({ entity: this._selectionEntity, def: this.buildings.byId.get(this._selectionEntity.type) });
        }
      }),
      bus.on(EVENTS.STRUCTURE_REPAIRED, ({ entityId }) => {
        if (this._selectionEntity && this._selectionEntity.id === entityId) {
          this.renderSelection({ entity: this._selectionEntity, def: this.buildings.byId.get(this._selectionEntity.type) });
        }
      }),
    ];
    if (this.game?.meta) this.renderMeta(this.game.meta.snapshot());
    this.renderSocial();
  }

  toggleShop(force) {
    const wasHidden = this.shop.classList.contains('is-hidden');
    const show = force === undefined ? wasHidden : Boolean(force);
    this.shop.classList.toggle('is-hidden', !show);
    if (show && wasHidden) this.bus.emit(EVENTS.SHOP_OPENED, {});
  }

  /* ------------------------------------------------------------ economy */

  renderEconomy({ resources, capacity, cityLevel, builders }) {
    const level = formatFa(cityLevel ?? 1);
    this.levelValue.textContent = level;
    this.avatarLevel.textContent = level;
    this._renderBuilders(builders);
    for (const [key, chip] of Object.entries(this.chips)) {
      const value = Math.floor(resources[key] || 0);
      const node = chip.querySelector('b');
      const cap = capacity && capacity[key] != null ? capacity[key] : null;
      // value and «/capacity» are separate spans: the caption is dropped by CSS
      // on very narrow screens instead of letting the number clip mid-digits
      // (b.textContent still reads «۶۰۰/۸۰۰» for tests and screen readers).
      const parts = [el('span', { className: 'game-resource__value', text: formatFa(value) })];
      if (cap != null) parts.push(el('span', { className: 'game-resource__cap', text: `/${formatFa(cap)}` }));
      node.replaceChildren(...parts); // replaceChildren() stringifies null → filter first
      chip.classList.toggle('is-full', cap != null && value >= cap);
      chip.title = cap == null
        ? `${this.config.t(`economy.${key}`, key)}: ${formatFa(value)}`
        : `${this.config.t(`economy.${key}`, key)}: ${formatFa(value)} / ${formatFa(cap)}`;
    }
  }

  /**
   * Builders count lives on the Construction action (badge) — it used to be a
   * separate card that overlapped the button strip. All three views (dock
   * badge, panel badge, `builderValue` used by tests) are updated together.
   */
  _renderBuilders({ free = 0, total = 0 } = {}) {
    const text = `${formatFa(free)}/${formatFa(total)}`;
    this.builderValue.textContent = text;
    this.buildersBadge.textContent = text;
    this.queueBadge.textContent = text;
    const busy = total > 0 && free < total;
    this.shopButton.classList.toggle('is-busy', busy);
    this.shopButton.setAttribute(
      'aria-label',
      `${this.config.t('economy.builders', 'بنّاها')}: ${text}`,
    );
  }

  /* -------------------------------------------------------------- queue */

  renderQueue({ jobs, free, total }) {
    this._renderBuilders({ free, total });
    this.queuePanel.classList.toggle('is-hidden', !jobs || jobs.length === 0);
    this.queueList.replaceChildren();
    if (!jobs || jobs.length === 0) return;

    const now = Date.now();
    this._queueRows = [];
    for (const job of jobs) {
      const def = buildingData.buildings.find((b) => b.id === job.type);
      const isMission = job.kind === 'mission';
      const name = isMission ? (job.label || this.config.t('campaign.job', 'کار مأموریت')) : def ? def.name : job.type;
      const levelText = job.targetLevel > 1 ? ` ← سطح ${formatFa(job.targetLevel)}` : '';
      const timer = el('span', { className: 'queue-timer', text: job.status === 'active' ? formatCountdown(job.endsAt - now) : '' });
      const row = el('div', {
        className: `queue-row queue-row--${job.status}`,
        children: [
          el('span', { className: 'queue-icon', text: isMission ? (job.icon || '☼') : def?.icon || '▣' }),
          el('span', {
            className: 'queue-name',
            children: [
              el('b', { text: name }),
              el('small', { text: isMission ? this.config.t('campaign.jobHint', 'کار کمپین قصص') : levelText.trim() || name }),
            ],
          }),
          job.hold
            ? el('span', { className: 'queue-waiting', text: this.config.t('social.pending', 'در انتظار تأیید سرور…') })
            : job.status === 'active'
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
    // The Construction action stays in the dock (hiding it shifted every other
    // action); while placing it is inert instead, and the placement bar — which
    // sits directly above the dock — carries تأیید/لغو.
    this.shopButton.classList.toggle('is-inactive', v.active);
    this.shopButton.disabled = Boolean(v.active);
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

    // Phase 5: پادگان آموزش نیرو را از همین منو باز می‌کند.
    if (def.trainUnits) {
      this.selection.append(el('div', {
        children: [button(this.config.t('army.panel', 'پادگان'), { className: 'ui-btn ui-btn--primary', onClick: () => this.onOpenBarracks?.() })],
      }));
    }

    // Phase 5: جان سازه و تعمیر (هزینه از defenses.json).
    if (this.game?.structureStats && entity.status === 'ready') {
      const maxHp = entity.maxHp ?? this.game.structureStats.maxHpFor(entity);
      const hp = entity.hp == null ? maxHp : entity.hp;
      const ratio = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;
      const barWrap = el('div', { className: `building-health__bar${ratio < 1 ? ' is-damaged' : ''}`, children: [el('i')] });
      barWrap.style.setProperty('--progress', `${Math.round(ratio * 100)}%`);
      this.selection.append(el('div', {
        className: 'building-health',
        children: [
          barWrap,
          el('small', { text: `${this.config.t('defense.hp', 'جان')} ${formatFa(Math.round(hp))}/${formatFa(Math.round(maxHp))}` }),
        ],
      }));
      if (ratio < 1) {
        const cost = this.game.structureStats.repairCost(entity);
        const costText = Object.entries(cost || {})
          .filter(([, value]) => value)
          .map(([key, value]) => `${this.config.t(`economy.${key}`, key)} ${formatFa(value)}`)
          .join(' · ');
        const repairBtn = button(`${this.config.t('defense.repair', 'تعمیر')} (${costText})`, {
          className: 'ui-btn',
          onClick: () => {
            const result = this.game.repairEntity(entity);
            if (result.ok) this.toast(this.config.t('defense.repaired', 'سازه تعمیر شد.'));
            else if (result.reason === 'resources') this.toast(this.config.t('defense.needResources', 'منابع کافی نیست.'));
            this.renderSelection({ entity, def });
          },
        });
        repairBtn.disabled = !this.economy.canAfford(cost || {});
        this.selection.append(el('div', { children: [repairBtn] }));
      }
    }

    // Phase 4: دارالقرآن opens the lesson hub straight from its menu.
    if (def.lesson) {
      this.selection.append(el('div', {
        children: [button('۞ درس و مرور', { className: 'ui-btn ui-btn--primary', onClick: () => this.onOpenStudy?.() })],
      }));
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
      this.selection.append(el('small', {
        text: job.hold
          ? this.config.t('social.pending', 'در انتظار تأیید سرور…')
          : this.config.t('economy.queued', 'در انتظار بنّا'),
      }));
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

  /** شمار سپاه آماده روی دکمهٔ پادگان. */
  renderArmyBadge(readiness) {
    if (!readiness) return;
    this.armyBadge.textContent = formatFa(readiness.total);
    this.armyButton.classList.toggle('is-alert', readiness.total > 0);
    this.armyButton.title = `${this.config.t('army.garrisonTitle', 'سپاه آماده')}: ${formatFa(readiness.total)} · ${this.config.t('army.capacity', 'ظرفیت سپاه')} ${formatFa(readiness.used)}/${formatFa(readiness.capacity)}`;
  }

  /** نبرد جاری: نشان روی دکمهٔ نبرد و شمار مهاجمان زنده. */
  setBattleLive(live) {
    this.battleLive = live;
    this.battleBadge.classList.toggle('is-hidden', !live);
    this.battleButton.classList.toggle('is-alert', live);
    if (!live) this.battleBadge.textContent = '·';
  }

  /** جماعت badge: unread chat + open help requests while online. */
  renderSocial() {
    const social = this.game?.social;
    if (!social) return;
    const online = social.isOnline();
    this.socialButton.classList.toggle('is-alert', online);
    const count = online ? (social.unread || 0) + social.openHelpForMe().length : 0;
    this.socialBadge.textContent = formatFa(count);
    this.socialBadge.classList.toggle('is-hidden', count === 0);
    this.socialButton.title = online
      ? `${this.config.t('social.title', '◈ جماعت')} — ${formatFa(social.members.length)} عضو`
      : this.config.t('social.title', '◈ جماعت');
  }

  renderBattleBadge(status) {
    if (!status) return;
    this.battleBadge.classList.remove('is-hidden');
    this.battleBadge.textContent = status.done
      ? this.config.t(`battle.${status.result}`, status.result)
      : formatFa(status.raidersAlive);
  }

  /* ------------------------------------------------------------ campaign */

  /** نشان ستاره و مأموریت باز روی دکمهٔ «قصه‌ها». */
  renderCampaign(snapshot) {
    if (!snapshot) return;
    const totalStars = snapshot.totalStars || 0;
    const maxStars = snapshot.missions.length * (snapshot.starsMax || 3);
    this.questBadge.textContent = `★${formatFa(totalStars)}`;
    const available = snapshot.missions.filter((mission) => mission.status === 'available').length;
    const active = snapshot.active;
    this.questButton.classList.toggle('is-alert', available > 0 || !!active);
    this.questButton.title = active
      ? `${this.config.t('campaign.active', 'مأموریت فعال')}: ${active.title}`
      : `${this.config.t('campaign.panelTitle', 'کمپین قصص')} — ★${formatFa(totalStars)}/${formatFa(maxStars)}${available ? ` · ${formatFa(available)} مأموریت باز` : ''}`;
    this.questBadge.classList.toggle('is-hidden', !snapshot.missions.length);
    if (active) this.renderMissionProgress(active);
    else this.missionChip.classList.add('is-hidden');
  }

  /** نوار پیگیری مأموریت فعال: هدف اصلی، وضعیت و زمان. */
  renderMissionProgress(active) {
    if (!active) {
      this.missionChip.classList.add('is-hidden');
      return;
    }
    const goal = (active.objectives || []).find((objective) => objective.type === 'primary') || (active.objectives || [])[0];
    this.missionChip.classList.remove('is-hidden');
    this.missionChip.classList.toggle('is-paused', !!active.paused);
    this.missionChipTitle.textContent = active.title;
    this.missionChipGoal.textContent = goal ? goal.label : (active.headline || '');
    this.missionChipTimer.textContent = active.paused
      ? this.config.t('campaign.pausedShort', 'متوقف')
      : `${'★'.repeat(active.starsPreview || 0)}${active.headline ? ` · ${active.headline}` : ''}`;
  }

  /** نشان سررسید مرور فاصله‌دار روی دکمهٔ دارالقرآن. */
  renderStudyBadge({ dueCount = 0, learned = 0 } = {}) {
    this.studyBadge.textContent = formatFa(dueCount);
    this.studyBadge.classList.toggle('is-hidden', !dueCount);
    this.studyButton.classList.toggle('is-alert', dueCount > 0);
    this.studyButton.title = dueCount > 0
      ? `${formatFa(dueCount)} مورد در نوبت مرور · آموخته‌شده: ${formatFa(learned)}`
      : 'درس و مرور فاصله‌دار';
  }

  /** سطح، XP و نوار پیشرفت بازیکن در نشان کارنامه. */
  renderMeta(snapshot) {
    if (!snapshot) return;
    this.playerLevelValue.textContent = formatFa(snapshot.level || 1);
    const xpLine = snapshot.nextXp == null
      ? `${formatFa(snapshot.xp)} XP · بیشینه`
      : `${formatFa(snapshot.xp)} / ${formatFa(snapshot.nextXp)} XP`;
    this.playerXpText.textContent = xpLine;
    this.playerXpFill.style.setProperty('--progress', `${Math.round((snapshot.progress || 0) * 100)}%`);
    this.player.setAttribute('aria-label', `کارنامهٔ بازیکن، سطح ${formatFa(snapshot.level || 1)}، ${formatFa(snapshot.xp)} XP`);
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
    const { secondsAway, jobsDone, gained } = report;
    const interesting = secondsAway >= 60 || jobsDone > 0 || Object.values(gained || {}).some((value) => value > 0);
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
    this.toast(`${this.config.t('economy.offline', 'در غیبت شما')}: ${parts.join('، ')}`);
  }

  /* --------------------------------------------------------------- loop */

  update(dt, engine) {
    this.monitor.update(engine.frameDelta ?? dt, engine.stats);
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
