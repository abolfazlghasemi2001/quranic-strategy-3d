/**
 * CampaignSystem — کمپین داستانی «قصص» (فاز ۶). منطق خالص: بدون Three.js و DOM.
 *
 * مسئولیت‌ها:
 *   • فهرست مأموریت‌ها با وضعیت قفل/باز/فعال/تکمیل و ستاره‌های ذخیره‌شده
 *   • شروع، موقتی‌متوقف‌کردن، ادامه، پایان و رهاشدن مأموریت
 *   • پیش‌بردن قاعدهٔ هر مأموریت (rules/) و تقسیم کنش‌های بازیکن
 *   • ستاره‌شماری، پاداش، باز شدن مأموریت بعدی و ثبت در ذخیره
 *
 * خط قرمزها:
 *   • هیچ متن قرآنی در این لایه نیست؛ ارجاع‌ها شناسهٔ آیه‌اند و متن — اگر لازم
 *     شود — از دیتاست قرآنی در لایهٔ رابط کاربری خوانده می‌شود.
 *   • هیچ مأموریتی نبرد نمی‌خواهد و هیچ تصویری از پیامبران/فرشتگان ندارد.
 *   • هیچ شانس/قمار: ستاره‌ها فقط از هدف‌های داده‌محور می‌آیند.
 */
import { EVENTS } from '../../core/EventBus.js';
import { createCampaignState, normalizeCampaignState, createMissionRecord } from './MissionState.js';
import { getRuleModule } from './rules/index.js';
import { missionRefs, missionRefCards, starCount } from './MissionData.js';
import { toFaDigits } from '../quran/QuranDataset.js';

export class CampaignSystem {
  /**
   * @param {object} options
   * @param {object} options.config — Config (برای t() و بذر)
   * @param {object} options.campaignData — src/data/campaign.json
   * @param {{list:object[], byId:Map<string,object>, meta:object}} options.missions — خروجی normalizeMissions
   * @param {import('../GameState.js').GameState} options.state
   * @param {import('../EconomySystem.js').EconomySystem} options.economy
   * @param {import('../BuildQueue.js').BuildQueue} options.queue
   * @param {import('../../core/EventBus.js').EventBus} [options.bus]
   * @param {object} [options.game] — برای persist و markEconomyDirty
   * @param {object} [options.dataset] — دیتاست قرآنی (فقط برای ارجاع/آیه؛ متن این‌جا رندر نمی‌شود)
   * @param {(seconds:number, now:number)=>object|null} [options.applySpeedup]
   * @param {() => boolean} [options.isBattleActive]
   */
  constructor({
    config,
    campaignData,
    missions,
    state,
    economy,
    queue,
    bus = null,
    game = null,
    dataset = null,
    applySpeedup = null,
    isBattleActive = null,
  }) {
    this.config = config;
    this.data = campaignData;
    this.missions = missions;
    this.state = state;
    this.economy = economy;
    this.queue = queue;
    this.bus = bus;
    this.game = game;
    this.dataset = dataset;
    this.applySpeedup = applySpeedup;
    this.isBattleActive = isBattleActive;

    this._emitAcc = 0;
    this._lastSnapshot = null;
    this._onTap = null;
    if (this.bus) {
      this._onTap = this.bus.on(EVENTS.TILE_TAP, (payload) => this.handleTileTap(payload));
    }
  }

  /* ------------------------------------------------------------------ state */

  get progress() {
    if (!this.state.campaign) this.state.campaign = createCampaignState();
    return this.state.campaign;
  }

  get maxStars() {
    return Math.max(1, Number(this.data?.starsMax) || 3);
  }

  get activeRun() {
    return this.progress.active;
  }

  get missionList() {
    return this.missions?.list || [];
  }

  mission(id) {
    return this.missions?.byId?.get(id) || null;
  }

