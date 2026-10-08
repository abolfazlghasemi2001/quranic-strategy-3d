/**
 * ProsperityRule — مأموریت ۳: نگهداشت آبادانی و شکرگزاری.
 *
 * چالش استراتژیک: «پایداری» — نه ساختن یک‌باره، بلکه نگه‌داشتن روزانه.
 *   • «آبادانی» شاخصی بین ۰ تا ۱ است که هر ثانیه افت می‌کند.
 *   • هر جوی آب و هر باغ، رشد روزانه اضافه می‌کند؛ ساخت آن‌ها کار بنّا می‌خواهد.
 *   • «شکرانه» کنشی است که آبادانی را بالا می‌برد و مدتی بهرهٔ تولید را بیشتر می‌کند —
 *     با هزینهٔ منبع و زمان انتظار، تا «شکر» در بازی یک کنش عملی باشد نه لفظ.
 *   • اگر آبادانی مدت زیادی زیر مرز هشدار بماند، یک باغ از دست می‌رود؛ از دست رفتن
 *     همهٔ باغ‌ها شکست مأموریت است. هیچ صحنهٔ خشن یا تخریبی نمایش داده نمی‌شود:
 *     باغ فقط خشک و زرد می‌شود.
 *
 * هدف‌ها:
 *   season      — فصل را با شهر آباد بگذران (هدف اصلی)
 *   prosperity  — آبادانی پایان فصل ≥ prosperityTarget
 *   gardens     — هیچ باغی از دست نرود
 */
import { affordableCost, clamp01, finiteOr, missionJobSpec } from './shared.js';

export const KIND = 'prosperity-upkeep';
export const OBJECTIVES = ['season', 'prosperity', 'gardens'];
/** کنش‌های موردنیاز این قاعده (باید در missions.json → actions باشند). */
export const ACTIONS = ['canal', 'garden', 'gratitude'];
const CANAL_KIND = 'canal';
const GARDEN_KIND = 'garden';

export function createRuntime({ mission }) {
  const rules = mission.rules;
  const canals = (mission.plots || []).filter((plot) => plot.kind === CANAL_KIND).map((plot) => ({ id: plot.id, status: 'empty' }));
  const gardens = (mission.plots || []).filter((plot) => plot.kind === GARDEN_KIND).map((plot) => ({ id: plot.id, status: 'empty' }));
  return {
    kind: KIND,
    elapsed: 0,
    prosperity: clamp01(finiteOr(rules.startProsperity, 0.55)),
    minProsperity: clamp01(finiteOr(rules.startProsperity, 0.55)),
    canals,
    gardens,
    gardensLost: 0,
    dangerSeconds: 0,
    gratitudeCount: 0,
    lastGratitudeAt: null,
    boostUntil: 0,
    boostSeconds: 0,
    boosted: false,
    failed: false,
    failReason: null,
  };
}

function readyCount(list) {
  return list.filter((entry) => entry.status === 'ready').length;
}

export function tick(runtime, dt, ctx) {
  if (runtime.failed) return;
  const rules = ctx.mission.rules;
  const elapsedSeconds = Math.max(0, dt);
  runtime.elapsed += elapsedSeconds;

  const canals = readyCount(runtime.canals);
  const gardens = readyCount(runtime.gardens);
  const growth = canals * Math.max(0, finiteOr(rules.canalGrowthPerSecond, 0.02))
    + gardens * Math.max(0, finiteOr(rules.gardenGrowthPerSecond, 0.012));
  const neglected = runtime.lastGratitudeAt == null
    ? runtime.elapsed > Math.max(10, finiteOr(rules.neglectSeconds, 45))
    : (ctx.now - runtime.lastGratitudeAt) / 1000 > Math.max(10, finiteOr(rules.neglectSeconds, 45));
  const decay = Math.max(0, finiteOr(rules.decayPerSecond, 0.007))
    * (neglected ? Math.max(1, finiteOr(rules.neglectDecayMultiplier, 1.8)) : 1);

  runtime.prosperity = clamp01(runtime.prosperity + (growth - decay) * elapsedSeconds);
  runtime.minProsperity = Math.min(runtime.minProsperity, runtime.prosperity);
  runtime.boosted = runtime.boostUntil > ctx.now;

  // مرز هشدار: پیش از از دست دادن باغ، هشدار داده می‌شود (بدون هیچ جریمهٔ ناگهانی).
  if (runtime.prosperity <= Math.max(0, finiteOr(rules.dangerThreshold, 0.2))) {
    runtime.dangerSeconds += elapsedSeconds;
    if (runtime.dangerSeconds >= Math.max(1, finiteOr(rules.dangerSeconds, 12))) {
      runtime.dangerSeconds = 0;
      const standing = runtime.gardens.filter((entry) => entry.status === 'ready');
      if (standing.length > 0) {
        standing[standing.length - 1].status = 'lost';
        runtime.gardensLost += 1;
        runtime.prosperity = clamp01(runtime.prosperity - Math.max(0, finiteOr(rules.gardenLossPenalty, 0.15)));
        ctx.log({ kind: 'garden-lost', gardensLost: runtime.gardensLost });
      }
    }
  } else {
    runtime.dangerSeconds = Math.max(0, runtime.dangerSeconds - elapsedSeconds);
  }

  const plantable = runtime.gardens.filter((entry) => entry.status !== 'lost').length;
  if (plantable === 0 && runtime.gardens.length > 0) {
    runtime.failed = true;
    runtime.failReason = 'gardens-lost';
    ctx.log({ kind: 'failed', reason: 'gardens-lost' });
  }
}

