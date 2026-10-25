import {
  UNDER_18_AGE,
  exerciseScreeningTriggers,
  healthFlagByCode,
  sportModuleByKey,
  sportModules,
  sportScoreBands,
  ts03,
  type SafetyOutcome,
} from "./assessmentConfig";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import type { ConsultAnswers, ModuleAnswer, OutcomeResult } from "./types";

/** Score a single sport module in isolation. */
export function scoreModule(moduleKey: string, answer: ModuleAnswer | undefined): number {
  const mod = sportModuleByKey[moduleKey];
  if (!mod || !answer) return 0;
  let score = 0;
  for (const field of mod.fields) {
    if (field.type !== "radio" || !field.options) continue;
    const selected = answer[field.key];
    const option = field.options.find((o) => o.value === selected);
    score += option?.points ?? 0;
  }
  return score;
}

export function moduleBand(score: number): SafetyOutcome {
  if (score >= sportScoreBands.redMin) return "RED_SPECIALIST";
  if (score >= sportScoreBands.yellowMin) return "YELLOW_REVIEW";
  return "GREEN";
}

/**
 * Exercise Safety (TS-01..TS-03 and the sport modules) is only shown for services that unlock it.
 * For a Nutrition-only request the section does not exist: its answers are null/empty, never "no".
 */
export function exerciseSafetyApplies(serviceInterest: readonly string[] | undefined): boolean {
  return (serviceInterest ?? []).some((s) => exerciseScreeningTriggers.includes(s));
}

/**
 * Single definition of "active" sport modules, shared by scoring, red-flag
 * collection and the CRM payload so inactive (stale) answers never leak.
 */
export function getActiveCategories(
  answers: Pick<Partial<ConsultAnswers>, "ts_01_has_limitation" | "ts_02_categories">,
): string[] {
  if (!answers.ts_01_has_limitation || answers.ts_01_has_limitation === "no") return [];
  return [...new Set(answers.ts_02_categories ?? [])];
}

/**
 * TS-03 only exists while TS-01 is active (not "no"). A stale TS-03 value kept
 * after TS-01 goes back to "no" must never influence scoring, flags or payload.
 */
export function getActiveClearance(
  answers: Pick<Partial<ConsultAnswers>, "ts_01_has_limitation" | "ts_03_clearance">,
): string {
  if (!answers.ts_01_has_limitation || answers.ts_01_has_limitation === "no") return "";
  return answers.ts_03_clearance ?? "";
}

const MODULE_TEXT_KEYS = [
  "diagnosis",
  "onset",
  "recovery",
  "pain",
  "reaction",
  "clearance",
  "notes",
] as const;

/** Complete answers of the active sport modules only (empty optional values omitted). */
export function buildActiveModules(
  answers: Pick<Partial<ConsultAnswers>, "ts_01_has_limitation" | "ts_02_categories" | "modules">,
): Record<string, ModuleAnswer> {
  const result: Record<string, ModuleAnswer> = {};
  for (const key of getActiveCategories(answers)) {
    if (!sportModuleByKey[key]) continue;
    const source = answers.modules?.[key] ?? {};
    const entry: ModuleAnswer = {};
    for (const field of MODULE_TEXT_KEYS) {
      const value = source[field];
      if (typeof value === "string" && value.trim() !== "") entry[field] = value.trim();
    }
    entry.red_flags = [...new Set((source.red_flags ?? []).filter((f) => f !== ""))];
    result[key] = entry;
  }
  return result;
}

/** Hard red flags selected inside sport modules, plus the TS-03 training ban. */
export function collectHardRedFlags(answers: Partial<ConsultAnswers>): string[] {
  const flags: string[] = [];
  const banOption = ts03.options.find((o) => o.value === getActiveClearance(answers));
  if (banOption?.hardRedFlag) flags.push("exercise_clearance:training_banned");

  const categories = answers.ts_02_categories ?? [];
  for (const key of categories) {
    const selected = answers.modules?.[key]?.red_flags ?? [];
    for (const flag of selected) flags.push(`${key}:${flag}`);
  }
  return flags;
}

export function evaluateOutcome(answers: Partial<ConsultAnswers>): OutcomeResult {
  const nutrition_red_reasons: string[] = [];
  const nutrition_yellow_reasons: string[] = [];

  const specialist_routing_flags: string[] = [];

  for (const code of answers.health_flags ?? []) {
    const flag = healthFlagByCode[code];
    if (!flag) continue;
    if (flag.severity === "RED") nutrition_red_reasons.push(code);
    if (flag.severity === "YELLOW") nutrition_yellow_reasons.push(code);
    if (flag.severity === "SPECIALIST_ROUTING") specialist_routing_flags.push(code);
  }

  if (typeof answers.age === "number" && answers.age < UNDER_18_AGE) {
    if (!nutrition_red_reasons.includes("age_under_18")) nutrition_red_reasons.push("age_under_18");
  }

  const clearanceOption = ts03.options.find((o) => o.value === getActiveClearance(answers));
  if (clearanceOption?.severity === "YELLOW") {
    nutrition_yellow_reasons.push("TS-03");
  }

  const module_scores: Record<string, number> = {};
  for (const mod of sportModules) module_scores[mod.scoreField] = 0;

  const activeCategories = getActiveCategories(answers);

  let anyModuleRed = false;
  let anyModuleYellow = false;
  for (const key of activeCategories) {
    const mod = sportModuleByKey[key];
    if (!mod) continue;
    const score = scoreModule(key, answers.modules?.[key]);
    module_scores[mod.scoreField] = score;
    const band = moduleBand(score);
    if (band === "RED_SPECIALIST") anyModuleRed = true;
    if (band === "YELLOW_REVIEW") anyModuleYellow = true;
  }

  const hard_red_flags =
    activeCategories.length || getActiveClearance(answers)
      ? collectHardRedFlags({ ...answers, ts_02_categories: activeCategories })
      : [];

  let safety_outcome: SafetyOutcome = "GREEN";
  if (hard_red_flags.length > 0 || nutrition_red_reasons.length > 0 || anyModuleRed) {
    safety_outcome = "RED_SPECIALIST";
  } else if (nutrition_yellow_reasons.length > 0 || anyModuleYellow) {
    safety_outcome = "YELLOW_REVIEW";
  }

  return {
    safety_outcome,
    general_plan_eligible: safety_outcome !== "RED_SPECIALIST",
    review_required: safety_outcome !== "GREEN",
    hard_red_flags,
    module_scores,
    nutrition_red_reasons,
    nutrition_yellow_reasons,
    specialist_routing: specialist_routing_flags.length > 0,
    specialist_routing_flags,
  };
}