  record(id) {
    if (!this.progress.missions[id]) this.progress.missions[id] = createMissionRecord();
    return this.progress.missions[id];
  }

  totalStars() {
    let total = 0;
    for (const mission of this.missionList) {
      total += this.record(mission.id).bestStars || 0;
    }
    return total;
  }

  totalStarsPossible() {
    return this.missionList.length * this.maxStars;
  }

  isCompleted(id) {
    return (this.record(id).completions || 0) > 0;
  }

  /** زنجیرهٔ باز شدن: مأموریت اول آزاد و هر مأموریت بعدی پس از تکمیل مأموریت پیشین. */
  isUnlocked(id) {
    const mission = this.mission(id);
    if (!mission) return false;
    const requirePrevious = this.data?.unlock?.requirePrevious !== false;
    if (!mission.unlock.after) return true;
    if (!requirePrevious) return true;
    const previous = this.record(mission.unlock.after);
    if (previous.completions <= 0) return false;
    return (previous.bestStars || 0) >= (mission.unlock.minStars || 0);
  }

  lockReason(id) {
    const mission = this.mission(id);
    if (!mission) return 'missing';
    if (this.isUnlocked(id)) return null;
    const previous = this.mission(mission.unlock.after);
    return previous ? previous.title : 'قفل';
  }

  /* ------------------------------------------------------------------ list */

  /** فهرست مأموریت‌ها برای رابط کاربری (بدون هیچ متن آیه). */
  list() {
    const activeId = this.activeRun?.missionId || null;
    return this.missionList.map((mission) => {
      const record = this.record(mission.id);
      const unlocked = this.isUnlocked(mission.id);
      const completed = (record.completions || 0) > 0;
      return {
        id: mission.id,
        order: mission.order,
        icon: mission.icon,
        title: mission.title,
        subtitle: mission.subtitle,
        hint: mission.hint,
        qasas: { ...mission.qasas },
        refs: missionRefs(mission),
        narrative: mission.briefing.map((line) => ({ ...line })),
        lessonLearned: mission.lessonLearned,
        lessonPoints: [...mission.lessonPoints],
        objectives: mission.objectives.map((objective) => ({ ...objective })),
        reward: { ...mission.reward },
        status: completed ? 'completed' : unlocked ? 'available' : 'locked',
        lockedBy: unlocked ? null : this.lockReason(mission.id),
        stars: record.lastStars || 0,
        bestStars: record.bestStars || 0,
        attempts: record.attempts || 0,
        completions: record.completions || 0,
        isActive: activeId === mission.id,
        progress: { ...(record.objectives || {}) },
      };
    });
  }

  /** کارت‌های ارجاع آیه (متن فقط در صورت وجود در دیتاست برمی‌گردد). */
  refCards(missionId) {
    const mission = this.mission(missionId);
    if (!mission) return [];
    return missionRefCards(this.dataset, mission);
  }

  /* ------------------------------------------------------------- lifecycle */

  canStart(missionId) {
    if (this.activeRun) return { ok: false, reason: 'busy' };
    const mission = this.mission(missionId);
    if (!mission) return { ok: false, reason: 'missing' };
    if (!this.isUnlocked(missionId)) return { ok: false, reason: 'locked' };
    if (this.isBattleActive && this.isBattleActive()) return { ok: false, reason: 'battle' };
    return { ok: true };
  }

