/**
 * BattleRecorder — ضبط و بازپخش نبرد (منطق خالص).
 *
 * یک ضبط، تنها سه چیز است:
 *   ۱) آرایش کامل نبرد (scenario: سازه‌ها، موج‌ها، سپاه، بذر)
 *   ۲) فهرست دستورهای بازیکن که هر کدام شمارهٔ گام (tick) دارند
 *   ۳) چک‌سام‌های وضعیت در گام‌های مشخص
 *
 * بازپخش = اجرای دوبارهٔ همان آرایش با همان دستورها. اگر همهٔ چک‌سام‌ها یکی
 * باشند، نبرد مو‌به‌مو همان چیز است؛ این همان چیزی است که سرور می‌تواند
 * مستقل از کلاینت بازتولید و اعتبارسنجی کند.
 *
 * ضبط هیچ متن قرآنی، هیچ نام کاربر و هیچ دادهٔ حساسی ندارد — فقط اعداد و
 * شناسه‌های درون‌بازی.
 */
import { BattleSim } from './BattleSim.js';

export const RECORD_VERSION = 1;

/**
 * @param {object} options
 * @param {object} options.scenario — آرایش نبرد (خروجی BattleScenario)
 * @param {import('./BattleSim.js').BattleSim} options.sim — شبیه‌ساز اجراشده
 * @param {string} options.encounterId
 * @param {number} [options.createdAt] — مهر زمانی (فقط برای نمایش؛ در منطق بی‌اثر است)
 * @returns {object} record (plain JSON)
 */
export function createRecord({ scenario, sim, encounterId, createdAt = 0 }) {
  return {
    version: RECORD_VERSION,
    encounterId,
    seed: scenario.seed,
    scenarioHash: scenario.scenarioHash,
    scenario: {
      ...scenario,
      // دستورها جدا از آرایش نگه داشته می‌شوند تا بازپخش بتواند آن‌ها را
      // در همان گام‌ها دوباره اعمال کند.
      commands: undefined,
    },
    commands: sim.appliedCommands.map((command) => ({ ...command })),
    checkpoints: sim.checkpoints.map((cp) => ({ ...cp })),
    result: sim.result,
    ticks: sim.finishTick || sim.tickIndex,
    stepHz: sim.stepHz,
    report: sim.report(),
    createdAt,
  };
}

/**
 * بازپخش یک ضبط و مقایسهٔ نتیجه با نتیجهٔ ثبت‌شده.
 * @param {object} record
 * @param {object} deps — { rules, units, defenseDefs, structureModifiers }
 * @returns {{ok:boolean, result:string, ticks:number, sim:object,
 *            mismatches:Array<{kind:string, at?:number, expected?:any, got?:any}>,
 *            report:object}}
 */
export function replayRecord(record, { rules, units, defenseDefs, structureModifiers }) {
  const scenario = { ...record.scenario, commands: record.commands, scenarioHash: record.scenarioHash };
  const sim = new BattleSim({ scenario, rules, units, defenseDefs, structureModifiers });
  const maxTicks = record.ticks > 0 ? record.ticks + 1 : (rules.sim.maxTicks ?? 6000);
  sim.runToEnd(maxTicks);

  const mismatches = [];
  if (sim.result !== record.result) {
    mismatches.push({ kind: 'result', expected: record.result, got: sim.result });
  }
  if ((sim.finishTick || sim.tickIndex) !== record.ticks) {
    mismatches.push({ kind: 'ticks', expected: record.ticks, got: sim.finishTick || sim.tickIndex });
  }
  if (sim.hashState() !== record.report.stateHash) {
    mismatches.push({ kind: 'state-hash', expected: record.report.stateHash, got: sim.hashState() });
  }
  if ((sim.eventHash >>> 0) !== (record.report.eventHash >>> 0)) {
    mismatches.push({ kind: 'event-hash', expected: record.report.eventHash, got: sim.eventHash >>> 0 });
  }
  const byTick = new Map(sim.checkpoints.map((cp) => [cp.tick, cp.hash]));
  for (const checkpoint of record.checkpoints || []) {
    const got = byTick.get(checkpoint.tick);
    if (got !== checkpoint.hash) {
      mismatches.push({ kind: 'checkpoint', at: checkpoint.tick, expected: checkpoint.hash, got: got ?? null });
      break;
    }
  }
  return { ok: mismatches.length === 0, result: sim.result, ticks: sim.finishTick || sim.tickIndex, mismatches, sim, report: sim.report() };
}

/**
 * اعتبارسنجی سبک سرور: فقط با آرایش + بذر + دستورها.
 * (همان چیزی که یک سرور بی‌نیاز به رندر می‌تواند اجرا کند.)
 */
export function verifySubmission(submission, deps) {
  if (!submission || !submission.scenario || !Array.isArray(submission.commands)) {
    return { ok: false, mismatches: [{ kind: 'shape' }] };
  }
  const scenario = { ...submission.scenario, commands: submission.commands, scenarioHash: submission.scenarioHash };
  const sim = new BattleSim({ scenario, rules: deps.rules, units: deps.units, defenseDefs: deps.defenseDefs, structureModifiers: deps.structureModifiers });
  sim.runToEnd(submission.ticks ? submission.ticks + 1 : (deps.rules.sim.maxTicks ?? 6000));
  const mismatches = [];
  if (submission.result != null && sim.result !== submission.result) mismatches.push({ kind: 'result' });
  if (submission.stateHash != null && sim.hashState() !== submission.stateHash) mismatches.push({ kind: 'state-hash' });
  return { ok: mismatches.length === 0, result: sim.result, report: sim.report(), mismatches };
}

/** خلاصهٔ قابل‌نمایش یک ضبط (برای پنل نبرد). */
export function recordSummary(record, config) {
  if (!record) return null;
  const resultKey = `battle.${record.result}`;
  return {
    encounterId: record.encounterId,
    result: record.result,
    resultLabel: config?.t(resultKey, record.result) || record.result,
    seed: record.seed,
    ticks: record.ticks,
    seconds: record.report ? record.report.seconds : Math.round((record.ticks / (record.stepHz || 20)) * 10) / 10,
    commands: record.commands.length,
    checkpoints: record.checkpoints.length,
    scenarioHash: record.scenarioHash,
    stateHash: record.report ? record.report.stateHash : 0,
    createdAt: record.createdAt,
  };
}
