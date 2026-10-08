/**
 * MissionPanel — رابط کاربری کمپین «قصص» (فاز ۶). فقط DOM؛ هیچ منطقی این‌جا نیست.
 *
 * چهار صفحه در یک ریشه:
 *   ۱) فهرست قصه‌ها (map): وضعیت قفل/باز/تکمیل، ستاره‌ها و زنجیرهٔ باز شدن
 *   ۲) معرفی مأموریت (brief): روایت کوتاه با ارجاع آیات، هدف‌های سه‌ستاره، پاداش
 *   ۳) مأموریت زنده (live): فصل/موج، هدف‌ها، کنش‌ها و نشانگرهای نقشه
 *   ۴) نتیجه (result): ستاره‌ها، «درس‌آموخته» و ارجاع‌ها
 *
 * متن آیه: هرگز در این فایل نوشته نمی‌شود. کارت‌های ارجاع (`verseRefs.js`) متن را
 * فقط در صورت وجود در دیتاست قرآنی و با `verseCard` (فونت قرآنی) نمایش می‌دهند.
 */
import { el, button, faDigits, formatFa } from '../dom.js';
import { EVENTS } from '../../core/EventBus.js';
import { verseRefList, narrativeLine } from './verseRefs.js';
import { toFaDigits } from '../../game/quran/QuranDataset.js';

const STAR_ROW = (stars, max = 3) => `${'★'.repeat(Math.max(0, stars))}${'☆'.repeat(Math.max(0, max - stars))}`;

export class MissionPanel {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../../core/EventBus.js').EventBus} options.bus
   * @param {import('../../game/campaign/CampaignSystem.js').CampaignSystem} options.campaign
   * @param {import('../../game/EconomySystem.js').EconomySystem} options.economy
   * @param {object|null} options.dataset — دیتاست قرآنی نرمال‌شده (فقط برای ارجاع)
   * @param {() => void} [options.onOpenLesson] — پیوند به دارالقرآن
   */
  constructor({ config, bus, campaign, economy, dataset = null, parent = document.body, onOpenLesson = null }) {
    this.config = config;
    this.bus = bus;
    this.campaign = campaign;
    this.economy = economy;
    this.dataset = dataset;
    this.onOpenLesson = onOpenLesson;
    this.t = (key, fallback) => config.t(`campaign.${key}`, fallback);

    this.mode = 'map';
    this.open = false;
    this.currentMissionId = null;
    this._report = null;
    this._abortArmed = false;
    this._livePending = false;
    this._liveTimer = 0;

    this.card = el('div', { className: 'ui-modal__card mission-card' });
    this.root = el('div', {
      className: 'ui-modal mission-panel is-hidden',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': this.t('panelTitle', 'کمپین قصص') },
      children: [el('div', { className: 'ui-modal__backdrop' }), this.card],
    });
    this.root.querySelector('.ui-modal__backdrop').addEventListener('click', () => this.close());
    this._onKey = (event) => {
      if (event.key === 'Escape') this.close();
    };

    this._unsubscribers = [
      bus.on(EVENTS.MISSION_PROGRESS, (payload) => {
        if (!this.open || this.mode !== 'live') return;
        this._progressPayload = payload;
        this._livePending = true;
      }),
      bus.on(EVENTS.MISSION_FINISHED, (report) => {
        this._report = report;
        if (this.open) this.renderResult(report);
      }),
      bus.on(EVENTS.MISSION_ABORTED, () => {
        if (this.open) this.renderMap();
      }),
      bus.on(EVENTS.CAMPAIGN_CHANGED, () => {
        if (!this.open) return;
        if (this.mode === 'map') this.renderMap();
      }),
      bus.on(EVENTS.MISSION_STARTED, () => {
        if (this.open) this.renderLive();
      }),
    ];
    parent.append(this.root);
  }

  /* ------------------------------------------------------------------- open */