  /**
   * شروع مأموریت. ورودی هیچ گوهری نمی‌خواهد و هیچ شانسی در آن نیست؛
   * هزینه‌ها فقط هنگام کنش‌های درون‌مأموریت پرداخت می‌شوند.
   */
  start(missionId, now = Date.now()) {
    const allowed = this.canStart(missionId);
    if (!allowed.ok) return allowed;
    const mission = this.mission(missionId);
    const rule = getRuleModule(mission.rules.kind);
    if (!rule) return { ok: false, reason: 'no-rule' };

    const record = this.record(missionId);
    record.attempts += 1;
    record.firstPlayedAt = record.firstPlayedAt || now;

    const run = {
      missionId,
      startedAt: now,
      lastTickAt: now,
      elapsedSeconds: 0,
      paused: false,
      runtime: rule.createRuntime({ mission, state: this.state, economy: this.economy, now }),
      actions: {},
      log: [],
    };
    this.progress.active = run;
    this._applyEconomyModifiers(now);
    this._emit(EVENTS.MISSION_STARTED, { missionId, at: now, ruleKind: mission.rules.kind });
    this.emitChanged(now, true);
    this._flush();
    return { ok: true, mission, run };
  }

  pause(now = Date.now()) {
    const run = this.activeRun;
    if (!run || run.paused) return { ok: false, reason: 'not-active' };
    run.paused = true;
    this._applyEconomyModifiers(now);
    this.bus?.emit(EVENTS.UI_TOAST, { message: this.config.t('campaign.pausedToast', 'مأموریت موقتاً متوقف شد؛ قحطی و سیل در غیبت شما پیش نمی‌رود.'), type: 'info' });
    this.emitChanged(now, true);
    this._flush(true);
    return { ok: true };
  }

  resume(now = Date.now()) {
    const run = this.activeRun;
    if (!run || !run.paused) return { ok: false, reason: 'not-paused' };
    run.paused = false;
    run.lastTickAt = now;
    this._applyEconomyModifiers(now);
    this.emitChanged(now, true);
    this._flush(true);
    return { ok: true };
  }

  /** رهاکردن مأموریت: بدون جریمه، بدون پاداش؛ هزینهٔ کنش‌های انجام‌شده برنمی‌گردد. */
  abort(now = Date.now(), reason = 'user') {
    const run = this.activeRun;
    if (!run) return { ok: false, reason: 'not-active' };
    const missionId = run.missionId;
    this._clearMissionJobs(missionId, true);
    this.progress.active = null;
    this.progress.totals.failures += 1;
    this._applyEconomyModifiers(now);
    this.bus?.emit(EVENTS.MISSION_ABORTED, { missionId, at: now, reason });
    this.emitChanged(now, true);
    this._flush(true);
    return { ok: true, missionId };
  }

  /** هنگام بوت: مأموریت نیمه‌کاره موقتاً متوقف می‌شود تا در غیبت پیش نرود. */
  onBoot(now = Date.now()) {
    const run = this.activeRun;
    if (!run) return { resumed: false };
    if (this.data?.tick?.offlinePause !== false) {
      run.paused = true;
      run.lastTickAt = now;
    }
    this._applyEconomyModifiers(now);
    this.emitChanged(now, true);
    return { resumed: true, paused: run.paused, missionId: run.missionId };
  }

  /* ------------------------------------------------------------------- tick */

  /**
   * پیش‌بردن مأموریت فعال. `dt` ثانیه است و برای جلوگیری از جهش‌های بزرگ
   * (بازگشت از پس‌زمینه) به maxStepSeconds محدود می‌شود.
   */
  tick(dt, now = Date.now()) {
    const run = this.activeRun;
    if (!run) return null;
    if (run.paused) return null;
    const mission = this.mission(run.missionId);
    const rule = mission ? getRuleModule(mission.rules.kind) : null;
    if (!mission || !rule) return null;

    const step = Math.max(0, Math.min(dt, Number(this.data?.tick?.maxStepSeconds) || 0.5));
    if (step <= 0) return null;

    const ctx = this._context(mission, run, rule, now);
    if (!run.runtime || typeof run.runtime !== 'object') run.runtime = rule.createRuntime({ mission, state: this.state, economy: this.economy, now });
    rule.tick(run.runtime, step, ctx);
    run.elapsedSeconds += step;
    run.lastTickAt = now;

    const evaluation = rule.evaluate(run.runtime, ctx);
    this._applyEconomyModifiers(now);

    this._emitAcc += step;
    const every = Number(this.data?.tick?.emitIntervalSeconds) || 0.25;
    if (this._emitAcc >= every) {
      this._emitAcc = 0;
      if (this.bus) this.bus.emit(EVENTS.MISSION_PROGRESS, this._activeView(mission, run, rule, evaluation, now));
    }

    if (evaluation.failed) {
      return this.finish(now, { failed: true, failReason: evaluation.failReason, evaluation, rule, mission, run });
    }
    if (evaluation.done) {
      return this.finish(now, { failed: false, evaluation, rule, mission, run });
    }
    return null;
  }

