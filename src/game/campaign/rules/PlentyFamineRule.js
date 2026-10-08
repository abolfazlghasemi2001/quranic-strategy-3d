/**
 * PlentyFamineRule — مأموریت ۱: انبارداری در سال‌های فراوانی و قحطی.
 *
 * چالش استراتژیک: «ظرفیت ذخیره» و «زمان‌بندی برداشت».
 *   • سال‌های فراوانی: تولید کشتزارها بیشتر می‌شود (×plentyProduction).
 *   • سال‌های تنگ: تولید به‌شدت می‌افتد و شهر هر ثانیه رزق مصرف می‌کند.
 *   • چون در این شهر تولید در سقف انبار می‌ایستد، هر واحد ظرفیت انبار مستقیماً
 *     به «سقف تولید» تبدیل می‌شود — دقیقاً درس انبارداری قصه.
 *
 * این قاعده هیچ متنی از قرآن ندارد و هیچ شمارش تصادفی/شانسی انجام نمی‌دهد؛
 * همهٔ اعداد از `src/data/missions.json` می‌آید.
 *
 * هدف‌ها (سه‌ستاره):
 *   endure      — همهٔ فصل‌ها را بگذران (هدف اصلی)
 *   reserve     — ذخیرهٔ پایان فصل ≥ reserveTarget
 *   neverEmpty  — در قحطی، انبار هرگز به صفر نرسد
 */
import { clamp01, finiteOr } from './shared.js';

export const KIND = 'plenty-famine';
export const OBJECTIVES = ['endure', 'reserve', 'neverEmpty'];
/** کنش‌های موردنیاز این قاعده (باید در missions.json → actions باشند). */
export const ACTIONS = ['harvestAll'];
export const DEFAULT_DRAIN_RESOURCE = 'rizq';

export function createRuntime({ mission }) {
  const rules = mission.rules;
  return {
    kind: KIND,
    elapsed: 0,
    seasonIndex: 0,
    seasonKind: 'plenty',
    seasonElapsed: 0,
    totalSeasons: Math.max(1, Math.floor(finiteOr(rules.plentySeasons, 7)) + Math.max(0, Math.floor(finiteOr(rules.famineSeasons, 7)))),
    plentySeasons: Math.max(1, Math.floor(finiteOr(rules.plentySeasons, 7))),
    famineSeasons: Math.max(0, Math.floor(finiteOr(rules.famineSeasons, 7))),
    famineSeconds: 0,
    zeroed: false,
    minReserve: null,
    reserveAtEnd: null,
    harvests: 0,
    drainTotal: 0,
  };
}

function seasonKindFor(runtime, index) {
  return index < runtime.plentySeasons ? 'plenty' : 'famine';
}

/**
 * مصرف هر ثانیهٔ قحطی = مصرف ثابت + مصرف هر سازهٔ آمادهٔ شهر (سقف‌دار).
 * شهر بزرگ‌تر در سال تنگ، نگهداری بیشتری می‌خواهد؛ عددها از missions.json می‌آید.
 */
function effectiveDrain(rules, ctx) {
  const flat = rules.famineDrainPerSecond || {};
  const perBuilding = rules.famineDrainPerBuilding || {};
  const resources = new Set([...Object.keys(flat), ...Object.keys(perBuilding)]);
  if (!resources.size) return {};
  const cap = Math.max(0, Math.floor(finiteOr(rules.famineDrainMaxBuildings, 24)));
  let buildings = 0;
  for (const entity of ctx.state.entities.values()) {
    if (entity.status === 'ready') buildings += 1;
  }
  buildings = Math.min(buildings, cap);
  const table = {};
  for (const resource of resources) {
    table[resource] = Math.max(0, finiteOr(flat[resource], 0)) + Math.max(0, finiteOr(perBuilding[resource], 0)) * buildings;
  }
  return table;
}

export function tick(runtime, dt, ctx) {
  const rules = ctx.mission.rules;
  const seasonSeconds = Math.max(1, finiteOr(rules.seasonSeconds, 12));
  const drain = effectiveDrain(rules, ctx);
  let remaining = Math.max(0, dt);

  // فصل‌ها را با dt جابه‌جا کن (چند فصل کوچک در یک گام هم درست پیش می‌رود).
  while (remaining > 0 && runtime.seasonIndex < runtime.totalSeasons) {
    const step = Math.min(remaining, seasonSeconds - runtime.seasonElapsed);
    runtime.seasonElapsed += step;
    remaining -= step;
    runtime.elapsed += step;

    if (runtime.seasonKind === 'famine') {
      runtime.famineSeconds += step;
      for (const [resource, perSecond] of Object.entries(drain)) {
        const amount = Math.max(0, Number(perSecond) || 0) * step;
        if (amount <= 0) continue;
        const moved = ctx.economy.drain(resource, amount);
        runtime.drainTotal += moved;
        if (resource === DEFAULT_DRAIN_RESOURCE && (ctx.economy.resources[resource] || 0) <= 0.0001) {
          runtime.zeroed = true;
        }
      }
    }

    const reserve = ctx.economy.resources[DEFAULT_DRAIN_RESOURCE] || 0;
    runtime.minReserve = runtime.minReserve == null ? reserve : Math.min(runtime.minReserve, reserve);

    if (runtime.seasonElapsed >= seasonSeconds - 1e-9) {
      runtime.seasonElapsed = 0;
      runtime.seasonIndex += 1;
      if (runtime.seasonIndex < runtime.totalSeasons) {
        runtime.seasonKind = seasonKindFor(runtime, runtime.seasonIndex);
      } else {
        runtime.reserveAtEnd = reserve;
      }
    }
  }
}

