/**
 * DamUpholdRule — مأموریت ۲: ساخت سد در دهانهٔ دره و نگهداری آن.
 *
 * چالش استراتژیک: «هدف ساختاری» + «نگهداری با زمان‌بند بنّاها».
 *   • هر نشانگر دهانهٔ دره یک «بخش سد» است؛ ساخت هر بخش یک کار بنّا در صف ساخت می‌گیرد
 *     (پس ساخت سد با ساخت‌وساز شهر بر سر بنّاها رقابت می‌کند).
 *   • هر «موج» به بخش‌های ساخته‌شده آسیب می‌زند؛ بخش آسیب‌دیده نشتی می‌دهد و آسیب
 *     موج‌های بعدی را چند برابر می‌کند.
 *   • تا بخشی ساخته نشده باشد، موج‌ها آب را از دهانه جلو می‌برند؛ اگر جبههٔ آب به ۱ برسد
 *     مأموریت شکست می‌خورد (بدون هیچ خسارت به شهر و بدون صحنهٔ خشن).
 *
 * هیچ واحدی، هیچ سلاحی و هیچ خشونتی در این مأموریت نیست؛ «حریف» آب و فشار زمان است.
 * همهٔ اعداد از `src/data/missions.json` می‌آید.
 *
 * هدف‌ها:
 *   defend     — دهانه بسته شود و سد چند موج را تاب بیاورد (هدف اصلی)
 *   integrity  — میانگین سلامت سد در پایان ≥ avgIntegrityTarget
 *   noBreach   — هیچ بخشی تا آستانهٔ فروپاشی نرسد
 */
import { affordableCost, average, finiteOr, missionJobSpec } from './shared.js';

export const KIND = 'dam-uphold';
export const OBJECTIVES = ['defend', 'integrity', 'noBreach'];
/** کنش‌های موردنیاز این قاعده (باید در missions.json → actions باشند). */
export const ACTIONS = ['build', 'repair'];
const PLOT_KIND = 'dam-segment';

export function createRuntime({ mission }) {
  const segments = (mission.plots || [])
    .filter((plot) => plot.kind === PLOT_KIND)
    .map((plot) => ({
      id: plot.id,
      status: 'empty', // empty | building | ready
      integrity: 0,
      leaks: false,
    }));
  return {
    kind: KIND,
    elapsed: 0,
    segments,
    waves: 0,
    nextWaveIn: Math.max(1, finiteOr(mission.rules.waveEverySeconds, 20)),
    waveTimer: Math.max(1, finiteOr(mission.rules.waveEverySeconds, 20)),
    flood: 0,
    breaches: 0,
    repairs: 0,
    // نشانگرهایی که کار تعمیرشان در صف/دست بنّاست (جلوگیری از تعمیر تکراری).
    inFlight: {},
    damageTaken: 0,
    minIntegrityEver: null,
    failed: false,
    failReason: null,
  };
}

function missingCount(runtime) {
  return runtime.segments.filter((segment) => segment.status !== 'ready').length;
}

function builtSegments(runtime) {
  return runtime.segments.filter((segment) => segment.status === 'ready');
}

function applyWave(runtime, ctx) {
  const rules = ctx.mission.rules;
  const damage = Math.max(0, finiteOr(rules.waveDamage, 0.16));
  const gapMultiplier = Math.max(1, finiteOr(rules.gapDamageMultiplier, 1.5));
  const leakMultiplier = Math.max(1, finiteOr(rules.leakDamageMultiplier, 1.6));
  const missing = missingCount(runtime);
  runtime.waves += 1;

  for (const segment of runtime.segments) {
    if (segment.status !== 'ready') continue;
    let loss = damage;
    if (missing > 0) loss *= gapMultiplier;
    if (segment.leaks) loss *= leakMultiplier;
    const before = segment.integrity;
    segment.integrity = Math.max(0, segment.integrity - loss);
    runtime.damageTaken += before - segment.integrity;
    segment.leaks = segment.integrity > 0 && segment.integrity < Math.max(0, finiteOr(rules.leakThreshold, 0.5));
    if (segment.integrity <= 0) {
      // بخش از کار می‌افتد (نه «تخریب» با صحنهٔ خشن): دیوار می‌شکند و آب رد می‌شود.
      runtime.breaches += 1;
      segment.leaks = true;
    }
  }

  const minNow = runtime.segments.every((segment) => segment.status !== 'ready')
    ? 1
    : Math.min(...runtime.segments.filter((s) => s.status === 'ready').map((s) => s.integrity));
  runtime.minIntegrityEver = runtime.minIntegrityEver == null
    ? minNow
    : Math.min(runtime.minIntegrityEver, minNow);

  if (missing > 0) {
    runtime.flood = Math.min(1, runtime.flood + Math.max(0, finiteOr(rules.floodPerGapWave, 0.09)) * missing);
  }
  ctx.log({ kind: 'wave', wave: runtime.waves, missing, flood: runtime.flood, breaches: runtime.breaches });
}