  /** پایان مأموریت: ستاره‌شماری، کارنامه، پاداش، باز شدن مأموریت بعدی. */
  finish(now = Date.now(), { failed = false, failReason = null, evaluation = null, rule = null, mission = null, run = null } = {}) {
    const activeRun = run || this.activeRun;
    if (!activeRun) return { ok: false, reason: 'not-active' };
    const target = mission || this.mission(activeRun.missionId);
    const module = rule || (target ? getRuleModule(target.rules.kind) : null);
    if (!target || !module) return { ok: false, reason: 'no-rule' };

    const ctx = this._context(target, activeRun, module, now);
    const result = evaluation || module.evaluate(activeRun.runtime, ctx);
    const stars = failed ? 0 : Math.min(this.maxStars, starCount(result.objectives, target));
    const seconds = Math.round(activeRun.elapsedSeconds);

    const record = this.record(target.id);
    const firstClear = !failed && (record.completions || 0) === 0;
    const previousBest = record.bestStars || 0;
    const gainedStars = Math.max(0, stars - previousBest);

    if (failed) {
      record.failed += 1;
      record.lastStars = 0;
    } else {
      record.completions += 1;
      record.lastStars = stars;
      record.bestStars = Math.max(previousBest, stars);
      record.completedAt = record.completedAt || now;
      if (record.bestTimeSeconds == null || seconds < record.bestTimeSeconds) record.bestTimeSeconds = seconds;
    }
    record.objectives = { ...(result.objectives || {}) };

    const granted = failed ? { nur: 0, hekmat: 0, gohar: 0, speedup: null, overflow: { nur: 0, hekmat: 0 } } : this._grant(target, { stars, firstClear, gainedStars }, now);

    this.progress.history.unshift({
      id: `run-${this.progress.history.length + 1}-${now}`,
      missionId: target.id,
      at: now,
      stars,
      failed: !!failed,
      seconds,
      objectives: { ...(result.objectives || {}) },
    });
    if (this.progress.history.length > 20) this.progress.history.length = 20;

    if (!failed) {
      this.progress.totals.completed += firstClear ? 1 : 0;
      this.progress.totals.stars = this._recountStars();
    }

    this._clearMissionJobs(target.id, false);
    this.progress.active = null;
    this._applyEconomyModifiers(now);

    const unlocked = this.missionList
      .filter((mission2) => this.isUnlocked(mission2.id) && !this.isCompleted(mission2.id))
      .map((mission2) => mission2.id);

    const report = {
      ok: true,
      missionId: target.id,
      title: target.title,
      failed: !!failed,
      failReason: failReason || result.failReason || null,
      stars,
      bestStars: record.bestStars,
      firstClear,
      seconds,
      objectives: target.objectives.map((objective) => ({
        ...objective,
        done: !failed && result.objectives?.[objective.id] === true,
      })),
      progress: { ...(result.progress || {}) },
      lessonLearned: target.lessonLearned,
      // درس‌آموخته در پنل نتیجه نشان داده می‌شود (بدون هیچ متن آیه).
      lessonPoints: [...target.lessonPoints],
      granted,
      hasNext: unlocked.length > 0,
      at: now,
    };

    this._lastReport = report;
    if (failed) {
      this.bus?.emit(EVENTS.MISSION_FINISHED, report);
    } else {
      this.bus?.emit(EVENTS.MISSION_FINISHED, report);
      this.bus?.emit(EVENTS.MISSION_REWARD_GRANTED, { missionId: target.id, granted, stars, at: now });
      this._toast(report);
    }
    this.emitChanged(now, true);
    this._flush(true);
    return report;
  }

