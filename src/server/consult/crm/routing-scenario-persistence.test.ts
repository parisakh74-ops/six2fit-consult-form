import { describe, expect, it } from "vitest";
import { payloadFrom } from "../fixtures";
import { ROUTING_SCENARIO_FIELD, buildCrmRecord } from "./mapping";

const OPTS = { receivedAt: new Date("2026-10-31T10:00:00Z"), payloadHash: "0".repeat(64), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" };
const build = (over: object, tz: "1" | "2", extra: object = {}, persistScore = true) =>
  buildCrmRecord({ ...(payloadFrom(over as never, undefined, tz) as unknown as Record<string, unknown>), ...extra }, { ...OPTS, persistScore });

describe("Routing_Scenario persistence (gated, server-derived, no separate tz field)", () => {
  it("documents the field and that the tz is not stored on its own", () => {
    expect(ROUTING_SCENARIO_FIELD).toEqual({ apiName: "Routing_Scenario", type: "picklist", values: ["A", "B", "C"] });
    const { record } = build({ budget_range: "10_20m", readiness_level: "ready_if_results" }, "1");
    expect(Object.keys(record).some((k) => /^tz$|Time_?zone_?Code|Budget_Tz/i.test(k))).toBe(false);
  });

  it("is not written, and neither is the score, when the flag is off", () => {
    const { record } = build({ budget_range: "gt_20m", readiness_level: "committed" }, "1", {}, false);
    expect("Routing_Scenario" in record).toBe(false);
    expect("Consult_Score" in record).toBe(false);
  });

  it("tz 1 (Toman): score 5 -> C, 6 -> A, 7 -> A", () => {
    expect(build({ budget_range: "10_20m", readiness_level: "free_only" }, "1").record).toMatchObject({ Consult_Score: 5, Routing_Scenario: "C" });
    expect(build({ budget_range: "10_20m", readiness_level: "ready_if_results" }, "1").record).toMatchObject({ Consult_Score: 6, Routing_Scenario: "A" });
    expect(build({ budget_range: "gt_20m", readiness_level: "ready_if_results" }, "1").record).toMatchObject({ Consult_Score: 7, Routing_Scenario: "A" });
  });

  it("tz 1: lowest and highest scores", () => {
    expect(build({ budget_range: "lt_5m", readiness_level: "exploring" }, "1").record).toMatchObject({ Consult_Score: 2, Routing_Scenario: "C" });
    expect(build({ budget_range: "gt_20m", readiness_level: "committed" }, "1").record).toMatchObject({ Consult_Score: 8, Routing_Scenario: "A" });
  });

  it("tz 2 (USD) is always B, whatever the score", () => {
    for (const [b, r] of [["lt_70", "exploring"], ["170_270", "ready_if_results"], ["gt_270", "committed"]] as const) {
      expect(build({ budget_range: b, readiness_level: r }, "2").record["Routing_Scenario"]).toBe("B");
    }
  });

  it("every budget x seriousness combination of both currencies gets exactly one of A/B/C", () => {
    const usd = ["lt_70", "70_170", "170_270", "gt_270"];
    const toman = ["lt_5m", "5_10m", "10_20m", "gt_20m"];
    const ser = ["exploring", "free_only", "ready_if_results", "committed"];
    for (const [tz, list] of [["2", usd], ["1", toman]] as const) {
      for (const b of list) for (const r of ser) {
        const v = build({ budget_range: b, readiness_level: r }, tz).record["Routing_Scenario"];
        expect(["A", "B", "C"]).toContain(v);
        if (tz === "2") expect(v).toBe("B");
      }
    }
  });

  it("ignores a scenario or tz sent by the client", () => {
    const { record } = build({ budget_range: "lt_5m", readiness_level: "exploring" }, "1", { routing_scenario: "A", Routing_Scenario: "A", scenario: "A" });
    expect(record["Routing_Scenario"]).toBe("C");
  });

  it("a Toman answer under tz 2 yields no scenario A/C (falls to B by tz only); score is not counted", () => {
    const tehran = payloadFrom({ budget_range: "gt_20m", readiness_level: "committed" } as never, undefined, "1") as unknown as Record<string, unknown>;
    const { record, degraded } = buildCrmRecord({ ...tehran, budget_tz: "2" }, { ...OPTS, persistScore: true });
    expect(record["Routing_Scenario"]).toBe("B");
    expect("Consult_Score" in record).toBe(false);
    expect(degraded).toContain("Consult_Score");
  });
});
