import { describe, expect, it } from "vitest";
import { payloadFrom } from "../fixtures";
import { PROPOSED_SCORE_FIELD, buildCrmRecord } from "./mapping";

const OPTS = { receivedAt: new Date("2026-10-27T10:00:00Z"), payloadHash: "0".repeat(64), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" };

describe("Consult_Score persistence (gated, server-derived)", () => {
  it("is not written by default (the CRM field does not exist yet)", () => {
    const { record } = buildCrmRecord(payloadFrom({}) as unknown as Record<string, unknown>, OPTS);
    expect(PROPOSED_SCORE_FIELD.apiName in record).toBe(false);
  });

  it("is written from budget_range + readiness_level when enabled, for every combination", () => {
    const budgets = [["70_170", 2], ["gt_270", 4], ["lt_70", 1], ["170_270", 3]] as const;
    const serious = [["exploring", 1], ["free_only", 2], ["ready_if_results", 3], ["committed", 4]] as const;
    for (const [b, bp] of budgets) for (const [r, rp] of serious) {
      const payload = payloadFrom({ budget_range: b, readiness_level: r } as never) as unknown as Record<string, unknown>;
      const { record, degraded } = buildCrmRecord(payload, { ...OPTS, persistScore: true });
      expect(record["Consult_Score"]).toBe(bp + rp);
      expect(degraded).not.toContain("Consult_Score");
    }
  });

  it("ignores any score sent by the client", () => {
    const payload = { ...(payloadFrom({ budget_range: "lt_70", readiness_level: "exploring" } as never) as unknown as Record<string, unknown>), score: 99, consult_score: 99 };
    const { record } = buildCrmRecord(payload, { ...OPTS, persistScore: true });
    expect(record["Consult_Score"]).toBe(2);
  });

  it("follows the tz that decided the budget question: a Toman value under tz 2 is not counted", () => {
    const tehran = payloadFrom({ budget_range: "gt_20m", readiness_level: "committed" } as never, undefined, "1") as unknown as Record<string, unknown>;
    expect(buildCrmRecord(tehran, { ...OPTS, persistScore: true }).record["Consult_Score"]).toBe(8);
    const { record, degraded } = buildCrmRecord({ ...tehran, budget_tz: "2" }, { ...OPTS, persistScore: true });
    expect("Consult_Score" in record).toBe(false);
    expect(degraded).toContain("Consult_Score");
  });

  it("documents the proposed field", () => {
    expect(PROPOSED_SCORE_FIELD).toEqual({ apiName: "Consult_Score", type: "integer", maxDigits: 1 });
  });
});