  _recountStars() {
    let total = 0;
    for (const mission of this.missionList) total += this.record(mission.id).bestStars || 0;
    return total;
  }

  _grant(mission, { stars, firstClear, gainedStars }, now) {
    const table = this.data?.rewards || {};
    const perStar = table.perStar || {};
    const respect = table.respectStorageCapacity !== false;
    const reward = { ...mission.reward };
    if (!firstClear) {
      // تکرار مأموریت فقط برای ستارهٔ تازه پاداش می‌دهد: پاداش چند برابر نمی‌شود.
      reward.nur = 0; reward.hekmat = 0; reward.gohar = 0; reward.speedupSeconds = 0;
      reward.nur = Math.round((perStar.nur || 0) * gainedStars);
      reward.hekmat = Math.round((perStar.hekmat || 0) * gainedStars);
    } else {
      reward.nur += Math.round((perStar.nur || 0) * stars);
      reward.hekmat += Math.round((perStar.hekmat || 0) * stars);
      reward.speedupSeconds += Math.round((table.speedupSecondsPerStar || 0) * stars);
    }

    const granted = { nur: 0, hekmat: 0, gohar: 0, speedup: null, overflow: { nur: 0, hekmat: 0 } };
    if (reward.nur > 0) {
      const result = this.economy.grant('nur', reward.nur, { clampToCapacity: respect });
      granted.nur = result.moved;
      granted.overflow.nur = result.overflow;
      this.progress.totals.nur += result.moved;
    }
    if (reward.hekmat > 0) {
      const result = this.economy.grant('hekmat', reward.hekmat, { clampToCapacity: respect });
      granted.hekmat = result.moved;
      granted.overflow.hekmat = result.overflow;
      this.progress.totals.hekmat += result.moved;
    }
    if (reward.gohar > 0) {
      granted.gohar = this.economy.earnGohar(reward.gohar);
      this.progress.totals.gohar += granted.gohar;
    }
    if (reward.speedupSeconds > 0 && typeof this.applySpeedup === 'function') {
      granted.speedup = this.applySpeedup(reward.speedupSeconds, now);
    }
    return granted;
  }

  _toast(report) {
    const parts = [];
    if (report.granted.nur > 0) parts.push(`نور ${toFaDigits(Math.round(report.granted.nur))}`);
    if (report.granted.hekmat > 0) parts.push(`حکمت ${toFaDigits(Math.round(report.granted.hekmat))}`);
    if (report.granted.gohar > 0) parts.push(`گوهر ${toFaDigits(Math.round(report.granted.gohar))}`);
    if (report.granted.speedup?.appliedSeconds > 0) parts.push(`تسریع ساخت ${toFaDigits(report.granted.speedup.appliedSeconds)}ث`);
    this.bus?.emit(EVENTS.UI_TOAST, {
      message: `مأموریت «${report.title}» با ${toFaDigits(report.stars)} ستاره تمام شد${parts.length ? ` — ${parts.join('، ')}` : ''}`,
      type: 'success',
    });
  }

  /* ---------------------------------------------------------------- actions */

  actions() {
    const run = this.activeRun;
    if (!run) return [];
    const mission = this.mission(run.missionId);
    const rule = mission ? getRuleModule(mission.rules.kind) : null;
    if (!mission || !rule) return [];
    return rule.actions(run.runtime, this._context(mission, run, rule, Date.now()));
  }

