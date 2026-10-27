/**
 * Consultation score and A/B/C routing (Development only, not wired to any UI output).
 *
 * Source of the rules:
 *  - Zoho Forms (PM evidence): Score = USD Budget + Toman Budget + Seriousness; the hidden budget field is expected to contribute nothing.
 *  - Smart Redirector, ThankYou.tsx (Lovable project 7d10219c): A = tz "1" && score >= 6, B = tz "2", C = tz "1" && score < 6.
 *
 * The numeric points per option are NOT verified yet. They live ONLY in SCORE_MAPPING below (null = unknown). While the mapping is
 * unverified, computeScore never returns a number, so no real score can be produced or stored.
 */

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

/** Single configurable mapping. Fill in from Zoho Forms and set verified = true in one reviewed change. */
export const SCORE_MAPPING: ScoreMapping = {
  verified: false,
  usdBudget: { lt_70: null, "70_170": null, "170_270": null, gt_270: null },
  tomanBudget: { lt_5m: null, "5_10m": null, "10_20m": null, gt_20m: null },
  seriousness: { exploring: null, free_only: null, ready_if_results: null, committed: null },
};

export type ScoreResult =
  | { status: "UNVERIFIED_MAPPING" }
  | { status: "INCOMPLETE"; missing: string[] }
  | { status: "OK"; score: number; parts: { budget: number; seriousness: number } };

export function computeScore(
  input: { budget_range: string | null | undefined; readiness_level: string | null | undefined },
  mapping: ScoreMapping = SCORE_MAPPING,
): ScoreResult {
  if (!mapping.verified) return { status: "UNVERIFIED_MAPPING" };
  const budgetTable = { ...mapping.usdBudget, ...mapping.tomanBudget } as Record<string, Points>;
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

export function scenarioFor(tz: "1" | "2", score: number): Scenario {
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
  tz: "1" | "2";
  budget_range: string | null | undefined;
  readiness_level: string | null | undefined;
  mapping?: ScoreMapping;
}): RoutingResult {
  if (!args.submission.ok) return { status: "NOT_SUBMITTED" };
  if (args.tz === "2") return { status: "ROUTED", scenario: "B", score: null };
  const scored = computeScore(args, args.mapping);
  if (scored.status !== "OK") return { status: "SCORE_UNAVAILABLE", reason: scored.status };
  return { status: "ROUTED", scenario: scenarioFor(args.tz, scored.score), score: scored.score };
}

/** Same derivation as the Smart Redirector (Index.tsx): "1" only for the Asia/Tehran time zone, otherwise "2" (also when detection fails). */
export function lovableTzCode(timeZone: string | undefined): "1" | "2" {
  return timeZone === "Asia/Tehran" ? "1" : "2";
}