  /** @param {{missionId?:string, mode?:string}} [options] */
  show({ missionId = null } = {}) {
    this.open = true;
    this.root.classList.remove('is-hidden');
    window.addEventListener('keydown', this._onKey);
    this.bus.emit(EVENTS.CAMPAIGN_PANEL_OPENED, {});
    const active = this.campaign.activeRun;
    if (missionId) {
      this.renderBrief(missionId);
      return;
    }
    if (active && !this._report) {
      this.currentMissionId = active.missionId;
      this.renderLive();
      return;
    }
    if (this._report) {
      this.renderResult(this._report);
      return;
    }
    this.renderMap();
  }

  hide() {
    this.open = false;
    this.root.classList.add('is-hidden');
    window.removeEventListener('keydown', this._onKey);
    this.bus.emit(EVENTS.CAMPAIGN_PANEL_CLOSED, {});
  }

  close() {
    this.hide();
  }

  /* ------------------------------------------------------------------- map */

  header(title, { back = false } = {}) {
    return el('header', {
      className: 'ui-modal__header',
      children: [
        el('h2', { className: 'ui-modal__title', text: title }),
        el('div', {
          className: 'mission-header-actions',
          children: [
            back ? button(this.t('back', 'بازگشت'), { className: 'ui-btn mission-back', onClick: () => this.renderMap() }) : null,
            this.onOpenLesson
              ? button('۞', { className: 'ui-icon-btn', title: this.t('lessonLink', 'دارالقرآن'), onClick: () => this.onOpenLesson() })
              : null,
            button('×', { className: 'ui-icon-btn', title: this.t('close', 'بستن'), onClick: () => this.close() }),
          ],
        }),
      ],
    });
  }

  renderMap() {
    this.mode = 'map';
    this._report = null;
    const list = this.campaign.list();
    const totals = this.campaign.progress.totals;
    const maxStars = this.campaign.maxStars;
    const totalStars = this.campaign.totalStars();

    this.card.replaceChildren(
      this.header(this.t('panelTitle', 'کمپین قصص — مأموریت‌های داستانی')),
      el('section', {
        className: 'mission-summary',
        children: [
          el('div', { className: 'mission-summary__stars', text: `${STAR_ROW(totalStars, list.length * maxStars)}` }),
          el('div', {
            className: 'mission-summary__meta',
            children: [
              el('span', { className: 'hub-chip', text: `ستاره: ${faDigits(totalStars)} از ${faDigits(list.length * maxStars)}` }),
              el('span', { className: 'hub-chip', text: `تکمیل‌شده: ${faDigits(totals.completed)}` }),
              el('span', { className: 'hub-chip', text: `تلاش‌ها: ${faDigits(totals.attempts)}` }),
            ],
          }),
          el('p', {
            className: 'ui-modal__hint',
            text: this.t('policyNote', 'قصه‌ها روایت پروژه‌اند (از زاویهٔ مردم و شهر) و هیچ تصویری از پیامبران، ائمه و فرشتگان ندارند. هر ارجاع آیه، متن خود را فقط از دیتاست قرآنی می‌گیرد.'),
          }),
        ],
      }),
      el('div', {
        className: 'mission-list',
        children: list.map((mission) => this.missionRow(mission)),
      }),
    );
  }