  /** اجرای یک کنش مأموریت (از پنل یا تپ روی نشانگرها). */
  perform(actionId, payload = {}, now = Date.now()) {
    const run = this.activeRun;
    if (!run) return { ok: false, reason: 'not-active' };
    if (run.paused) return { ok: false, reason: 'paused' };
    const mission = this.mission(run.missionId);
    const rule = mission ? getRuleModule(mission.rules.kind) : null;
    if (!mission || !rule) return { ok: false, reason: 'no-rule' };

    const ctx = this._context(mission, run, rule, now);
    const result = rule.perform({ runtime: run.runtime, actionId, ctx, ...payload });
    if (!result.ok) {
      const messages = {
        resources: this.config.t('campaign.blocked.resources', 'منابع کافی برای این کنش نیست.'),
        cooldown: this.config.t('campaign.blocked.cooldown', 'چند لحظه صبر کنید.'),
        'in-progress': this.config.t('campaign.blocked.inProgress', 'این کار همین حالا در دست بنّاهاست.'),
        healthy: this.config.t('campaign.blocked.healthy', 'این بخش سالم است.'),
        'already-built': this.config.t('campaign.blocked.built', 'این بخش ساخته شده است.'),
        'no-plot': this.config.t('campaign.blocked.noPlot', 'نشانگر مأموریت پیدا نشد.'),
        paused: this.config.t('campaign.blocked.paused', 'مأموریت موقتاً متوقف است.'),
      };
      const message = messages[result.reason];
      if (message) this.bus?.emit(EVENTS.UI_TOAST, { message, type: 'info' });
      return result;
    }

    if (result.job) {
      const enqueued = this.queue.enqueue(result.job, now);
      if (!enqueued.ok) {
        // صف پر است یا بنّا آزاد نیست: هزینه برگردانده می‌شود و کنش بی‌اثر می‌ماند.
        this._refund(result.cost);
        this._rollbackPending(rule, run, { ...result, actionId: result.actionId || actionId });
        this.bus?.emit(EVENTS.UI_TOAST, {
          message: enqueued.reason === 'queue-full'
            ? this.config.t('economy.queueFull', 'صف ساخت پر است')
            : this.config.t('economy.queued', 'در انتظار بنّا'),
          type: 'info',
        });
        this.emitChanged(now, true);
        return { ok: false, reason: enqueued.reason || 'queue' };
      }
      this.bus?.emit(EVENTS.MISSION_ACTION, { missionId: mission.id, actionId, plotId: result.job.plotId, cost: result.cost, at: now });
      this.game?.markQueueDirty?.();
      this.game?.markEconomyDirty?.();
      this.emitChanged(now, true);
      this._flush();
      return { ok: true, job: enqueued.job, cost: result.cost, actionId };
    }

    this.bus?.emit(EVENTS.MISSION_ACTION, { missionId: mission.id, actionId, cost: result.cost, at: now });
    if (result.label) {
      this.bus?.emit(EVENTS.UI_TOAST, { message: `${result.label}${result.seconds ? ` — ${toFaDigits(Math.round(result.seconds))} ث` : ''}`, type: 'success' });
    }
    this.game?.markEconomyDirty?.();
    this.emitChanged(now, true);
    this._flush();
    return { ok: true, cost: result.cost, actionId };
  }

  /** اگر صف نتوانست کار را بپذیرد، وضعیت «در ساخت» نشانگر به حالت پیشین برمی‌گردد. */
  _rollbackPending(rule, run, result) {
    if (!rule.rollbackPending) return;
    try {
      rule.rollbackPending(run.runtime, { actionId: result.actionId, plotId: result.job?.plotId }, this._context(this.mission(run.missionId), run, rule, Date.now()));
    } catch (error) {
      console.warn('[CampaignSystem] rollback failed:', error);
    }
  }

