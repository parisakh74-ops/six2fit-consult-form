import { z } from "zod";
import {
  CONSENT_VERSION,
  FORM_VERSION,
  allHealthFlags,
  budgetQuestions,
  consultChannelOptions,
  countries,
  limits,
  outcomeCopy,
  primaryGoalOptions,
  adherenceBarrierOptions,
  readinessQuestion,
  serviceInterestOptions,
  sexQuestion,
  sportModuleByKey,
  sportModules,
  ts01,
  ts03,
} from "../../features/consult/assessmentConfig";
import { evaluateOutcome, getActiveCategories, normalizePhone } from "../../features/consult/outcome";
import type { ConsultAnswers, ConsultPayload } from "../../features/consult/types";
import type { ValidationIssue } from "./contract";
import { SUBMISSION_ID_PATTERN } from "./contract";

const values = (options: ReadonlyArray<{ value: string }>) => options.map((o) => o.value);
const enumOf = (options: ReadonlyArray<{ value: string }>) => {
  const list = values(options);
  return z.enum(list as [string, ...string[]]);
};
const uniqueArray = <T extends z.ZodTypeAny>(item: T) =>
  z.array(item).refine((a) => new Set(a).size === a.length, { message: "DUPLICATE_VALUES" });

const HEALTH_CODES = allHealthFlags.map((f) => f.code);
const MODULE_KEYS = sportModules.map((m) => m.key);
const DIAL_CODES = [...new Set(countries.map((c) => c.dial))];
const ISO_CODES = countries.map((c) => c.iso);
const SCORE_KEYS = sportModules.map((m) => m.scoreField);
const MODULE_FIELD_KEYS = ["diagnosis", "onset", "recovery", "pain", "reaction", "clearance", "notes", "red_flags"];

const text = (max: number) => z.string().max(max);
const bounded = (min: number, max: number) => z.number().finite().min(min).max(max);
const nullableText = (max: number) => z.union([z.string().max(max), z.null()]);

/** Per-module answer schema (options differ per module). */
function moduleSchema(key: string) {
  const mod = sportModuleByKey[key];
  if (!mod) throw new Error("UNKNOWN_MODULE");
  const optionsOf = (field: string) => {
    const f = mod.fields.find((x) => x.key === field);
    return enumOf((f?.options ?? []) as ReadonlyArray<{ value: string }>);
  };
  return z
    .object({
      diagnosis: z.string().min(1).max(200),
      onset: optionsOf("onset"),
      recovery: optionsOf("recovery"),
      pain: optionsOf("pain"),
      reaction: optionsOf("reaction"),
      clearance: optionsOf("clearance"),
      notes: z.string().min(1).max(1000).optional(),
      red_flags: uniqueArray(z.enum(values(mod.hardRedFlags) as [string, ...string[]])),
    })
    .strict();
}

const healthFlagsShape = Object.fromEntries(HEALTH_CODES.map((c) => [c, z.boolean()]));
const scoreShape = Object.fromEntries(SCORE_KEYS.map((k) => [k, z.number().int().min(0).max(1000)]));

const countryEnum = z.enum(ISO_CODES as [string, ...string[]]);
const budgetValues = [...values(budgetQuestions.IR.options), ...values(budgetQuestions.INTL.options)];

