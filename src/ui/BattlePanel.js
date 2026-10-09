/**
 * BattlePanel — رابط کاربری میدان نبرد (فقط DOM؛ هیچ منطق جنگی اینجا نیست).
 *
 * سه صفحه در یک ریشه:
 *   ۱) آماده‌سازی: انتخاب سناریو + خلاصهٔ آمادگی شهر + «آغاز نبرد»
 *   ۲) نبرد زنده: زمان، پیشرفت، آمار، نوار استقرار نیرو و کنترل‌ها
 *   ۳) نتیجه: گزارش کوتاه، پاداش‌ها، «بازپخش نبرد» و بستن
 *
 * همهٔ متن‌ها از strings.fa.json و همهٔ اعداد از JSON بازی می‌آید. هیچ متن
 * قرآنی — و هیچ متنی — روی صحنهٔ نبرد نمایش داده نمی‌شود؛ این پنل هم خارج از
 * صحنه و در لایهٔ رابط کاربری است و هیچ سند قرآنی را نمی‌خواند.
 */
import { el, button, formatFa, faDigits } from './dom.js';
import { EVENTS } from '../core/EventBus.js';

const THREAT_STARS = (threat) => `${'★'.repeat(Math.max(0, threat))}${'☆'.repeat(Math.max(0, 3 - threat))}`;
const ROLE_KEYS = { melee: 'melee', ranged: 'ranged', support: 'support', siege: 'siege' };