  /** پایان کار بنّاهای مأموریت (از Game._finishJob). */
  onJobFinished(job, at = Date.now()) {
    if (!job || job.kind !== 'mission') return { ok: false, reason: 'not-mission' };
    const run = this.activeRun;
    if (!run || run.missionId !== job.missionId) return { ok: false, reason: 'stale-job' };
    const mission = this.mission(job.missionId);
    const rule = mission ? getRuleModule(mission.rules.kind) : null;
    if (!mission || !rule || !rule.onJobFinished) return { ok: false, reason: 'no-rule' };
    const result = rule.onJobFinished(run.runtime, job, this._context(mission, run, rule, at));
    if (result?.ok) {
      this.bus?.emit(EVENTS.MISSION_ACTION, { missionId: mission.id, actionId: job.actionId, plotId: job.plotId, done: true, at });
    }
    this.emitChanged(at, true);
    this._flush();
    return result;
  }

  /** تپ روی نقشه: اگر زیر انگشت نشانگر مأموریت باشد، کنش همان نشانگر اجرا می‌شود. */
  handleTileTap(payload) {
    const run = this.activeRun;
    if (!run || run.paused) return { handled: false };
    const mission = this.mission(run.missionId);
    if (!mission || !payload) return { handled: false };
    const col = payload.col != null ? payload.col : payload.tile?.col;
    const row = payload.row != null ? payload.row : payload.tile?.row;
    if (col == null || row == null) return { handled: false };

    // اگر خانه زیر انگشت ساختمان شهر است، انتخاب/برداشت شهر اولویت دارد.
    for (const entity of this.state.entities.values()) {
      const w = entity.size?.[0] ?? 1;
      const h = entity.size?.[1] ?? 1;
      if (col >= entity.col && col < entity.col + w && row >= entity.row && row < entity.row + h) {
        return { handled: false, reason: 'city-building' };
      }
    }

    const plot = mission.plots.find((item) => (
      col >= item.col && col < item.col + item.size[0] && row >= item.row && row < item.row + item.size[1]
    ));
    if (!plot) return { handled: false };

    const rule = getRuleModule(mission.rules.kind);
    if (!rule) return { handled: false };
    const ctx = this._context(mission, run, rule, Date.now());
    const plotIndex = mission.plots.indexOf(plot);
    const list = rule.actions(run.runtime, ctx);
    const entry = list.find((action) => (action.plotIndex === plotIndex) || (action.plotId === plot.id));
    if (!entry) return { handled: false };

    const result = this.perform(entry.id, { plotId: plot.id, plotIndex }, Date.now());
    this.bus?.emit(EVENTS.MISSION_PLOT_TAP, { missionId: mission.id, plotId: plot.id, actionId: entry.id, ok: result.ok, at: Date.now() });
    return { handled: true, ok: result.ok, actionId: entry.id, plotId: plot.id, reason: result.reason || null };
  }

  /* -------------------------------------------------------------- snapshot */

  _context(mission, run, rule, now) {
    return {
      mission,
      rules: mission.rules,
      state: this.state,
      economy: this.economy,
      queue: this.queue,
      campaign: this,
      run,
      now,
      actionDef: (id) => mission.actions[id] || null,
      markAction: (id, at) => {
        const entry = run.actions[id] || { lastUsedAt: 0, count: 0 };
        entry.lastUsedAt = at;
        entry.count += 1;
        run.actions[id] = entry;
      },
      log: (entry) => {
        run.log.push({ at: Math.round(run.elapsedSeconds), ...entry });
        if (run.log.length > 20) run.log.shift();
      },
    };
  }