const baseSchema = z
  .object({
    submission_id: z.string().regex(SUBMISSION_ID_PATTERN),
    form_version: z.literal(FORM_VERSION),
    submitted_at: z.string().datetime(),

    lead_full_name: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[\p{L}\p{M}‌\s'.-]+$/u),
    whatsapp_phone_normalized: z.string().regex(/^\+\d{7,15}$/),
    whatsapp_dial_code: z.enum(DIAL_CODES as [string, ...string[]]),
    whatsapp_country: z.union([countryEnum, z.literal(""), z.null()]),
    email: z.union([z.string().max(120).email(), z.null()]),
    consult_channel: enumOf(consultChannelOptions),

    primary_goal: uniqueArray(enumOf(primaryGoalOptions)).refine((a) => a.length >= 1, { message: "REQUIRED" }),
    adherence_barrier: uniqueArray(enumOf(adherenceBarrierOptions)),
    adherence_barrier_other: nullableText(500),
    age: bounded(limits.age.min, limits.age.max),
    height_cm: bounded(limits.height_cm.min, limits.height_cm.max),
    weight_kg: bounded(limits.weight_kg.min, limits.weight_kg.max),
    sex: enumOf(sexQuestion.options),
    service_interest: uniqueArray(enumOf(serviceInterestOptions)).refine((a) => a.length >= 1, { message: "REQUIRED" }),

    health_flags: z.object(healthFlagsShape).strict(),
    health_flags_selected: uniqueArray(z.enum(HEALTH_CODES as [string, ...string[]])),
    specialist_routing: z.boolean(),
    specialist_routing_flags: uniqueArray(z.string().max(60)),
    blocker_details: nullableText(500),

    exercise_limitation: enumOf(ts01.options),
    exercise_clearance: z.union([enumOf(ts03.options), z.literal(""), z.null()]),
    sport_categories: uniqueArray(z.enum(MODULE_KEYS as [string, ...string[]])),
    modules: z.record(z.unknown()),
    module_scores: z.object(scoreShape).strict(),
    hard_red_flags: z.array(z.string().max(80)).max(100),
    nutrition_red_reasons: z.array(z.string().max(60)).max(30),
    nutrition_yellow_reasons: z.array(z.string().max(60)).max(30),

    safety_outcome: z.enum(["GREEN", "YELLOW_REVIEW", "RED_SPECIALIST"]),
    general_plan_eligible: z.boolean(),
    review_required: z.boolean(),
    crm_status: z.string().max(60),

    currency_route_source: z.literal("whatsapp_dial_code"),
    budget_currency: z.enum(["IRT", "USD"]),
    budget_range: z.enum(budgetValues as [string, ...string[]]),
    readiness_level: enumOf(readinessQuestion.options),

    preferred_contact_timezone: nullableText(80),
    onboarding_prefill: z
      .object({
        "ON-01": z.string(),
        "ON-03": z.union([z.string(), z.null()]),
        "ON-06.iso": z.union([z.string(), z.null()]),
        "ON-06.cc": z.string(),
        "ON-06.n": z.string(),
        "ON-07": z.union([z.string(), z.null()]),
        "ON-08": z.union([z.number(), z.null()]),
        "ON-09.kg": z.union([z.number(), z.null()]),
        timezone: z.union([z.string(), z.null()]),
      })
      .strict(),

    consent_version: z.literal(CONSENT_VERSION),
    consent_processing: z.literal(true),
    consent_accuracy: z.literal(true),

    utm_source: nullableText(120),
    utm_campaign: nullableText(120),
    instagram_id: nullableText(120),
    manychat_id: nullableText(120),
    landing_page: nullableText(300),
  })
  .strict();

export type ValidationResult =
  | { ok: true; payload: ConsultPayload }
  | { ok: false; kind: "INVALID_PAYLOAD" | "OUTCOME_MISMATCH"; issues: ValidationIssue[] };

function zodCode(issue: z.ZodIssue): string {
  switch (issue.code) {
    case "unrecognized_keys":
      return "UNEXPECTED_FIELD";
    case "invalid_type":
      return issue.received === "undefined" ? "REQUIRED" : "INVALID_TYPE";
    case "invalid_enum_value":
    case "invalid_literal":
    case "invalid_union":
      return "INVALID_VALUE";
    case "too_big":
      return "TOO_LONG_OR_LARGE";
    case "too_small":
      return "TOO_SHORT_OR_SMALL";
    case "invalid_string":
      return "INVALID_FORMAT";
    case "custom":
      return issue.message === "DUPLICATE_VALUES" || issue.message === "REQUIRED" ? issue.message : "INVALID_VALUE";
    default:
      return "INVALID_VALUE";
  }
}

function toIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) out.push({ path: [...issue.path, key].join("."), code: "UNEXPECTED_FIELD" });
    } else if (issue.code === "invalid_union") {
      out.push({ path: issue.path.join("."), code: "INVALID_VALUE" });
    } else {
      out.push({ path: issue.path.join("."), code: zodCode(issue) });
    }
  }
  return out.slice(0, 50);
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Cross-field rules that mirror the browser form (conditionals) and internal consistency. */
function semanticIssues(p: z.infer<typeof baseSchema>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });

  const selected = HEALTH_CODES.filter((c) => (p.health_flags as Record<string, boolean>)[c] === true);
  if (!sameSet(selected, p.health_flags_selected)) add("health_flags_selected", "INCONSISTENT");
  if (selected.length > 0 && !(p.blocker_details ?? "").trim()) add("blocker_details", "REQUIRED");
  if (p.adherence_barrier.includes("other") && !(p.adherence_barrier_other ?? "").trim()) {
    add("adherence_barrier_other", "REQUIRED");
  }
  if (!p.adherence_barrier.includes("other") && p.adherence_barrier_other !== null) {
    add("adherence_barrier_other", "UNEXPECTED_FIELD");
  }

  if (p.exercise_limitation === "no") {
    if (p.sport_categories.length > 0) add("sport_categories", "INCONSISTENT");
    if (Object.keys(p.modules).length > 0) add("modules", "INCONSISTENT");
    if (p.exercise_clearance) add("exercise_clearance", "INCONSISTENT");
  } else {
    if (p.sport_categories.length === 0) add("sport_categories", "REQUIRED");
    if (!p.exercise_clearance) add("exercise_clearance", "REQUIRED");
  }

  // Phone / country / currency consistency
  if (!p.whatsapp_phone_normalized.startsWith(p.whatsapp_dial_code)) add("whatsapp_phone_normalized", "INCONSISTENT");
  if (p.whatsapp_country) {
    const country = countries.find((c) => c.iso === p.whatsapp_country);
    if (country && country.dial !== p.whatsapp_dial_code) add("whatsapp_country", "INCONSISTENT");
  }
  const isIran = p.whatsapp_dial_code === "+98";
  if (p.budget_currency !== (isIran ? budgetQuestions.IR.currency : budgetQuestions.INTL.currency)) {
    add("budget_currency", "INCONSISTENT");
  }
  const allowedBudget = values((isIran ? budgetQuestions.IR : budgetQuestions.INTL).options);
  if (!allowedBudget.includes(p.budget_range)) add("budget_range", "INVALID_VALUE");

  // Prefill block must be a faithful copy of the answers
  const prefill = p.onboarding_prefill;
  const timezone = p.preferred_contact_timezone;
  const expected: Record<string, unknown> = {
    "ON-01": p.lead_full_name,
    "ON-03": p.sex,
    "ON-06.iso": p.whatsapp_country === "" ? "" : p.whatsapp_country,
    "ON-06.cc": p.whatsapp_dial_code,
    "ON-06.n": p.whatsapp_phone_normalized,
    "ON-07": p.email,
    "ON-08": p.height_cm,
    "ON-09.kg": p.weight_kg,
    timezone,
  };
  for (const [key, value] of Object.entries(expected)) {
    if ((prefill as Record<string, unknown>)[key] !== value) add(`onboarding_prefill.${key}`, "INCONSISTENT");
  }
  return issues;
}

