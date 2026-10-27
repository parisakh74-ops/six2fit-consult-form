import { describe, expect, it } from "vitest";
import {
  SCORE_MAPPING,
  computeScore,
  lovableTzCode,
  routeAfterSubmission,
  scenarioFor,
  type ScoreMapping,
} from "./routing";
import { currencyCountryFromDialCode } from "./assessmentConfig";

/** SYNTHETIC numbers used only to exercise the arithmetic. They are NOT the Zoho Forms values. */
const SYNTHETIC: ScoreMapping = {
  verified: true,
  usdBudget: { lt_70: 0, "70_170": 1, "170_270": 2, gt_270: 3 },
  tomanBudget: { lt_5m: 0, "5_10m": 1, "10_20m": 2, gt_20m: 3 },
  seriousness: { exploring: 0, free_only: 1, ready_if_results: 2, committed: 4 },
};

describe("score mapping safety", () => {
  it("the shipped mapping is unverified and has no numbers", () => {
    expect(SCORE_MAPPING.verified).toBe(false);
    const all = [...Object.values(SCORE_MAPPING.usdBudget), ...Object.values(SCORE_MAPPING.tomanBudget), ...Object.values(SCORE_MAPPING.seriousness)];
    expect(all.every((v) => v === null)).toBe(true);
  });

  it("never produces a score while the mapping is unverified", () => {
    expect(computeScore({ budget_range: "70_170", readiness_level: "committed" })).toEqual({ status: "UNVERIFIED_MAPPING" });
  });

  it("reports missing inputs instead of guessing", () => {
    expect(computeScore({ budget_range: "nope", readiness_level: "committed" }, SYNTHETIC)).toEqual({ status: "INCOMPLETE", missing: ["budget_range"] });
  });
});

describe("boundary scores 5, 6 and 7 (current Lovable rule: score >= 6)", () => {
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

  it("sums budget and seriousness through the mapping (5, 6, 7)", () => {
    const at = (budget: string, readiness: string) => computeScore({ budget_range: budget, readiness_level: readiness }, SYNTHETIC);
    expect(at("gt_270", "ready_if_results")).toMatchObject({ status: "OK", score: 5 });
    expect(at("170_270", "committed")).toMatchObject({ status: "OK", score: 6 });
    expect(at("gt_270", "committed")).toMatchObject({ status: "OK", score: 7 });
  });
});

describe("routing happens only after a successful submission", () => {
  const base = { tz: "1" as const, budget_range: "gt_270", readiness_level: "committed", mapping: SYNTHETIC };

  it("does not route a failed submission", () => {
    expect(routeAfterSubmission({ ...base, submission: { ok: false } })).toEqual({ status: "NOT_SUBMITTED" });
  });

  it("routes 5 / 6 / 7 end to end after success", () => {
    const run = (budget_range: string, readiness_level: string) => routeAfterSubmission({ ...base, budget_range, readiness_level, submission: { ok: true } });
    expect(run("gt_270", "ready_if_results")).toEqual({ status: "ROUTED", scenario: "C", score: 5 });
    expect(run("170_270", "committed")).toEqual({ status: "ROUTED", scenario: "A", score: 6 });
    expect(run("gt_270", "committed")).toEqual({ status: "ROUTED", scenario: "A", score: 7 });
  });

  it("with the shipped (unverified) mapping an Iranian-tz user gets no routing result", () => {
    expect(routeAfterSubmission({ tz: "1", budget_range: "gt_270", readiness_level: "committed", submission: { ok: true } })).toEqual({
      status: "SCORE_UNAVAILABLE",
      reason: "UNVERIFIED_MAPPING",
    });
  });
});

describe("time-zone behaviour kept as a documented gap (no change made)", () => {
  it("Lovable: only Asia/Tehran is 1, errors fall back to 2", () => {
    expect(lovableTzCode("Asia/Tehran")).toBe("1");
    expect(lovableTzCode("Europe/Berlin")).toBe("2");
    expect(lovableTzCode(undefined)).toBe("2");
  });

  it("the new form groups budgets by WhatsApp dial code, which can disagree with the browser time zone", () => {
    // +98 number used from Berlin: new form shows Toman budget, Lovable would send tz=2.
    expect(currencyCountryFromDialCode("+98")).toBe("IR");
    expect(lovableTzCode("Europe/Berlin")).toBe("2");
    // non-Iranian number used from Tehran: new form shows USD budget, Lovable would send tz=1.
    expect(currencyCountryFromDialCode("+1")).toBe("INTL");
    expect(lovableTzCode("Asia/Tehran")).toBe("1");
  });
});