  _activeView(mission, run, rule, evaluation, now) {
    const ctx = this._context(mission, run, rule, now);
    const summary = rule.summary(run.runtime, ctx);
    const byId = evaluation.objectives || {};
    return {
      missionId: mission.id,
      title: mission.title,
      icon: mission.icon,
      qasas: { ...mission.qasas },
      ruleKind: mission.rules.kind,
      paused: !!run.paused,
      elapsedSeconds: Math.round(run.elapsedSeconds),
      hint: mission.hint,
      headline: summary.headline,
      rows: summary.rows,
      objectives: mission.objectives.map((objective) => ({ ...objective, done: byId[objective.id] === true })),
      starsPreview: starCount(byId, mission),
      failed: !!evaluation.failed,
      progress: { ...(evaluation.progress || {}) },
      actions: rule.actions(run.runtime, ctx).map((action) => ({ ...action })),
      hasPlots: mission.plots.length > 0,
    };
  }

  /** عکس کامل وضعیت برای رابط کاربری و لایهٔ رندر. */
  snapshot(now = Date.now()) {
    const run = this.activeRun;
    let active = null;
    if (run) {
      const mission = this.mission(run.missionId);
      const rule = mission ? getRuleModule(mission.rules.kind) : null;
      if (mission && rule) {
        const ctx = this._context(mission, run, rule, now);
        active = this._activeView(mission, run, rule, rule.evaluate(run.runtime, ctx), now);
      }
    }
    return {
      starsMax: this.maxStars,
      totals: { ...this.progress.totals },
      totalStars: this.totalStars(),
      missions: this.list(),
      active,
      lastReport: this._lastReport || null,
    };
  }

  /** هر تغییر مهم را با یک رویداد اعلام می‌کند (نقاشی نشانگرها و پنل). */
  emitChanged(now = Date.now(), force = false) {
    if (!this.bus) return;
    if (!force) {
      if (this._lastEmitAt && now - this._lastEmitAt < 120) return;
    }
    this._lastEmitAt = now;
    const snapshot = this.snapshot(now);
    this._lastSnapshot = snapshot;
    this.bus.emit(EVENTS.CAMPAIGN_CHANGED, snapshot);
  }

  _emit(event, payload) {
    this.bus?.emit(event, payload);
  }

  _applyEconomyModifiers(now) {
    if (!this.economy.setModifiers) return;
    const run = this.activeRun;
    if (!run || run.paused) {
      this.economy.setModifiers({ production: {}, consumption: {} });
      return;
    }
    const mission = this.mission(run.missionId);
    const rule = mission ? getRuleModule(mission.rules.kind) : null;
    if (!mission || !rule) {
      this.economy.setModifiers({ production: {}, consumption: {} });
      return;
    }
    const modifiers = rule.economyModifiers(run.runtime, this._context(mission, run, rule, now)) || {};
    this.economy.setModifiers({ production: modifiers.production || {}, consumption: modifiers.consumption || {} });
  }

  _clearMissionJobs(missionId, rollbackPending = false) {
    const removed = this.queue.removeJobs?.((job) => job.kind === 'mission' && job.missionId === missionId) || [];
    if (rollbackPending && removed.length) {
      const mission = this.mission(missionId);
      const rule = mission ? getRuleModule(mission.rules.kind) : null;
      const run = this.activeRun;
      if (rule?.rollbackPending && run) {
        for (const job of removed) {
          rule.rollbackPending(run.runtime, { actionId: job.actionId, plotId: job.plotId }, this._context(mission, run, rule, Date.now()));
        }
      }
    }
    return removed;
  }

  /** برگرداندن هزینهٔ کنشی که به صف نرسید (بدون کسر از سقف انبار). */
  _refund(cost) {
    for (const [resource, amount] of Object.entries(cost || {})) {
      if (!(amount > 0)) continue;
      if (resource === 'gohar') {
        this.economy.earnGohar(amount);
      } else {
        this.economy.resources[resource] = (this.economy.resources[resource] || 0) + amount;
      }
    }
  }

  _flush(save = false) {
    if (save) this.game?.persist?.();
  }

  toJSON() {
    return normalizeCampaignState(this.progress);
  }

  dispose() {
    this._applyEconomyModifiers(Date.now());
    if (this._onTap) this._onTap();
    this._onTap = null;
  }
}