export class BattlePanel {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {import('../game/battle/BattleSystem.js').BattleSystem} options.battle
   * @param {import('../game/barracks/BarracksSystem.js').BarracksSystem} options.barracks
   * @param {object} options.unitsData
   * @param {import('../world/battle/BattleView.js').BattleView} [options.view]
   * @param {() => void} [options.onOpenBarracks]
   * @param {() => void} [options.onBattleStart]
   * @param {() => void} [options.onBattleExit]
   */
  constructor({ config, bus, battle, barracks, unitsData, view = null, onOpenBarracks, onBattleStart, onBattleExit }) {
    this.config = config;
    this.bus = bus;
    this.battle = battle;
    this.barracks = barracks;
    this.unitsData = unitsData;
    this.view = view;
    this.onOpenBarracks = onOpenBarracks;
    this.onBattleStart = onBattleStart;
    this.onBattleExit = onBattleExit;
    this.t = (key, fallback) => config.t(key, fallback);

    this.encounters = battle.encounters();
    this.selectedEncounter = this.encounters[0]?.id || null;
    this.deployType = null;
    this.visible = false;
    this.mode = 'setup';
    this.lastStatus = null;
    this._timerAcc = 0;

    /* ------------------------------------------------------------ setup view */
    this.encounterList = el('div', { className: 'battle-encounters' });
    this.readinessBox = el('div', { className: 'battle-readiness' });
    this.setupHint = el('small', { className: 'battle-hint', text: this.t('battle.field', '') });
    this.startButton = button(this.t('battle.start', 'آغاز نبرد'), {
      className: 'ui-btn ui-btn--primary battle-start',
      onClick: () => this.startBattle(),
    });
    this.setupBox = el('section', {
      className: 'battle-card battle-setup',
      children: [
        el('header', {
          children: [
            el('b', { text: this.t('battle.title', 'میدان نبرد') }),
            button('×', { className: 'ui-icon-btn', onClick: () => this.hide() }),
          ],
        }),
        this.encounterList,
        this.readinessBox,
        el('div', { className: 'battle-start-row', children: [this.startButton] }),
        this.setupHint,
        el('small', { className: 'battle-note', text: this.t('battle.peaceNote', '') }),
      ],
    });

    /* ------------------------------------------------------------- live view */
    this.liveName = el('b', { text: '' });
    this.liveTimer = el('span', { className: 'battle-timer', text: '۰:۰۰' });
    this.liveProgress = el('i');
    this.chipAttackers = this._chip('⚔', this.t('battle.attackers', 'مهاجمان'));
    this.chipDefenders = this._chip('🛡', this.t('battle.defenders', 'مدافعان'));
    this.chipDamage = this._chip('⌂', this.t('battle.structures', 'سازه‌های آسیب‌دیده'));
    this.deployBar = el('div', { className: 'battle-deploy-bar' });
    this.deployHint = el('small', { className: 'battle-deploy-hint', text: this.t('battle.deployHint', '') });
    this.cancelDeployBtn = button(this.t('battle.cancelDeploy', 'لغو استقرار'), {
      className: 'ui-btn is-hidden',
      onClick: () => this.setDeployType(null),
    });
    this.pauseButton = button(this.t('battle.pause', 'توقف'), {
      className: 'ui-btn',
      onClick: () => {
        const paused = this.battle.togglePause();
        this.pauseButton.querySelector('.ui-btn__label').textContent = paused
          ? this.t('battle.resume', 'ادامه')
          : this.t('battle.pause', 'توقف');
      },
    });
    this.speedButton = button('×۲', {
      className: 'ui-btn',
      title: this.t('battle.speed', 'سرعت'),
      onClick: () => {
        const next = this.battle.speed >= 3 ? 1 : this.battle.speed + 1;
        this.battle.setSpeed(next);
        this.renderSpeeds();
      },
    });
    this.withdrawButton = button(this.t('battle.withdraw', 'عقب‌نشینی'), {
      className: 'ui-btn battle-withdraw',
      onClick: () => {
        this.battle.withdraw();
      },
    });
    this.replayBadge = el('span', { className: 'battle-badge is-hidden', text: this.t('battle.replayRunning', 'بازپخش') });

    this.liveBox = el('section', {
      className: 'battle-live is-hidden',
      children: [
        el('div', {
          className: 'battle-topbar',
          children: [this.liveName, this.replayBadge, this.liveTimer],
        }),
        el('div', { className: 'battle-progress', children: [this.liveProgress] }),
        el('div', {
          className: 'battle-chips',
          children: [this.chipAttackers, this.chipDefenders, this.chipDamage],
        }),
        this.deployBar,
        el('div', { className: 'battle-deploy-row', children: [this.deployHint, this.cancelDeployBtn] }),
        el('div', {
          className: 'battle-controls',
          children: [this.pauseButton, this.speedButton, this.withdrawButton],
        }),
      ],
    });

    /* ------------------------------------------------------------ result view */
    this.resultTitle = el('b', { className: 'battle-result-title', text: '' });
    this.resultBody = el('div', { className: 'battle-result-body' });
    this.resultRewards = el('div', { className: 'battle-rewards' });
    this.resultVerify = el('small', { className: 'battle-verify is-hidden' });
    this.replayButton = button(this.t('battle.replay', 'بازپخش نبرد'), {
      className: 'ui-btn',
      onClick: () => this.startReplay(),
    });
    this.resultBox = el('section', {
      className: 'battle-card battle-result is-hidden',
      children: [
        el('header', {
          children: [
            this.resultTitle,
            button('×', { className: 'ui-icon-btn', onClick: () => this.closeSession() }),
          ],
        }),
        this.resultBody,
        this.resultRewards,
        this.resultVerify,
        el('div', {
          className: 'battle-result-actions',
          children: [
            this.replayButton,
            button(this.t('battle.close', 'بستن'), { className: 'ui-btn ui-btn--primary', onClick: () => this.closeSession() }),
          ],
        }),
      ],
    });

    this.root = el('div', {
      className: 'ui-root battle-ui is-hidden',
      attrs: { dir: 'rtl', lang: 'fa' },
      children: [this.setupBox, this.liveBox, this.resultBox],
    });
    document.body.append(this.root);

    this._unsubscribers = [
      bus.on(EVENTS.BATTLE_STARTED, () => {
        this.mode = 'live';
        this.setDeployType(null);
        this.renderLive(this.battle.status());
        this.show();
      }),
      bus.on(EVENTS.BATTLE_PROGRESS, (status) => this.renderLive(status)),
      bus.on(EVENTS.BATTLE_ENDED, (payload) => this.renderResult(payload)),
      bus.on(EVENTS.BATTLE_REPLAY_STARTED, () => {
        this.mode = 'replay';
        this.replayBadge.classList.remove('is-hidden');
        this.replayBadge.textContent = this.t('battle.replayRunning', 'در حال بازپخش…');
        this.resultBox.classList.add('is-hidden');
        this.liveBox.classList.remove('is-hidden');
        this.setDeployType(null);
        this.show();
      }),
      bus.on(EVENTS.BATTLE_REPLAY_VERIFIED, (verification) => {
        this.replayBadge.classList.add('is-hidden');
        this.resultVerify.classList.remove('is-hidden');
        this.resultVerify.textContent = verification.ok
          ? `${this.t('battle.replayMatch', 'بازپخش با ضبط یکسان است')} ✓ (${faDigits(verification.actualHash)})`
          : `${this.t('battle.replayMismatch', 'بازپخش با ضبط یکسان نیست')} ✗`;
        this.resultVerify.classList.toggle('is-bad', !verification.ok);
      }),
      bus.on(EVENTS.BATTLE_SESSION_CLOSED, () => {
        this.mode = 'setup';
        this.hide();
      }),
      bus.on(EVENTS.BATTLE_TAP, (point) => this.onWorldTap(point)),
      bus.on(EVENTS.ARMY_CHANGED, () => {
        if (this.visible && this.mode === 'setup') this.renderSetup();
        if (this.visible && this.mode !== 'setup') this.renderDeployBar(this.lastStatus);
      }),
      bus.on(EVENTS.STRUCTURE_DAMAGED, () => {
        if (this.visible && this.mode === 'setup') this.renderSetup();
      }),
    ];
  }