export function evaluate(runtime, ctx) {
  const rules = ctx.mission.rules;
  const duration = Math.max(1, finiteOr(rules.durationSeconds, 150));
  const target = clamp01(finiteOr(rules.prosperityTarget, 0.8));
  const done = !runtime.failed && runtime.elapsed >= duration;

  return {
    objectives: {
      // «گذر از فصل» یعنی شهر با آبادیِ زنده به پایان برسد، نه صفرشدن شاخص.
      season: done && runtime.prosperity > 0.001,
      prosperity: done && runtime.prosperity >= target,
      // ستارهٔ باغ‌ها فقط وقتی معنا دارد که دست‌کم یک باغ کاشته و نگه داشته شده باشد.
      gardens: runtime.gardensLost === 0 && readyCount(runtime.gardens) > 0,
    },
    progress: {
      elapsed: Math.round(runtime.elapsed),
      duration,
      prosperity: Number(runtime.prosperity.toFixed(3)),
      target,
      canals: readyCount(runtime.canals),
      canalTotal: runtime.canals.length,
      gardens: readyCount(runtime.gardens),
      gardenTotal: runtime.gardens.length,
      gardensLost: runtime.gardensLost,
      gratitudeCount: runtime.gratitudeCount,
      danger: runtime.prosperity <= Math.max(0, finiteOr(rules.dangerThreshold, 0.2)),
      dangerSeconds: Math.round(runtime.dangerSeconds),
      neglected: runtime.lastGratitudeAt != null
        ? (ctx.now - runtime.lastGratitudeAt) / 1000 > Math.max(10, finiteOr(rules.neglectSeconds, 45))
        : runtime.elapsed > Math.max(10, finiteOr(rules.neglectSeconds, 45)),
      boosted: runtime.boosted,
    },
    done,
    failed: runtime.failed,
    failReason: runtime.failReason,
  };
}

/** شکرانه، بهرهٔ تولید را مدتی بالا می‌برد؛ باغ و جوی آماده، رشد روزانه می‌دهد. */
export function economyModifiers(runtime, ctx) {
  const rules = ctx.mission.rules;
  if (!runtime.boosted) return { production: {}, consumption: {} };
  const bonus = Math.max(0, finiteOr(rules.gratitudeYieldBonus, 0.25));
  return { production: { rizq: 1 + bonus, nur: 1 + bonus }, consumption: {} };
}

export function actions(runtime, ctx) {
  const gratitude = ctx.actionDef('gratitude') || {};
  const cooldown = Math.max(0, finiteOr(gratitude.cooldownSeconds, finiteOr(ctx.mission.rules.gratitudeCooldownSeconds, 18)));
  const lastUsed = ctx.run.actions.gratitude?.lastUsedAt || 0;
  const left = Math.max(0, cooldown - (ctx.now - lastUsed) / 1000);
  const cost = affordableCost(ctx.economy, gratitude.cost);
  const list = [{
    id: 'gratitude',
    label: gratitude.label || 'شکرانه',
    icon: gratitude.icon || '✿',
    enabled: left <= 0 && cost != null,
    reason: left > 0 ? 'cooldown' : cost == null ? 'resources' : null,
    cooldownRemaining: Math.ceil(left),
    cost: gratitude.cost || {},
    seconds: 0,
  }];

  const addPlotAction = (kind, entries, defId) => {
    const def = ctx.actionDef(defId) || {};
    const plotCost = affordableCost(ctx.economy, def.cost);
    entries.forEach((entry, index) => {
      const globalIndex = (ctx.mission.plots || []).findIndex((plot) => plot.id === entry.id);
      list.push({
        id: defId,
        kind,
        plotId: entry.id,
        plotIndex: globalIndex,
        itemIndex: index,
        status: entry.status,
        label: def.label || defId,
        icon: def.icon || '◇',
        enabled: entry.status === 'empty' && plotCost != null,
        reason: entry.status === 'empty' ? (plotCost == null ? 'resources' : null) : entry.status === 'lost' ? 'lost' : 'in-progress',
        cost: def.cost || {},
        seconds: finiteOr(def.seconds, 8),
      });
    });
  };
  addPlotAction(CANAL_KIND, runtime.canals, 'canal');
  addPlotAction(GARDEN_KIND, runtime.gardens, 'garden');

  return list;
}