function validateModules(p: z.infer<typeof baseSchema>): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (p.exercise_limitation === "no") return issues;
  const active = getActiveCategories({
    ts_01_has_limitation: p.exercise_limitation,
    ts_02_categories: p.sport_categories,
  });
  const keys = Object.keys(p.modules);
  for (const key of keys) {
    if (!active.includes(key)) issues.push({ path: `modules.${key}`, code: "INACTIVE_MODULE" });
  }
  for (const key of active) {
    const answer = p.modules[key];
    if (answer === undefined) {
      issues.push({ path: `modules.${key}`, code: "REQUIRED" });
      continue;
    }
    const parsed = moduleSchema(key).safeParse(answer);
    if (!parsed.success) {
      for (const issue of toIssues(parsed.error)) {
        issues.push({ path: `modules.${key}${issue.path ? "." + issue.path : ""}`, code: issue.code });
      }
    }
  }
  return issues;
}

/** Rebuilds the answers the browser used, from the submitted payload. */
function answersFromPayload(p: z.infer<typeof baseSchema>): Partial<ConsultAnswers> {
  return {
    age: p.age,
    health_flags: p.health_flags_selected,
    ts_01_has_limitation: p.exercise_limitation,
    ts_02_categories: p.sport_categories,
    ts_03_clearance: p.exercise_clearance ?? "",
    modules: p.modules as ConsultAnswers["modules"],
  };
}