  _chip(icon, label) {
    return el('div', {
      className: 'battle-chip',
      children: [el('span', { text: icon }), el('b', { text: '۰' }), el('small', { text: label })],
    });
  }

  /* ------------------------------------------------------------------ setup */

  renderSetup() {
    const t = this.t;
    this.encounterList.replaceChildren();
    for (const encounter of this.encounters) {
      const selected = encounter.id === this.selectedEncounter;
      const card = el('button', {
        className: `battle-encounter${selected ? ' is-selected' : ''}`,
        attrs: { type: 'button', dataset: { encounter: encounter.id } },
        children: [
          el('b', { text: encounter.name }),
          el('small', { text: `${t('battle.threat', 'سختی')} ${THREAT_STARS(encounter.threat)}` }),
          el('small', { text: `${faDigits(encounter.units)} ${t('battle.attackers', 'مهاجم')} · ${faDigits(encounter.waves)} ${t('battle.waves', 'موج')}` }),
        ],
      });
      card.addEventListener('click', () => {
        this.selectedEncounter = encounter.id;
        this.renderSetup();
      });
      this.encounterList.append(card);
    }

    const preview = this.battle.preview(this.selectedEncounter);
    const readiness = this.barracks.readiness();
    this.readinessBox.replaceChildren(
      this._readinessChip('🛡', t('battle.defenders', 'مدافعان'), faDigits(preview ? preview.defenses : 0)),
      this._readinessChip('👥', t('army.readiness', 'آمادهٔ نبرد'), faDigits(readiness.total)),
      this._readinessChip('⚑', t('battle.walls', 'دیوار'), faDigits(preview ? preview.walls : 0)),
      this._readinessChip('⌂', t('battle.capacity', 'ظرفیت سپاه'), `${faDigits(readiness.used)}/${faDigits(readiness.capacity)}`),
    );

    const blocked = !preview;
    this.startButton.disabled = blocked;
    this.setupHint.textContent = readiness.total === 0
      ? t('battle.notEnoughArmy', 'سپاه شما خالی است؛ نخست در پادگان نیرو آموزش دهید.')
      : t('battle.field', '');
  }

  _readinessChip(icon, label, value) {
    return el('div', {
      className: 'battle-readiness-chip',
      children: [el('span', { text: icon }), el('b', { text: value }), el('small', { text: label })],
    });
  }

  /* ------------------------------------------------------------------- live */

  renderLive(status) {
    if (!status) return;
    this.lastStatus = status;
    this.liveName.textContent = status.encounterName || this.t('battle.title', 'میدان نبرد');
    this.liveTimer.textContent = `${faDigits(Math.floor(status.seconds / 60))}:${faDigits(String(Math.floor(status.seconds % 60)).padStart(2, '0'))}`;
    this.liveProgress.style.setProperty('--progress', `${Math.round((status.progress ?? 0) * 100)}%`);
    this.chipAttackers.querySelector('b').textContent = `${faDigits(status.raidersAlive)}/${faDigits(status.raidersTotal)}`;
    this.chipDefenders.querySelector('b').textContent = faDigits(status.defendersAlive);
    this.chipDamage.querySelector('b').textContent = `${faDigits(status.damaged)}${status.destroyed ? ` (${faDigits(status.destroyed)})` : ''}`;
    this.withdrawButton.disabled = Boolean(status.done) || status.mode === 'replay';
    this.pauseButton.disabled = status.mode === 'replay';
    this.speedButton.disabled = status.mode === 'replay';
    this.renderDeployBar(status);
    this.renderSpeeds();
  }