export function tick(runtime, dt, ctx) {
  if (runtime.failed) return;
  const rules = ctx.mission.rules;
  const damageStart = Math.max(0, finiteOr(rules.damageStartsAfterSeconds, 8));
  runtime.elapsed += dt;

  if (runtime.elapsed >= damageStart) {
    runtime.waveTimer -= dt;
    while (runtime.waveTimer <= 0 && !runtime.failed) {
      applyWave(runtime, ctx);
      runtime.waveTimer += Math.max(1, finiteOr(rules.waveEverySeconds, 20));
      runtime.nextWaveIn = runtime.waveTimer;
      if (runtime.flood >= 1) {
        runtime.failed = true;
        runtime.failReason = 'flood';
        ctx.log({ kind: 'failed', reason: 'flood' });
      }
    }
  } else {
    runtime.nextWaveIn = Math.max(0, damageStart - runtime.elapsed);
  }

  // آبِ پشت سد وقتی همهٔ بخش‌ها بسته‌اند آرام عقب می‌نشیند.
  if (missingCount(runtime) === 0 && runtime.flood > 0 && !runtime.failed) {
    runtime.flood = Math.max(0, runtime.flood - Math.max(0, finiteOr(rules.floodRecoverPerSecond, 0.02)) * dt);
  }

}

export function evaluate(runtime, ctx) {
  const rules = ctx.mission.rules;
  const required = Math.max(1, Math.floor(finiteOr(rules.requiredWaves, 4)));
  const total = runtime.segments.length;
  const built = builtSegments(runtime);
  const complete = built.length === total;
  const done = !runtime.failed && complete && runtime.waves >= required;
  const integrityFloor = Math.max(0, finiteOr(rules.integrityFloorForStar, 0.25));
  const avgTarget = Math.max(0, finiteOr(rules.avgIntegrityTarget, 0.7));
  const avg = complete ? average(built.map((segment) => segment.integrity)) : 0;

  return {
    objectives: {
      defend: done,
      integrity: done && avg >= avgTarget,
      noBreach: runtime.breaches === 0,
    },
    progress: {
      built: built.length,
      total,
      waves: runtime.waves,
      requiredWaves: required,
      flood: Number(runtime.flood.toFixed(3)),
      avgIntegrity: Number(avg.toFixed(3)),
      integrityFloor,
      breaches: runtime.breaches,
      nextWaveIn: Math.max(0, Math.round(runtime.nextWaveIn)),
    },
    done,
    failed: runtime.failed,
    failReason: runtime.failReason,
  };
}

export function economyModifiers() {
  return { production: {}, consumption: {} };
}

function segmentIndexById(runtime, plotId) {
  return runtime.segments.findIndex((segment) => segment.id === plotId);
}

export function actions(runtime, ctx) {
  const build = ctx.actionDef('build') || {};
  const repair = ctx.actionDef('repair') || {};
  const buildCost = affordableCost(ctx.economy, build.cost);
  const repairCost = affordableCost(ctx.economy, repair.cost);

  return runtime.segments.map((segment, index) => {
    if (segment.status === 'building') {
      return {
        id: 'build',
        plotIndex: index,
        plotId: segment.id,
        status: 'building',
        label: build.label || 'ساخت بخش سد',
        icon: build.icon || '⛰',
        enabled: false,
        reason: 'in-progress',
        cost: build.cost || {},
        seconds: finiteOr(build.seconds, 14),
      };
    }
    if (segment.status === 'empty') {
      return {
        id: 'build',
        plotIndex: index,
        plotId: segment.id,
        status: 'empty',
        label: build.label || 'ساخت بخش سد',
        icon: build.icon || '⛰',
        enabled: buildCost != null,
        reason: buildCost == null ? 'resources' : null,
        cost: build.cost || {},
        seconds: finiteOr(build.seconds, 14),
      };
    }
    const needsRepair = segment.integrity < 0.995;
    const repairing = runtime.inFlight?.[segment.id] === 'repair';
    return {
      id: 'repair',
      plotIndex: index,
      plotId: segment.id,
      status: segment.status,
      label: repair.label || 'نگهداری بخش سد',
      icon: repair.icon || '🛠',
      enabled: !repairing && needsRepair && repairCost != null,
      reason: repairing ? 'in-progress' : !needsRepair ? 'healthy' : 'resources',
      integrity: Number(segment.integrity.toFixed(3)),
      leaks: segment.leaks,
      cost: repair.cost || {},
      seconds: finiteOr(repair.seconds, 7),
    };
  });
}

