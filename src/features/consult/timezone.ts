import { budgetQuestions } from "./assessmentConfig";

/**
 * SINGLE source of the time-zone code `tz`, shared by the budget question and the A/B/C routing (Product decision 2026-10-27, same rule as the
 * Zoho Forms Consult form and the Smart Redirector): the browser time zone `Asia/Tehran` is "1" (Toman budget), every other value is "2"
 * (USD budget), and a failure to detect it is "2". The WhatsApp country code plays no part in it.
 */
export type TzCode = "1" | "2";
export type BudgetGroup = "IR" | "INTL";

export const TEHRAN_TIME_ZONE = "Asia/Tehran";

export const tzCodeFromTimeZone = (timeZone: string | undefined | null): TzCode => (timeZone === TEHRAN_TIME_ZONE ? "1" : "2");

/** Reads the browser time zone; any failure (or a non-browser environment) falls back to "2". */
export function detectTzCode(): TzCode {
  try {
    return tzCodeFromTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "2";
  }
}

export const budgetGroupForTz = (tz: TzCode): BudgetGroup => (tz === "1" ? "IR" : "INTL");

export const budgetQuestionForTz = (tz: TzCode) => budgetQuestions[budgetGroupForTz(tz)];

/** True when `value` is one of the options of the budget question shown for `tz`. */
export const isBudgetValueForTz = (tz: TzCode, value: string | null | undefined): boolean =>
  !!value && budgetQuestionForTz(tz).options.some((o) => o.value === value);
