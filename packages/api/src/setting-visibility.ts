import type { SettingCondition, SettingSchema, SettingValue } from "./t3.js";

/** True when the condition holds for the current values (`get` returns the value of a key). */
export function conditionHolds(condition: SettingCondition, get: (key: string) => SettingValue | undefined): boolean {
  const value = get(condition.key);
  if (condition.in !== undefined) return condition.in.includes(value as SettingValue);
  if (condition.equals !== undefined) return value === condition.equals;
  return true;
}

/** True when a setting row should be shown: no `showWhen`, or its condition holds. */
export function settingVisible(schema: Pick<SettingSchema, "showWhen">, get: (key: string) => SettingValue | undefined): boolean {
  return !schema.showWhen || conditionHolds(schema.showWhen, get);
}
