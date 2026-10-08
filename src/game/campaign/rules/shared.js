/**
 * helpers مشترک قاعده‌های مأموریت (فاز ۶).
 *
 * قاعده‌ها هیچ چیزی از UI و Three.js نمی‌شناسند؛ فقط اقتصاد، صف ساخت و زمان.
 * همهٔ توابع «خالصِ ممکن»اند: عدد نامعتبر → مقدار پیش‌فرض، بدون استثنا.
 */

/** عدد متناهی یا مقدار پیش‌فرض (data-driven؛ هیچ NaN به منطق نمی‌رسد). */
export function finiteOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function clamp01(value) {
  const number = finiteOr(value, 0);
  return Math.min(1, Math.max(0, number));
}

/** میانگین یک فهرست عددی (فهرست خالی → ۰). */
export function average(values) {
  const list = (values || []).map((value) => Number(value)).filter((value) => Number.isFinite(value));
  if (!list.length) return 0;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

/**
 * اگر بازیکن توان پرداخت هزینه را دارد، همان هزینه را برمی‌گرداند؛
 * در غیر این صورت null. (کنش‌ها با null یعنی «منابع کافی نیست».)
 */
export function affordableCost(economy, cost) {
  const table = {};
  for (const [resource, value] of Object.entries(cost || {})) {
    const amount = Math.max(0, finiteOr(value, 0));
    if (amount > 0) table[resource] = amount;
  }
  const entries = Object.entries(table);
  if (!entries.length) return {};
  const canPay = entries.every(([resource, amount]) => (Number(economy?.resources?.[resource]) || 0) >= amount);
  return canPay ? table : null;
}

/**
 * ساخت مشخصات کار بنّای مأموریت برای BuildQueue.
 * این تنها جایی است که مأموریت به صف ساخت وصل می‌شود؛ هیچ سازهٔ شهری درگیر نیست.
 */
export function missionJobSpec({ mission, actionId, plotId, plotIndex, type, label, icon, seconds }) {
  const duration = Math.max(0.05, finiteOr(seconds, 1));
  return {
    kind: 'mission',
    entityId: null,
    type: type || `mission:${mission?.id || 'mission'}:${actionId}`,
    targetLevel: 1,
    durationMs: Math.round(duration * 1000),
    missionId: mission?.id || null,
    actionId: actionId || null,
    plotId: plotId ?? null,
    plotIndex: Number.isInteger(plotIndex) ? plotIndex : null,
    label: label || null,
    icon: icon || null,
  };
}
