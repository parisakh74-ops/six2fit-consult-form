import { describe, expect, it } from "vitest";
import { SCORE_MAPPING, computeScore, routeAfterSubmission, scenarioFor } from "./routing";
import { budgetQuestions, readinessQuestion } from "./assessmentConfig";
import { submitConsultToCRM } from "./crm";

const USD = ["lt_70", "70_170", "170_270", "gt_270"] as const;
const TOMAN = ["lt_5m", "5_10m", "10_20m", "gt_20m"] as const;
const SERIOUS = ["exploring", "free_only", "ready_if_results", "committed"] as const;

describe("score mapping", () => {
  it("holds exactly the 12 confirmed Zoho Forms values", () => {
    expect(SCORE_MAPPING.usdBudget).toEqual({ lt_70: 1, "70_170": 2, "170_270": 3, gt_270: 4 });
    expect(SCORE_MAPPING.tomanBudget).toEqual({ lt_5m: 1, "5_10m": 2, "10_20m": 3, gt_20m: 4 });
    expect(SCORE_MAPPING.seriousness).toEqual({ exploring: 1, free_only: 2, ready_if_results: 3, committed: 4 });
  });

  it("the form's readiness options carry no weights of their own", () => {
    expect(readinessQuestion.options.every((o) => o.points === undefined)).toBe(true);
  });

  it("an unverified mapping never yields a score", () => {
    expect(computeScore({ tz: "2", budget_range: "70_170", readiness_level: "committed" }, { ...SCORE_MAPPING, verified: false })).toEqual({ status: "UNVERIFIED_MAPPING" });
  });

  it("budget values offered by the form equal the mapped keys", () => {
    expect(budgetQuestions.INTL.options.map((o) => o.value)).toEqual([...USD]);
    expect(budgetQuestions.IR.options.map((o) => o.value)).toEqual([...TOMAN]);
    expect(readinessQuestion.options.map((o) => o.value)).toEqual([...SERIOUS]);
  });

  it("reports missing inputs instead of guessing", () => {
    expect(computeScore({ tz: "2", budget_range: "nope", readiness_level: "committed" })).toEqual({ status: "INCOMPLETE", missing: ["budget_range"] });
  });
});

describe("only the budget question shown for tz contributes to the score", () => {
  it("a Toman answer under tz 2 (USD shown) and a USD answer under tz 1 (Toman shown) are not counted", () => {
    expect(computeScore({ tz: "2", budget_range: "gt_20m", readiness_level: "committed" })).toEqual({ status: "INCOMPLETE", missing: ["budget_range"] });
    expect(computeScore({ tz: "1", budget_range: "gt_270", readiness_level: "committed" })).toEqual({ status: "INCOMPLETE", missing: ["budget_range"] });
  });

  it("the shown group scores normally", () => {
    expect(computeScore({ tz: "1", budget_range: "gt_20m", readiness_level: "committed" })).toMatchObject({ status: "OK", score: 8 });
    expect(computeScore({ tz: "2", budget_range: "gt_270", readiness_level: "committed" })).toMatchObject({ status: "OK", score: 8 });
  });
});

describe("full matrix and boundaries (rule kept: score >= 6)", () => {
  it.each([
    ["USD (tz 2)", "2", USD],
    ["Toman (tz 1)", "1", TOMAN],
  ] as const)("all 16 %s budget x seriousness combinations sum correctly and stay within 2-8", (_name, tz, budgets) => {
    budgets.forEach((budget, bi) => {
      SERIOUS.forEach((ser, si) => {
        const r = computeScore({ tz, budget_range: budget, readiness_level: ser });
        expect(r).toMatchObject({ status: "OK", score: bi + 1 + (si + 1) });
        if (r.status === "OK") expect(r.score >= 2 && r.score <= 8).toBe(true);
      });
    });
  });

  it.each([
    [5, "C"],
    [6, "A"],
    [7, "A"],
  ] as const)("tz 1, score %i -> scenario %s", (score, expected) => {
    expect(scenarioFor("1", score)).toBe(expected);
  });

  it("tz 2 is scenario B whatever the score", () => {
    for (const s of [0, 5, 6, 7, 20]) expect(scenarioFor("2", s)).toBe("B");
  });

  it("covers every score 2..8 for each currency", () => {
    for (const [tz, budgets] of [["1", TOMAN], ["2", USD]] as const) {
      const seen = new Set<number>();
      for (const b of budgets) {
        for (const s of SERIOUS) {
          const r = computeScore({ tz, budget_range: b, readiness_level: s });
          if (r.status === "OK") seen.add(r.score);
        }
      }
      expect([...seen].sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8]);
    }
  });
});

describe("routing happens only after a successful submission", () => {
  const base = { tz: "1" as const, budget_range: "10_20m", readiness_level: "ready_if_results" }; // 3 + 3 = 6

  it("does not route a failed submission", () => {
    expect(routeAfterSubmission({ ...base, submission: { ok: false } })).toEqual({ status: "NOT_SUBMITTED" });
  });

  it("routes 5 / 6 / 7 end to end after success (tz 1, Toman)", () => {
    const run = (budget_range: string, readiness_level: string) => routeAfterSubmission({ ...base, budget_range, readiness_level, submission: { ok: true } });
    expect(run("10_20m", "free_only")).toEqual({ status: "ROUTED", scenario: "C", score: 5 });
    expect(run("10_20m", "ready_if_results")).toEqual({ status: "ROUTED", scenario: "A", score: 6 });
    expect(run("gt_20m", "ready_if_results")).toEqual({ status: "ROUTED", scenario: "A", score: 7 });
  });

  it("tz 2 routes to B without needing a score", () => {
    expect(routeAfterSubmission({ tz: "2", budget_range: null, readiness_level: null, submission: { ok: true } })).toEqual({ status: "ROUTED", scenario: "B", score: null });
  });

  it("an unverified mapping yields no routing for tz 1", () => {
    expect(routeAfterSubmission({ ...base, submission: { ok: true }, mapping: { ...SCORE_MAPPING, verified: false } })).toEqual({ status: "SCORE_UNAVAILABLE", reason: "UNVERIFIED_MAPPING" });
  });

  it("integration: a failed API submission produces no routing, a successful one does", async () => {
    const original = globalThis.fetch;
    const payload = { submission_id: "cns_00000000-0000-4000-8000-000000000001", whatsapp_phone_normalized: "+14165550100" } as never;
    try {
      globalThis.fetch = (async () => new Response("{}", { status: 500 })) as typeof fetch;
      const failed = await submitConsultToCRM(payload);
      expect(failed.ok).toBe(false);
      expect(routeAfterSubmission({ ...base, submission: failed })).toEqual({ status: "NOT_SUBMITTED" });

      globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, crm_record_id: "1" }), { status: 200 })) as typeof fetch;
      const ok = await submitConsultToCRM(payload);
      expect(routeAfterSubmission({ ...base, submission: ok })).toMatchObject({ status: "ROUTED", scenario: "A" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