export function perform({ runtime, actionId, plotIndex, ctx }) {
  const index = Number(plotIndex);
  if (!Number.isInteger(index) || index < 0 || index >= runtime.segments.length) {
    return { ok: false, reason: 'no-plot' };
  }
  const segment = runtime.segments[index];
  const def = ctx.actionDef(actionId) || {};
  const cost = affordableCost(ctx.economy, def.cost);
  if (!cost) return { ok: false, reason: 'resources' };

  if (actionId === 'build') {
    if (segment.status !== 'empty') return { ok: false, reason: 'already-built' };
    ctx.economy.spend(cost);
    segment.status = 'building';
    const job = missionJobSpec({
      mission: ctx.mission,
      actionId: 'build',
      plotId: segment.id,
      plotIndex: index,
      type: 'dam-segment',
      label: def.label,
      icon: def.icon,
      seconds: finiteOr(def.seconds, 14),
    });
    ctx.markAction('build', ctx.now);
    return { ok: true, cost, job, reason: null };
  }

  if (actionId === 'repair') {
    if (segment.status !== 'ready') return { ok: false, reason: 'not-built' };
    if (segment.integrity >= 0.995) return { ok: false, reason: 'healthy' };
    if (runtime.inFlight?.[segment.id] === 'repair') return { ok: false, reason: 'in-progress' };
    ctx.economy.spend(cost);
    runtime.inFlight = runtime.inFlight || {};
    runtime.inFlight[segment.id] = 'repair';
    const job = missionJobSpec({
      mission: ctx.mission,
      actionId: 'repair',
      plotId: segment.id,
      plotIndex: index,
      type: 'dam-repair',
      label: def.label,
      icon: def.icon,
      seconds: finiteOr(def.seconds, 7),
    });
    ctx.markAction('repair', ctx.now);
    return { ok: true, cost, job, reason: null };
  }

  return { ok: false, reason: 'unknown-action' };
}

/** پایان کار بنّا: بخش سد آماده می‌شود یا سلامت آن بالا می‌رود. */
export function onJobFinished(runtime, job, ctx) {
  const index = segmentIndexById(runtime, job.plotId);
  if (index < 0) return { ok: false, reason: 'no-plot' };
  const segment = runtime.segments[index];
  if (runtime.inFlight) delete runtime.inFlight[job.plotId];
  if (job.actionId === 'build') {
    segment.status = 'ready';
    segment.integrity = 1;
    segment.leaks = false;
    ctx.log({ kind: 'built', plot: segment.id });
    return { ok: true, kind: 'built', plotId: segment.id, plotIndex: index };
  }
  if (job.actionId === 'repair') {
    const amount = Math.max(0, finiteOr(ctx.mission.rules.repairAmount ?? (ctx.mission.actions.repair || {}).amount, 0.34));
    segment.integrity = Math.min(1, segment.integrity + amount);
    segment.leaks = segment.integrity < Math.max(0, finiteOr(ctx.mission.rules.leakThreshold, 0.5));
    runtime.repairs += 1;
    ctx.log({ kind: 'repaired', plot: segment.id, integrity: Number(segment.integrity.toFixed(3)) });
    return { ok: true, kind: 'repaired', plotId: segment.id, plotIndex: index, integrity: segment.integrity };
  }
  return { ok: false, reason: 'unknown-action' };
}

/** اگر کار به صف نرسید یا مأموریت رها شد، نشانگر به حالت پیشین برمی‌گردد. */
export function rollbackPending(runtime, action = {}, ctx) {
  void ctx;
  const index = segmentIndexById(runtime, action.plotId);
  if (index < 0) return false;
  const segment = runtime.segments[index];
  if (runtime.inFlight) delete runtime.inFlight[action.plotId];
  if (segment.status === 'building') {
    segment.status = 'empty';
    segment.integrity = 0;
    return true;
  }
  return false;
}

export function summary(runtime, ctx) {
  const rules = ctx.mission.rules;
  const built = builtSegments(runtime);
  const missing = missingCount(runtime);
  return {
    headline: runtime.failed
      ? 'آب از دهانه گذشت'
      : missing > 0
        ? `بستن دهانه: ${built.length} از ${runtime.segments.length}`
        : `سد کامل است — موج ${runtime.waves} از ${Math.max(1, Math.floor(finiteOr(rules.requiredWaves, 4)))}`,
    rows: [
      { id: 'flood', label: 'جبههٔ آب', value: Math.round(runtime.flood * 100), unit: '٪' },
      { id: 'waves', label: 'موج‌ها', value: runtime.waves },
      { id: 'breach', label: 'بخش‌های ازکارافتاده', value: runtime.breaches },
    ],
    empty: missing === runtime.segments.length,
  };
}