  missionRow(mission) {
    const locked = mission.status === 'locked';
    const stars = mission.bestStars || 0;
    const actionButton = mission.isActive
      ? button(this.t('continue', 'ادامه'), { className: 'ui-btn ui-btn--primary', onClick: () => this.renderLive() })
      : locked
        ? button(this.t('locked', 'قفل'), { className: 'ui-btn', attrs: { disabled: true } })
        : button(mission.completions > 0 ? this.t('replay', 'بازپخش') : this.t('start', 'شروع'), {
          className: 'ui-btn ui-btn--primary',
          onClick: () => this.renderBrief(mission.id),
        });

    return el('article', {
      className: `mission-row${locked ? ' is-locked' : ''}${mission.status === 'completed' ? ' is-done' : ''}${mission.isActive ? ' is-active' : ''}`,
      children: [
        el('span', { className: 'mission-row__icon', text: mission.icon }),
        el('div', {
          className: 'mission-row__body',
          children: [
            el('div', {
              className: 'mission-row__head',
              children: [
                el('b', { text: `${faDigits(mission.order)}. ${mission.title}` }),
                el('span', { className: `mission-stars mission-stars--${stars}`, text: STAR_ROW(stars) }),
              ],
            }),
            el('small', { className: 'mission-row__subtitle', text: mission.subtitle }),
            el('div', {
              className: 'mission-row__meta',
              children: [
                el('span', { text: `سورهٔ ${mission.qasas.surahName}` }),
                el('span', { text: `${faDigits(mission.refs.length)} ارجاع` }),
                el('span', { text: `تلاش: ${faDigits(mission.attempts)}` }),
                mission.completions > 0 ? el('span', { text: `تکمیل: ${faDigits(mission.completions)} بار` }) : null,
              ],
            }),
            locked
              ? el('small', { className: 'mission-row__locked', text: this.t('lockedHint', 'پس از تکمیل «{title}» باز می‌شود.').replace('{title}', mission.lockedBy || '') })
              : null,
          ],
        }),
        actionButton,
      ],
    });
  }

  /* ----------------------------------------------------------------- brief */

  renderBrief(missionId) {
    const mission = this.campaign.list().find((item) => item.id === missionId);
    if (!mission) {
      this.renderMap();
      return;
    }
    this.mode = 'brief';
    this.currentMissionId = missionId;
    this._report = null;
    const raw = this.campaign.mission(missionId);
    const tags = (this.config.campaign?.review?.label) || 'روایت پروژه — در انتظار بازبینی';

    this.card.replaceChildren(
      this.header(`${mission.icon} ${mission.title}`, { back: true }),
      el('section', {
        className: 'mission-brief',
        children: [
          el('div', {
            className: 'mission-brief__meta',
            children: [
              el('span', { className: 'hub-chip', text: `سورهٔ ${mission.qasas.surahName}` }),
              el('span', { className: 'hub-chip', text: mission.qasas.theme }),
              el('span', { className: 'verse-badge verse-badge--pending', text: tags }),
            ],
          }),
          el('p', { className: 'ui-modal__text', text: mission.subtitle }),
          el('div', {
            className: 'mission-narrative',
            children: mission.narrative.map((line) => narrativeLine({ mission: raw || mission, line })),
          }),
          verseRefList({ dataset: this.dataset, mission: raw || mission, campaignData: this.config.campaign }),
          el('section', {
            className: 'mission-goals',
            children: [
              el('h4', { className: 'mission-goals__title', text: this.t('goalsTitle', 'هدف‌های سه‌ستاره') }),
              el('div', {
                className: 'mission-goal-list',
                children: mission.objectives.map((objective) => el('div', {
                  className: 'mission-goal',
                  children: [
                    el('span', { className: 'mission-goal__star', text: '★' }),
                    el('div', {
                      children: [
                        el('b', { text: objective.label }),
                        objective.hint ? el('small', { text: objective.hint }) : null,
                      ],
                    }),
                  ],
                })),
              }),
            ],
          }),
          el('div', {
            className: 'mission-rewards',
            children: [
              el('small', { text: this.t('rewardTitle', 'پاداش نخستین تکمیل') }),
              mission.reward.nur > 0 ? el('span', { className: 'battle-reward', text: `نور +${faDigits(mission.reward.nur)}` }) : null,
              mission.reward.hekmat > 0 ? el('span', { className: 'battle-reward', text: `حکمت +${faDigits(mission.reward.hekmat)}` }) : null,
              mission.reward.gohar > 0 ? el('span', { className: 'battle-reward', text: `گوهر +${faDigits(mission.reward.gohar)}` }) : null,
              mission.reward.speedupSeconds > 0 ? el('span', { className: 'battle-reward', text: `تسریع ساخت ${faDigits(mission.reward.speedupSeconds)} ثانیه` }) : null,
            ],
          }),
          el('p', { className: 'ui-modal__hint', text: mission.hint }),
          el('div', {
            className: 'mission-brief__actions',
            children: [
              button(this.t('startMission', 'شروع مأموریت'), {
                className: 'ui-btn ui-btn--primary mission-start',
                onClick: () => this.startMission(missionId),
              }),
              button(this.t('back', 'بازگشت'), { className: 'ui-btn', onClick: () => this.renderMap() }),
            ],
          }),
          el('small', {
            className: 'mission-note',
            text: this.t('noCombatNote', 'این کمپین هیچ نبردی نمی‌خواهد: چالش‌ها مدیریت منابع، سازه و نگهداری‌اند و «حریف» طبیعت است.'),
          }),
        ],
      }),
    );
  }