  renderSpeeds() {
    this.speedButton.querySelector('.ui-btn__label').textContent = `×${faDigits(this.battle.speed)}`;
  }

  renderDeployBar(status) {
    if (!status) return;
    const remaining = status.mode === 'live' ? (status.garrison || {}) : {};
    const readiness = this.barracks.readiness();
    this.deployBar.replaceChildren();
    for (const unit of this.unitsData.units) {
      const count = remaining[unit.id] || 0;
      const meta = readiness.byType.find((item) => item.type === unit.id);
      const node = el('button', {
        className: `battle-unit${this.deployType === unit.id ? ' is-active' : ''}${count <= 0 ? ' is-empty' : ''}`,
        attrs: { type: 'button', dataset: { unit: unit.id }, title: unit.name },
        children: [
          el('span', { className: 'battle-unit__icon', text: unit.icon }),
          el('b', { text: faDigits(count) }),
          el('small', { text: this.t(`army.${ROLE_KEYS[unit.role] || 'melee'}`, unit.role) || unit.name }),
          el('em', { text: `${this.t('army.hp', 'جان')} ${faDigits(unit.hp)}` }),
        ],
      });
      node.addEventListener('click', () => {
        if (this.mode !== 'live') return;
        if ((this.lastStatus?.garrison?.[unit.id] || 0) <= 0) {
          this.bus.emit(EVENTS.UI_TOAST, this.t('battle.deployEmpty', ''));
          return;
        }
        this.setDeployType(this.deployType === unit.id ? null : unit.id);
      });
      if (meta && meta.training) node.classList.add('is-training');
      this.deployBar.append(node);
    }
  }

  /* ---------------------------------------------------------------- deploy */

  setDeployType(type) {
    this.deployType = type || null;
    this.view?.setDeployType(this.deployType);
    if (!this.deployType) this.view?.clearPointer();
    this.cancelDeployBtn.classList.toggle('is-hidden', !this.deployType);
    this.renderDeployBar(this.lastStatus);
  }

  /** نقطهٔ لمس‌شدهٔ دنیای سه‌بعدی (x,z) در حالت استقرار. */
  onWorldTap(point) {
    if (this.mode !== 'live' || !this.deployType || !point) return false;
    const validation = this.battle.sim?.canDeploy(this.deployType, point.x, point.z);
    if (validation && !validation.ok) {
      this.bus.emit(EVENTS.UI_TOAST, this.t('battle.deployBlocked', ''));
      return true;
    }
    const result = this.battle.deploy(this.deployType, point.x, point.z);
    if (result.ok) {
      const left = this.battle.status()?.garrison?.[this.deployType] || 0;
      this.renderDeployBar(this.battle.status());
      if (left <= 0) this.setDeployType(null);
    }
    return true;
  }

  onWorldMove(point) {
    if (this.mode !== 'live' || !this.deployType || !point) return;
    const validation = this.battle.sim?.canDeploy(this.deployType, point.x, point.z);
    this.view?.setPointer(point.x, point.z, validation ? validation.ok : true);
  }

  /* ----------------------------------------------------------------- battle */

  startBattle() {
    const result = this.battle.start({ encounterId: this.selectedEncounter });
    if (!result.ok) {
      this.bus.emit(EVENTS.UI_TOAST, this.t(`battle.blocked.${result.reason}`, this.t('battle.startBlocked', '')));
      return;
    }
    this.mode = 'live';
    this.onBattleStart?.();
  }

  startReplay() {
    if (this.battle.sim?.done) this.battle.closeSession();
    const result = this.battle.startReplay(0);
    if (!result.ok) {
      this.bus.emit(EVENTS.UI_TOAST, this.t(`battle.blocked.${result.reason}`, this.t('battle.noBattle', '')));
      return;
    }
    this.onBattleStart?.();
  }

  closeSession() {
    this.battle.closeSession();
    this.onBattleExit?.();
  }

  /* ---------------------------------------------------------------- result */

