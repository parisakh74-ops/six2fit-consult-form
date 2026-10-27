/**
 * Consultation score and A/B/C routing (Development only, not wired to any UI output).
 *
 * Source of the rules:
 *  - Zoho Forms (PM evidence): Score = USD Budget + Toman Budget + Seriousness; the hidden budget field is expected to contribute nothing.
 *  - Smart Redirector, ThankYou.tsx (Lovable project 7d10219c): A = tz "1" && score >= 6, B = tz "2", C = tz "1" && score < 6.
 *
 * The numeric points per option were confirmed by the PM from the Zoho Forms Builder (2026-10-27) and live ONLY in SCORE_MAPPING below.
 * The new form has a single budget question, so Score = budget points + seriousness points (range 2-8). The hidden Zoho budget field
 * has no counterpart here and contributes nothing.
 */

import type { TzCode } from "./timezone";

export const ROUTING_THRESHOLD = 6;
/** Current Lovable implementation is `>=`. PM wording was "above 6": unresolved, do not change without Product approval. */
export const ROUTING_COMPARATOR: "gte" | "gt" = "gte";

export type Points = number | null;

export interface ScoreMapping {
  /** true only after the PM confirms every number against Zoho Forms Field Properties. */
  verified: boolean;
  usdBudget: Record<"lt_70" | "70_170" | "170_270" | "gt_270", Points>;
  tomanBudget: Record<"lt_5m" | "5_10m" | "10_20m" | "gt_20m", Points>;
  seriousness: Record<"exploring" | "free_only" | "ready_if_results" | "committed", Points>;
}

/** Single configurable mapping: confirmed Zoho Forms values (PM, 2026-10-27). Change only together with the Zoho form. */
export const SCORE_MAPPING: ScoreMapping = {
  verified: true,
  usdBudget: { lt_70: 1, "70_170": 2, "170_270": 3, gt_270: 4 },
  tomanBudget: { lt_5m: 1, "5_10m": 2, "10_20m": 3, gt_20m: 4 },
  seriousness: { exploring: 1, free_only: 2, ready_if_results: 3, committed: 4 },
};

/** WhatsApp destination copied from the Smart Redirector source (ThankYou.tsx, Lovable project 7d10219c). Text decodes to: سلام، من فرم مشاوره را پر کردم. */
export const WHATSAPP_URL =
  "https://wa.me/14376085008?text=%D8%B3%D9%84%D8%A7%D9%85%D8%8C%20%D9%85%D9%86%20%D9%81%D8%B1%D9%85%20%D9%85%D8%B4%D8%A7%D9%88%D8%B1%D9%87%20%D8%B1%D8%A7%20%D9%BE%D8%B1%20%DA%A9%D8%B1%D8%AF%D9%85.";
/**
 * Scenario C destinations, copied from the Smart Redirector source (ThankYou.tsx, Lovable project 7d10219c, scenario C block):
 * "مشاهده ویدیوی راهنما" (cta guide_video) -> /pln/ and "مشاهده پلن‌ها" (cta plans) -> /price/ on six2fit.com. Both open in a new tab.
 * (The LANDING_URL constant of that file, price.six2fit.com, is not used by scenario C.)
 */
export const GUIDE_VIDEO_URL = "https://six2fit.com/pln/";
export const PLANS_URL = "https://six2fit.com/price/";

export type ScoreResult =
  | { status: "UNVERIFIED_MAPPING" }
  | { status: "INCOMPLETE"; missing: string[] }
  | { status: "OK"; score: number; parts: { budget: number; seriousness: number } };

/**
 * Only the budget question that was SHOWN for `tz` contributes (tz "1" -> Toman, "2" -> USD); a value that belongs to the other currency
 * (for example a stale answer after the time zone changed) is treated as missing, never as points.
 */
export function computeScore(
  input: { tz: TzCode; budget_range: string | null | undefined; readiness_level: string | null | undefined },
  mapping: ScoreMapping = SCORE_MAPPING,
): ScoreResult {
  if (!mapping.verified) return { status: "UNVERIFIED_MAPPING" };
  const budgetTable = (input.tz === "1" ? mapping.tomanBudget : mapping.usdBudget) as Record<string, Points>;
  const seriousnessTable = mapping.seriousness as Record<string, Points>;
  const budget = input.budget_range ? budgetTable[input.budget_range] : undefined;
  const seriousness = input.readiness_level ? seriousnessTable[input.readiness_level] : undefined;
  const missing: string[] = [];
  if (typeof budget !== "number") missing.push("budget_range");
  if (typeof seriousness !== "number") missing.push("readiness_level");
  if (missing.length > 0) return { status: "INCOMPLETE", missing };
  return { status: "OK", score: (budget as number) + (seriousness as number), parts: { budget: budget as number, seriousness: seriousness as number } };
}

export type Scenario = "A" | "B" | "C";

export function scenarioFor(tz: TzCode, score: number): Scenario {
  if (tz === "2") return "B";
  const high = ROUTING_COMPARATOR === "gte" ? score >= ROUTING_THRESHOLD : score > ROUTING_THRESHOLD;
  return high ? "A" : "C";
}

export type RoutingResult =
  | { status: "NOT_SUBMITTED" }
  | { status: "SCORE_UNAVAILABLE"; reason: ScoreResult["status"] }
  | { status: "ROUTED"; scenario: Scenario; score: number | null };

/**
 * Routing is decided only after a successful submission. Scenario B depends on the time-zone code only; A/C need a verified score.
 * The caller passes tz explicitly: how tz is derived for the new form is an open Product decision (see the gap list).
 */
export function routeAfterSubmission(args: {
  submission: { ok: boolean };
  tz: TzCode;
  budget_range: string | null | undefined;
  readiness_level: string | null | undefined;
  mapping?: ScoreMapping;
}): RoutingResult {
  if (!args.submission.ok) return { status: "NOT_SUBMITTED" };
  if (args.tz === "2") return { status: "ROUTED", scenario: "B", score: null };
  const scored = computeScore({ tz: args.tz, budget_range: args.budget_range, readiness_level: args.readiness_level }, args.mapping);
  if (scored.status !== "OK") return { status: "SCORE_UNAVAILABLE", reason: scored.status };
  return { status: "ROUTED", scenario: scenarioFor(args.tz, scored.score), score: scored.score };
}

/**
 * Safety outcomes that may be shown the sales call-to-action buttons (WhatsApp, plans, guide video).
 * PROPOSAL pending Product confirmation: the Smart Redirector has no safety concept, but the result copy for YELLOW_REVIEW ("reviewed by the
 * specialist team first") and RED_SPECIALIST ("the general plan may not be suitable") contradicts self-serve plans and a direct consultation
 * request, so only GREEN gets them. Add outcomes here to restore full parity with the Redirector.
 */
export const CTA_ALLOWED_OUTCOMES: readonly ("GREEN" | "YELLOW_REVIEW" | "RED_SPECIALIST")[] = ["GREEN"];

export function ctasAllowedFor(outcome: "GREEN" | "YELLOW_REVIEW" | "RED_SPECIALIST"): boolean {
  return CTA_ALLOWED_OUTCOMES.includes(outcome);
}