  startMission(missionId) {
    const result = this.campaign.start(missionId);
    if (result.ok) {
      this.currentMissionId = missionId;
      this.renderLive();
      this.bus.emit(EVENTS.UI_TOAST, {
        message: this.t('startedToast', 'مأموریت آغاز شد؛ نشانگرها را روی نقشه دنبال کنید.'),
        type: 'success',
      });
      return result;
    }
    const reasons = {
      busy: this.t('blocked.busy', 'یک مأموریت دیگر در جریان است.'),
      locked: this.t('blocked.locked', 'این مأموریت هنوز باز نشده است.'),
      battle: this.t('blocked.battle', 'نبرد در جریان است؛ نخست آن را تمام کنید.'),
      missing: this.t('blocked.missing', 'این مأموریت پیدا نشد.'),
    };
    this.bus.emit(EVENTS.UI_TOAST, { message: reasons[result.reason] || this.t('blocked.generic', 'شروع مأموریت ممکن نیست.'), type: 'info' });
    return result;
  }

  /* ------------------------------------------------------------------ live */

  liveView() {
    const snapshot = this.campaign.snapshot();
    const active = snapshot.active;
    if (!active) return null;
    const rows = active.rows || [];
    const actions = active.actions || [];
    const plots = actions.filter((action) => action.plotIndex != null || action.plotId != null);
    const globals = actions.filter((action) => action.plotIndex == null && action.plotId == null);

    const actionButton = (action) => {
      const label = `${action.icon ? `${action.icon} ` : ''}${action.label}${action.cost && Object.keys(action.cost).length ? ` (${Object.entries(action.cost).map(([key, value]) => `${this.config.t(`economy.${key}`, key)} ${faDigits(value)}`).join(' · ')})` : ''}${action.seconds ? ` · ⏱${faDigits(Math.round(action.seconds))}` : ''}`;
      const btn = button(label, {
        className: 'ui-btn mission-action',
        onClick: () => {
          const result = this.campaign.perform(action.id, { plotId: action.plotId, plotIndex: action.plotIndex });
          if (result.ok) this.renderLive();
        },
      });
      btn.disabled = !action.enabled;
      if (!action.enabled && action.reason === 'cooldown' && action.cooldownRemaining) {
        btn.append(el('small', { text: ` (${faDigits(action.cooldownRemaining)} ث)` }));
      }
      return btn;
    };

    return el('div', {
      className: 'mission-live',
      children: [
        el('div', {
          className: `mission-live__head${active.paused ? ' is-paused' : ''}`,
          children: [
            el('span', { className: 'mission-live__icon', text: active.icon }),
            el('div', {
              className: 'mission-live__titles',
              children: [
                el('b', { text: active.title }),
                el('small', { text: active.headline }),
              ],
            }),
            el('span', { className: 'mission-live__stars', text: `${STAR_ROW(active.starsPreview || 0)} ${faDigits(active.starsPreview || 0)}/${faDigits(this.campaign.maxStars)}` }),
          ],
        }),
        active.paused
          ? el('p', { className: 'mission-live__paused', text: this.t('pausedNote', 'مأموریت موقتاً متوقف است؛ زمان و منابع پیش نمی‌رود.') })
          : null,
        el('div', {
          className: 'mission-rows',
          children: rows.map((row) => el('div', {
            className: 'mission-row-stat',
            children: [
              el('small', { text: row.label }),
              el('b', { text: `${faDigits(Math.round(row.value))}${row.unit ? ` ${row.unit}` : ''}${row.target != null ? ` / ${faDigits(Math.round(row.target))}` : ''}` }),
            ],
          })),
        }),
        el('div', {
          className: 'mission-live__goals',
          children: active.objectives.map((objective) => el('div', {
            className: `mission-live__goal${objective.done ? ' is-done' : ''}`,
            children: [
              el('span', { text: objective.done ? '★' : '☆' }),
              el('span', { text: objective.label }),
            ],
          })),
        }),
        globals.length
          ? el('div', { className: 'mission-actions', children: globals.map(actionButton) })
          : null,
        plots.length
          ? el('section', {
            className: 'mission-plots',
            children: [
              el('h4', { className: 'mission-plots__title', text: this.t('plotsTitle', 'نشانگرهای نقشه (تپ روی نشانگر یا این دکمه‌ها)') }),
              el('div', { className: 'mission-plot-list', children: plots.map((action) => el('div', { className: 'mission-plot' }, [actionButton(action)])) }),
            ],
          })
          : null,
        el('div', {
          className: 'mission-live__controls',
          children: [
            active.paused
              ? button(this.t('resume', 'ادامه'), { className: 'ui-btn ui-btn--primary', onClick: () => { this.campaign.resume(); this.renderLive(); } })
              : button(this.t('pause', 'توقف'), { className: 'ui-btn', onClick: () => { this.campaign.pause(); this.renderLive(); } }),
            button(this._abortArmed ? this.t('abortConfirm', 'تأیید رهاکردن') : this.t('abort', 'رهاکردن مأموریت'), {
              className: `ui-btn mission-abort${this._abortArmed ? ' is-armed' : ''}`,
              onClick: () => {
                if (!this._abortArmed) {
                  this._abortArmed = true;
                  this.renderLive();
                  this.bus.emit(EVENTS.UI_TOAST, { message: this.t('abortHint', 'بدون جریمه؛ برای تأیید دوباره بزنید.'), type: 'info' });
                  return;
                }
                this._abortArmed = false;
                this.campaign.abort(Date.now(), 'user');
                this.renderMap();
              },
            }),
            button(this.t('mapButton', 'فهرست قصه‌ها'), { className: 'ui-btn', onClick: () => this.renderMap() }),
          ],
        }),
        el('small', { className: 'mission-note', text: this.t('liveNote', 'پنل را ببندید و به شهر برگردید؛ مأموریت با نشانگرهای زنده ادامه می‌یابد.') }),
      ],
    });
  }

