/**
 * rules/index.js — فهرست قواعد مأموریت‌ها (registry).
 *
 * هر قاعده یک قرارداد ثابت دارد تا CampaignSystem بدون دانستن جزئیات کار کند:
 *
 *   KIND                     شناسهٔ قاعده (در missions.json → rules.kind)
 *   OBJECTIVES               شناسهٔ هدف‌های مجاز (در missions.json → objectives[].id)
 *   createRuntime({mission}) ساخت وضعیت اجرا (JSON-able)
 *   tick(runtime, dt, ctx)   پیش‌بردن زمان مأموریت
 *   evaluate(runtime, ctx)   → { objectives, progress, done, failed, failReason }
 *   economyModifiers(...)    → { production, consumption } برای اقتصاد شهر
 *   actions(runtime, ctx)    → کنش‌های مجاز با هزینه/دلیل غیرفعالی
 *   perform({...})           → اجرای کنش (ممکن است کار بنّا برگرداند)
 *   onJobFinished(runtime, job, ctx)
 *   summary(runtime, ctx)    → متن کوتاه وضعیت برای رابط کاربری
 */
import * as PlentyFamineRule from './PlentyFamineRule.js';
import * as DamUpholdRule from './DamUpholdRule.js';
import * as ProsperityRule from './ProsperityRule.js';

export { PlentyFamineRule, DamUpholdRule, ProsperityRule };

export const MISSION_RULES = Object.freeze({
  [PlentyFamineRule.KIND]: PlentyFamineRule,
  [DamUpholdRule.KIND]: DamUpholdRule,
  [ProsperityRule.KIND]: ProsperityRule,
});

export function getRuleModule(kind) {
  return MISSION_RULES[kind] || null;
}

export function ruleKinds() {
  return Object.keys(MISSION_RULES);
}

export function objectiveIdsFor(kind) {
  return MISSION_RULES[kind]?.OBJECTIVES || [];
}