export type PhoneRejection =
  | "MISSING_DIAL_CODE"
  | "EMPTY"
  | "INVALID_CHARACTERS"
  | "COUNTRY_CODE_MISMATCH"
  | "LEADING_CALLING_CODE"
  | "INVALID_NUMBER"
  | "TOO_SHORT"
  | "TOO_LONG";

export type PhoneParse =
  | { ok: true; e164: string; national: string; international: boolean }
  | { ok: false; reason: PhoneRejection };

/**
 * Converts Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669) digits to ASCII 0-9; every other character is left
 * unchanged. It is applied before any character validation (form field, parser) so that mixed-script input behaves
 * like ASCII input.
 */
export function toAsciiDigits(value: string): string {
  return Array.from(value, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0); // Persian
    if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660); // Arabic-Indic
    return ch;
  }).join("");
}

/**
 * Phone input contract (DEF-05). `dialCode` is the selected calling code (e.g. "+98").
 * Persian and Arabic-Indic digits are converted to ASCII first (`toAsciiDigits`).
 * Trunk prefixes, significant leading zeros and the general national-number length/pattern check come from
 * libphonenumber-js, the JavaScript port of Google's libphonenumber, using its "min" metadata; no country rules are
 * hand-written. "min" validates length and the general pattern only: it is not exhaustive validation (it can accept
 * unassigned numbers that the "max" metadata would reject, and it does not detect number types).
 *  - Starts with `+` or `00`: explicitly international. The digits must start with the selected calling code
 *    (otherwise COUNTRY_CODE_MISMATCH) and form a valid number.
 *  - Otherwise: a national number for the selected calling code, parsed with libphonenumber's national rules (so the
 *    country's own trunk prefix is handled: Iran 0, Russia 8, UK 0; Italy keeps its 0). If parsing would drop leading
 *    digits equal to the calling code (for example "1 416…" or "91 98765…"), the input is rejected instead of guessed.
 *  - The national part must also be 7-13 digits (the range Onboarding accepts; keeps the prefill compatible).
 * Separators ` ()-` are ignored. Anything unreadable, invalid for the country, or ambiguous is rejected.
 * This does not prove that the number exists or is reachable on WhatsApp.
 */
export function parseWhatsappPhone(dialCode: string, raw: string): PhoneParse {
  const cc = dialCode.replace(/\D/g, "");
  if (!/^\d{1,4}$/.test(cc)) return { ok: false, reason: "MISSING_DIAL_CODE" };
  const compact = toAsciiDigits(raw)
    .trim()
    .replace(/[\s()-]/g, "");
  if (compact === "") return { ok: false, reason: "EMPTY" };

  let international = false;
  let digits = compact;
  if (compact.startsWith("+")) {
    international = true;
    digits = compact.slice(1);
  } else if (compact.startsWith("00")) {
    international = true;
    digits = compact.slice(2);
  }
  if (!/^\d+$/.test(digits)) return { ok: false, reason: "INVALID_CHARACTERS" };

  if (international && !digits.startsWith(cc))
    return { ok: false, reason: "COUNTRY_CODE_MISMATCH" };
  const parsed = international
    ? parsePhoneNumberFromString(`+${digits}`)
    : parsePhoneNumberFromString(digits, { defaultCallingCode: cc });
  if (!parsed || parsed.countryCallingCode !== cc || !parsed.isValid())
    return { ok: false, reason: "INVALID_NUMBER" };

  const national = parsed.nationalNumber;
  if (!international) {
    const removed = digits.slice(0, digits.length - national.length);
    if (!digits.endsWith(national) || removed === cc || removed.length > 2) {
      return { ok: false, reason: "LEADING_CALLING_CODE" };
    }
  }
  if (national.length < 7) return { ok: false, reason: "TOO_SHORT" };
  if (national.length > 13 || cc.length + national.length > 15)
    return { ok: false, reason: "TOO_LONG" };
  return { ok: true, e164: `+${cc}${national}`, national, international };
}

/**
 * E.164 value (`+<calling code><national number>`) used for the WhatsApp number, CRM deduplication and the Onboarding
 * prefill, or "" when the input is invalid or ambiguous (fail closed). The server re-applies it to the stored value.
 */
export function normalizePhone(dialCode: string, raw: string): string {
  const parsed = parseWhatsappPhone(dialCode, raw);
  return parsed.ok ? parsed.e164 : "";
}