  renderLive() {
    this.mode = 'live';
    this._report = null;
    const view = this.liveView();
    if (!view) {
      this.renderMap();
      return;
    }
    const active = this.campaign.snapshot().active;
    this.card.replaceChildren(this.header(`${active.icon} ${active.title}`, { back: true }), view);
  }

  /* ---------------------------------------------------------------- result */

  renderResult(report) {
    if (!report) {
      this.renderMap();
      return;
    }
    this.mode = 'result';
    this._report = report;
    const max = this.campaign.maxStars;
    const mission = this.campaign.list().find((item) => item.id === report.missionId);
    const raw = this.campaign.mission(report.missionId);
    const next = this.campaign.list().find((item) => item.status === 'available' && !item.isActive && item.order > (mission?.order || 0));
    const granted = report.granted || {};

    this.card.replaceChildren(
      this.header(`${mission ? mission.icon : '☼'} ${report.title}`, { back: true }),
      el('section', {
        className: `mission-result${report.failed ? ' is-failed' : ''}`,
        children: [
          el('div', { className: 'mission-result__stars', text: `${'★'.repeat(report.stars)}${'☆'.repeat(Math.max(0, max - report.stars))}` }),
          el('b', {
            className: 'mission-result__title',
            text: report.failed
              ? this.t('failedTitle', 'این بار شهر تاب نیاورد — بی‌جریمه دوباره تلاش کنید')
              : report.firstClear
                ? this.t('clearTitle', 'مأموریت نخستین بار به پایان رسید')
                : this.t('reclearTitle', 'مأموریت دوباره به پایان رسید'),
          }),
          el('div', {
            className: 'mission-live__goals',
            children: report.objectives.map((objective) => el('div', {
              className: `mission-live__goal${objective.done ? ' is-done' : ''}`,
              children: [el('span', { text: objective.done ? '★' : '☆' }), el('span', { text: objective.label })],
            })),
          }),
          el('section', {
            className: 'mission-lesson',
            children: [
              el('h4', { text: this.t('lessonTitle', 'درس‌آموختهٔ این قصه') }),
              el('p', { className: 'mission-lesson__head', text: report.lessonLearned }),
              el('ul', {
                children: (report.lessonPoints || []).map((point) => el('li', { text: point })),
              }),
            ],
          }),
          el('div', {
            className: 'mission-rewards',
            children: [
              el('small', { text: this.t('grantedTitle', 'پاداش این اجرا') }),
              granted.nur > 0 ? el('span', { className: 'battle-reward', text: `نور +${faDigits(Math.round(granted.nur))}` }) : null,
              granted.hekmat > 0 ? el('span', { className: 'battle-reward', text: `حکمت +${faDigits(Math.round(granted.hekmat))}` }) : null,
              granted.gohar > 0 ? el('span', { className: 'battle-reward', text: `گوهر +${faDigits(granted.gohar)}` }) : null,
              granted.speedup?.appliedSeconds > 0 ? el('span', { className: 'battle-reward', text: `تسریع ساخت ${faDigits(granted.speedup.appliedSeconds)} ثانیه` }) : null,
              !granted.nur && !granted.hekmat && !granted.gohar ? el('span', { className: 'mission-rewards__none', text: this.t('noReward', 'پاداشی برای این اجرا ثبت نشد (تکرار مأموریت پاداش را چند برابر نمی‌کند).') }) : null,
            ],
          }),
          el('small', {
            className: 'mission-result__stats',
            text: `زمان: ${formatFa(report.seconds)} ثانیه · بهترین ستاره: ${faDigits(report.bestStars)} از ${faDigits(max)}`,
          }),
          verseRefList({ dataset: this.dataset, mission: raw || mission, campaignData: this.config.campaign }),
          el('div', {
            className: 'mission-result__actions',
            children: [
              next
                ? button(this.t('nextMission', 'مأموریت بعدی'), {
                  className: 'ui-btn ui-btn--primary',
                  onClick: () => this.renderBrief(next.id),
                })
                : null,
              button(this.t('retry', 'تلاش دوباره'), { className: 'ui-btn', onClick: () => this.startMission(report.missionId) }),
              button(this.t('mapButton', 'فهرست قصه‌ها'), { className: 'ui-btn', onClick: () => this.renderMap() }),
            ],
          }),
        ],
      }),
    );
  }

  /* ------------------------------------------------------------------ loop */

  update(dt) {
    if (!this.open || this.mode !== 'live') return;
    this._liveTimer += dt;
    if (!this._livePending && this._liveTimer > 1.2) {
      // حتی بدون رویداد تازه (مثلاً تایمر بنّا) صفحه هر ~۱ ثانیه تازه می‌شود.
      this._livePending = true;
    }
    if (this._livePending && this._liveTimer > 0.4) {
      this._livePending = false;
      this._liveTimer = 0;
      if (this.campaign.activeRun) this.renderLive();
      else this.renderMap();
    }
  }

  dispose() {
    window.removeEventListener('keydown', this._onKey);
    for (const off of this._unsubscribers) off();
    this._unsubscribers.length = 0;
    this.root.remove();
  }
}

export { toFaDigits };