export function evaluate(runtime, ctx) {
  const rules = ctx.mission.rules;
  const reserve = ctx.economy.resources[DEFAULT_DRAIN_RESOURCE] || 0;
  const target = Math.max(0, finiteOr(rules.reserveTarget, 1200));
  const done = runtime.seasonIndex >= runtime.totalSeasons;
  const reserveAtEnd = runtime.reserveAtEnd == null ? reserve : runtime.reserveAtEnd;

  return {
    objectives: {
      endure: done,
      reserve: done && reserveAtEnd >= target,
      neverEmpty: !runtime.zeroed,
    },
    progress: {
      season: Math.min(runtime.seasonIndex + (done ? 0 : 0), runtime.totalSeasons),
      totalSeasons: runtime.totalSeasons,
      seasonKind: runtime.seasonKind,
      seasonSecondsLeft: Math.max(0, Math.max(1, finiteOr(rules.seasonSeconds, 12)) - runtime.seasonElapsed),
      reserve: Math.floor(reserve),
      reserveTarget: target,
      reserveRatio: clamp01(reserve / (target || 1)),
      drainTotal: Math.round(runtime.drainTotal),
      zeroed: runtime.zeroed,
    },
    done,
    failed: false,
    failReason: null,
  };
}

/** تولید در فراوانی بالا و در قحطی پایین می‌رود؛ مصرف را خودِ قاعده اعمال می‌کند. */
export function economyModifiers(runtime, ctx) {
  const rules = ctx.mission.rules;
  const table = runtime.seasonKind === 'famine' ? rules.famineProduction : rules.plentyProduction;
  const production = {};
  for (const [resource, value] of Object.entries(table || {})) {
    const multiplier = Number(value);
    if (Number.isFinite(multiplier) && multiplier >= 0) production[resource] = multiplier;
  }
  return { production, consumption: {} };
}

export function actions(runtime, ctx) {
  const rules = ctx.mission.rules;
  const cooldown = Math.max(0, finiteOr(rules.harvestAllCooldownSeconds, 20));
  const used = runtime.harvests > 0 ? (ctx.run.actions.harvestAll?.lastUsedAt || 0) : 0;
  const left = Math.max(0, cooldown - (ctx.now - used) / 1000);
  const producers = [...ctx.state.entities.values()].filter((entity) => (
    entity.status === 'ready' && entity.pending >= 1 && ctx.economy.rateOf(entity) > 0
  ));
  return [{
    id: 'harvestAll',
    label: ctx.actionDef('harvestAll')?.label || 'برداشت سراسری',
    icon: ctx.actionDef('harvestAll')?.icon || '⟳',
    cost: {},
    enabled: left <= 0 && producers.length > 0,
    reason: left > 0 ? 'cooldown' : producers.length ? null : 'nothing-ready',
    cooldownRemaining: Math.ceil(left),
    available: producers.length,
  }];
}

export function perform({ runtime, actionId, ctx }) {
  if (actionId !== 'harvestAll') return { ok: false, reason: 'unknown-action' };
  const action = actions(runtime, ctx)[0];
  if (!action.enabled) return { ok: false, reason: action.reason || 'blocked' };
  let moved = 0;
  for (const entity of ctx.state.entities.values()) {
    if (entity.status !== 'ready') continue;
    const result = ctx.economy.harvest(entity, ctx.now, { silent: true });
    moved += result.moved;
  }
  runtime.harvests += 1;
  ctx.markAction('harvestAll', ctx.now);
  return { ok: true, moved, label: action.label, icon: action.icon, toast: moved > 0 ? null : 'storage-full' };
}

/** مأموریت هیچ کار بنّایی ندارد. */
export function onJobFinished() {
  return { ok: false, reason: 'no-jobs' };
}

export function summary(runtime, ctx) {
  const total = runtime.totalSeasons;
  const kindLabel = runtime.seasonKind === 'plenty' ? 'سال فراوانی' : 'سال تنگ';
  return {
    headline: `فصل ${Math.min(runtime.seasonIndex + 1, total)} از ${total} — ${kindLabel}`,
    rows: [
      { id: 'reserve', label: 'ذخیرهٔ رزق', value: Math.floor(ctx.economy.resources.rizq || 0), target: Math.max(0, finiteOr(ctx.mission.rules.reserveTarget, 1200)) },
      { id: 'famine', label: 'زمان قحطی', value: Math.round(runtime.famineSeconds), unit: 'ث' },
      { id: 'drain', label: 'مصرف قحطی', value: Math.round(runtime.drainTotal) },
    ],
    empty: runtime.zeroed,
  };
}