export function perform({ runtime, actionId, plotId, plotIndex, ctx }) {
  if (actionId === 'gratitude') {
    const entry = actions(runtime, ctx).find((action) => action.id === 'gratitude');
    if (!entry.enabled) return { ok: false, reason: entry.reason };
    ctx.economy.spend(entry.cost);
    const rules = ctx.mission.rules;
    runtime.prosperity = clamp01(runtime.prosperity + Math.max(0, finiteOr(rules.gratitudeProsperity, 0.12)));
    runtime.gratitudeCount += 1;
    runtime.lastGratitudeAt = ctx.now;
    runtime.boostSeconds = Math.max(0, finiteOr(rules.gratitudeBoostSeconds, 15));
    runtime.boostUntil = ctx.now + runtime.boostSeconds * 1000;
    ctx.markAction('gratitude', ctx.now);
    ctx.log({ kind: 'gratitude', count: runtime.gratitudeCount });
    return { ok: true, cost: entry.cost, label: entry.label, icon: entry.icon, seconds: runtime.boostSeconds };
  }

  if (actionId === 'canal' || actionId === 'garden') {
    const list = actionId === 'canal' ? runtime.canals : runtime.gardens;
    const entry = list.find((item) => item.id === plotId);
    if (!entry) return { ok: false, reason: 'no-plot' };
    if (entry.status !== 'empty') return { ok: false, reason: 'already-built' };
    const def = ctx.actionDef(actionId) || {};
    const cost = affordableCost(ctx.economy, def.cost);
    if (!cost) return { ok: false, reason: 'resources' };
    ctx.economy.spend(cost);
    entry.status = 'building';
    const job = missionJobSpec({
      mission: ctx.mission,
      actionId,
      plotId: entry.id,
      plotIndex: Number.isInteger(Number(plotIndex)) ? Number(plotIndex) : null,
      type: actionId === 'canal' ? 'canal' : 'garden',
      label: def.label,
      icon: def.icon,
      seconds: finiteOr(def.seconds, 8),
    });
    ctx.markAction(actionId, ctx.now);
    return { ok: true, cost, job, reason: null };
  }

  return { ok: false, reason: 'unknown-action' };
}

export function onJobFinished(runtime, job, ctx) {
  const list = job.actionId === 'canal' ? runtime.canals : runtime.gardens;
  const entry = list.find((item) => item.id === job.plotId);
  if (!entry) return { ok: false, reason: 'no-plot' };
  if (entry.status === 'lost') return { ok: false, reason: 'lost' };
  entry.status = 'ready';
  const rules = ctx.mission.rules;
  const bonus = job.actionId === 'canal'
    ? Math.max(0, finiteOr(rules.canalGrowthPerSecond, 0.02))
    : Math.max(0, finiteOr(rules.gardenGrowthPerSecond, 0.012));
  runtime.prosperity = clamp01(runtime.prosperity + bonus * 4);
  ctx.log({ kind: 'built', plot: entry.id });
  return { ok: true, kind: 'built', plotId: entry.id };
}

/** اگر کار به صف نرسید یا مأموریت رها شد، نشانگر به حالت پیشین برمی‌گردد. */
export function rollbackPending(runtime, action = {}, ctx) {
  void ctx;
  const list = action.actionId === 'canal' ? runtime.canals : action.actionId === 'garden' ? runtime.gardens : null;
  if (!list) return false;
  const entry = list.find((item) => item.id === action.plotId);
  if (!entry || entry.status !== 'building') return false;
  entry.status = 'empty';
  return true;
}

export function summary(runtime, ctx) {
  const rules = ctx.mission.rules;
  const duration = Math.max(1, finiteOr(rules.durationSeconds, 150));
  const left = Math.max(0, duration - runtime.elapsed);
  return {
    headline: runtime.failed
      ? 'باغ‌های شهر از دست رفتند'
      : runtime.boosted
        ? 'شکرانهٔ به‌جا — بهرهٔ تولید بالا رفت'
        : `فصل آبادانی — ${Math.ceil(left)} ثانیه مانده`,
    rows: [
      { id: 'prosperity', label: 'آبادانی', value: Math.round(runtime.prosperity * 100), unit: '٪', target: Math.round(clamp01(finiteOr(rules.prosperityTarget, 0.8)) * 100) },
      { id: 'canals', label: 'جوی‌ها', value: readyCount(runtime.canals), target: runtime.canals.length },
      { id: 'gardens', label: 'باغ‌ها', value: readyCount(runtime.gardens), target: runtime.gardens.length },
      { id: 'gratitude', label: 'شکرانه‌ها', value: runtime.gratitudeCount },
    ],
    empty: readyCount(runtime.canals) + readyCount(runtime.gardens) === 0,
  };
}
