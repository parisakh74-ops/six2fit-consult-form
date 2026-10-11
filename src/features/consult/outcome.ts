import {
  UNDER_18_AGE,
  healthFlagByCode,
  sportModuleByKey,
  sportModules,
  sportScoreBands,
  ts03,
  type SafetyOutcome,
} from "./assessmentConfig";
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

/** Hard red flags selected inside sport modules, plus the TS-03 training ban. */
export function collectHardRedFlags(answers: Partial<ConsultAnswers>): string[] {
  const flags: string[] = [];
  const banOption = ts03.options.find((o) => o.value === answers.ts_03_clearance);
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

  const clearanceOption = ts03.options.find((o) => o.value === answers.ts_03_clearance);
  if (clearanceOption?.severity === "YELLOW") {
    nutrition_yellow_reasons.push("TS-03");
  }

  const module_scores: Record<string, number> = {};
  for (const mod of sportModules) module_scores[mod.scoreField] = 0;

  const activeCategories =
    answers.ts_01_has_limitation && answers.ts_01_has_limitation !== "no"
      ? (answers.ts_02_categories ?? [])
      : [];

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
    activeCategories.length || answers.ts_03_clearance
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

/** Digits-only E.164-style normalization used for CRM deduplication. */
export function normalizePhone(dialCode: string, raw: string): string {
  const cc = dialCode.replace(/\D/g, "");
  let local = raw.replace(/[^\d]/g, "");
  local = local.replace(/^0+/, "");
  if (cc && local.startsWith(cc)) local = local.slice(cc.length);
  return `+${cc}${local}`;
}