function compareOutcome(p: z.infer<typeof baseSchema>): ValidationIssue[] {
  const expected = evaluateOutcome(answersFromPayload(p));
  const mismatches: ValidationIssue[] = [];
  const check = (field: string, ok: boolean) => {
    if (!ok) mismatches.push({ path: field, code: "MISMATCH" });
  };
  check("safety_outcome", p.safety_outcome === expected.safety_outcome);
  check("general_plan_eligible", p.general_plan_eligible === expected.general_plan_eligible);
  check("review_required", p.review_required === expected.review_required);
  check("specialist_routing", p.specialist_routing === expected.specialist_routing);
  check("specialist_routing_flags", sameSet(p.specialist_routing_flags, expected.specialist_routing_flags));
  check("hard_red_flags", sameSet(p.hard_red_flags, expected.hard_red_flags));
  check("nutrition_red_reasons", sameSet(p.nutrition_red_reasons, expected.nutrition_red_reasons));
  check("nutrition_yellow_reasons", sameSet(p.nutrition_yellow_reasons, expected.nutrition_yellow_reasons));
  check(
    "module_scores",
    SCORE_KEYS.every((k) => (p.module_scores as Record<string, number>)[k] === expected.module_scores[k]),
  );
  check("crm_status", p.crm_status === outcomeCopy[expected.safety_outcome].crmStatus);
  return mismatches;
}

/**
 * Validates a parsed JSON value as a consult-2.1.0 payload.
 * - structural problems and unexpected keys -> INVALID_PAYLOAD (paths and codes only)
 * - derived values that differ from the server recomputation -> OUTCOME_MISMATCH
 * The input is never mutated or filtered; accepted payloads are stored losslessly.
 */
export function validateConsultPayload(input: unknown): ValidationResult {
  const base = baseSchema.safeParse(input);
  if (!base.success) return { ok: false, kind: "INVALID_PAYLOAD", issues: toIssues(base.error) };
  const p = base.data;

  const issues = [...semanticIssues(p), ...validateModules(p)];
  if (issues.length > 0) return { ok: false, kind: "INVALID_PAYLOAD", issues: issues.slice(0, 50) };

  const mismatches = compareOutcome(p);
  if (mismatches.length > 0) return { ok: false, kind: "OUTCOME_MISMATCH", issues: mismatches };

  // normalizePhone consistency (the browser derives the number from dial code + local part)
  if (normalizePhone(p.whatsapp_dial_code, p.whatsapp_phone_normalized) !== p.whatsapp_phone_normalized) {
    return {
      ok: false,
      kind: "INVALID_PAYLOAD",
      issues: [{ path: "whatsapp_phone_normalized", code: "INCONSISTENT" }],
    };
  }
  return { ok: true, payload: input as ConsultPayload };
}

/** Keys the strict module schema accepts (kept in sync with `ModuleAnswer`). */
export const SUPPORTED_MODULE_FIELDS = MODULE_FIELD_KEYS;