  renderResult(payload) {
    const t = this.t;
    const { report, rewards, mode, verification } = payload;
    this.mode = mode === 'replay' ? 'replay' : 'result';
    this.liveBox.classList.add('is-hidden');
    this.resultBox.classList.remove('is-hidden');
    this.resultTitle.textContent = `${t('battle.result', 'نتیجهٔ نبرد')}: ${t(`battle.${report.result}`, report.result)}`;
    this.resultVerify.classList.toggle('is-hidden', !verification);
    if (verification) {
      this.resultVerify.textContent = verification.ok
        ? `${t('battle.replayMatch', 'بازپخش با ضبط یکسان است')} ✓`
        : `${t('battle.replayMismatch', 'بازپخش با ضبط یکسان نیست')} ✗`;
      this.resultVerify.classList.toggle('is-bad', !verification.ok);
    }

    const rows = [
      [t('battle.elapsed', 'زمان نبرد'), `${faDigits(Math.round(report.seconds))} ${t('army.seconds', 'ثانیه')}`],
      [t('battle.attackers', 'مهاجمان'), `${faDigits(report.raidersLeft)}/${faDigits(report.raidersSpawned)}`],
      [t('battle.defenders', 'مدافعان'), `${faDigits(report.defendersLeft)} · ${t('battle.unitsLost', 'ازدست‌رفته')} ${faDigits(report.defendersDeployed - report.defendersLeft)}`],
      [t('battle.structures', 'سازه‌های آسیب‌دیده'), `${faDigits(report.damagedStructures)} (${t('defense.destroyed', 'از کار افتاده')} ${faDigits(report.destroyedStructures)})`],
      [t('battle.wallsBreached', 'دیوارهای شکسته'), faDigits(report.wallsBreached)],
      [t('battle.seed', 'بذر'), faDigits(report.stateHash)],
    ];
    this.resultBody.replaceChildren(
      ...rows.map(([label, value]) => el('div', {
        className: 'battle-stat',
        children: [el('small', { text: label }), el('b', { text: value })],
      })),
    );

    this.resultRewards.replaceChildren();
    const entries = Object.entries(rewards || {}).filter(([, value]) => value > 0);
    if (entries.length === 0) {
      this.resultRewards.append(el('small', { text: t('battle.noReward', 'بدون پاداش') }));
    } else {
      this.resultRewards.append(el('small', { text: t('battle.rewards', 'پاداش') }));
      for (const [resource, value] of entries) {
        this.resultRewards.append(el('span', {
          className: 'battle-reward',
          text: `+${faDigits(value)} ${t(`economy.${resource}`, resource)}`,
        }));
      }
    }
    this.replayButton.disabled = mode !== 'live';
    this.show();
  }

  /* ------------------------------------------------------------------- misc */

  show() {
    this.visible = true;
    this.root.classList.remove('is-hidden');
    if (this.mode === 'setup') {
      this.setupBox.classList.remove('is-hidden');
      this.liveBox.classList.add('is-hidden');
      this.resultBox.classList.add('is-hidden');
      this.renderSetup();
    } else if (this.battle.active) {
      this.setupBox.classList.add('is-hidden');
      this.liveBox.classList.toggle('is-hidden', this.mode === 'result' || Boolean(this.battle.sim?.done));
      this.renderLive(this.battle.status());
    }
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
    this._timerAcc += dt;
    if (this._timerAcc < 0.25) return;
    this._timerAcc = 0;
    const status = this.battle.status();
    if (!status) return;
    this.lastStatus = status;
    if (this.mode === 'live') {
      this.liveTimer.textContent = `${faDigits(Math.floor(status.seconds / 60))}:${faDigits(String(Math.floor(status.seconds % 60)).padStart(2, '0'))}`;
      this.liveProgress.style.setProperty('--progress', `${Math.round((status.progress ?? 0) * 100)}%`);
      this.chipAttackers.querySelector('b').textContent = `${faDigits(status.raidersAlive)}/${faDigits(status.raidersTotal)}`;
      this.chipDefenders.querySelector('b').textContent = faDigits(status.defendersAlive);
      this.chipDamage.querySelector('b').textContent = `${faDigits(status.damaged)}${status.destroyed ? ` (${faDigits(status.destroyed)})` : ''}`;
      this.renderDeployBar(status);
    }
  }

  dispose() {
    for (const off of this._unsubscribers) off();
    this.root.remove();
  }
}
