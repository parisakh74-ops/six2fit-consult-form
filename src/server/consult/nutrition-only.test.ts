/* eslint-disable @typescript-eslint/no-explicit-any -- negative tests mutate arbitrary JSON */
// Nutrition-only: Exercise Safety is never shown, so its answers are null/empty. Training, Combo and Not Sure still enforce it.
import { describe, expect, it } from "vitest";
import { fingerprint } from "./canonical";
import { buildCrmRecord } from "./crm/mapping";
import { FIRST_FLAG, moduleAnswer, newId, payloadFrom, tamper } from "./fixtures";
import { validateConsultPayload } from "./validate";

const issuesOf = (v: unknown) => {
  const r = validateConsultPayload(v);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};
const map = (payload: any) =>
  buildCrmRecord(payload, { receivedAt: new Date(), payloadHash: fingerprint(payload), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" });

/** What the form state looks like for a Nutrition-only user: TS-01 default is "" and never answered. */
const nutrition = (over: Record<string, unknown> = {}, id = newId(100)) =>
  payloadFrom({ service_interest: ["nutrition"], ts_01_has_limitation: "" as any, ...over } as any, id);

describe("A: Nutrition-only", () => {
  it("the builder sends null/empty exercise fields and the server accepts it", () => {
    const p = nutrition();
    expect(p.exercise_limitation).toBeNull();
    expect(p.exercise_clearance).toBeNull();
    expect(p.sport_categories).toEqual([]);
    expect(p.modules).toEqual({});
    expect(validateConsultPayload(p).ok).toBe(true);
  });
  it("the incident payload (empty-string limitation) is still not a valid wire value", () => {
    expect(issuesOf(tamper(nutrition(), (p) => (p.exercise_limitation = "")))).toContain("exercise_limitation:INVALID_VALUE");
  });
});

describe("B/C/D: Training, Combo and Not Sure still require the exercise answer", () => {
  it.each(["training", "nutrition_training", "not_sure"])("%s without an exercise answer is rejected", (service) => {
    const p = payloadFrom({ service_interest: [service], ts_01_has_limitation: "" as any } as any, newId(101));
    expect(p.exercise_limitation).toBeNull(); // the builder never turns an unanswered question into "no"
    expect(issuesOf(p)).toContain("exercise_limitation:REQUIRED");
  });
  it("a server-side null is rejected for these services even if hand-crafted", () => {
    const p = payloadFrom({ service_interest: ["nutrition_training"], ts_01_has_limitation: "no" } as any, newId(102));
    expect(validateConsultPayload(p).ok).toBe(true);
    expect(issuesOf(tamper(p, (x) => (x.exercise_limitation = null)))).toContain("exercise_limitation:REQUIRED");
  });
});

describe("E: valid exercise answers follow the existing conditional rules", () => {
  it.each(["training", "nutrition_training", "not_sure"])("%s with no / yes / unsure", (service) => {
    expect(validateConsultPayload(payloadFrom({ service_interest: [service], ts_01_has_limitation: "no" } as any, newId(103))).ok).toBe(true);
    for (const limitation of ["yes", "unsure"]) {
      const p = payloadFrom(
        { service_interest: [service], ts_01_has_limitation: limitation, ts_02_categories: ["tendon"], ts_03_clearance: "no", modules: { tendon: moduleAnswer() } } as any,
        newId(104),
      );
      expect(validateConsultPayload(p).ok).toBe(true);
      expect(issuesOf(tamper(p, (x) => (x.sport_categories = [])))).toContain("sport_categories:REQUIRED");
    }
  });
});

describe("F: Nutrition-only with exercise data is not accepted by the server; the builder drops stale data", () => {
  it("server rejects each inconsistent exercise field", () => {
    const base = nutrition();
    expect(issuesOf(tamper(base, (p) => (p.exercise_limitation = "no")))).toContain("exercise_limitation:INCONSISTENT");
    expect(issuesOf(tamper(base, (p) => (p.exercise_clearance = "no")))).toContain("exercise_clearance:INCONSISTENT");
    expect(issuesOf(tamper(base, (p) => (p.sport_categories = ["tendon"])))).toContain("sport_categories:INCONSISTENT");
    expect(issuesOf(tamper(base, (p) => (p.modules = { tendon: moduleAnswer() })))).toContain("modules:INCONSISTENT");
  });
  it("stale answers left from an earlier Training selection never reach the payload", () => {
    const p = nutrition({
      ts_01_has_limitation: "yes",
      ts_02_categories: ["oncology"],
      ts_03_clearance: "yes",
      modules: { oncology: moduleAnswer(["active_cancer"]) },
    });
    expect(p.exercise_limitation).toBeNull();
    expect(p.sport_categories).toEqual([]);
    expect(p.modules).toEqual({});
    expect(p.hard_red_flags).toEqual([]);
    expect(p.safety_outcome).toBe("GREEN");
    expect(validateConsultPayload(p).ok).toBe(true);
  });
});

describe("G: Nutrition safety is unchanged", () => {
  it("a health red flag on a Nutrition-only request still produces the specialist outcome", () => {
    const p = nutrition({ health_flags: ["liver_cirrhosis_failure"], blocker_details: "synthetic details" });
    expect(p.safety_outcome).toBe("RED_SPECIALIST");
    expect(p.nutrition_red_reasons.length).toBeGreaterThan(0);
    expect(validateConsultPayload(p).ok).toBe(true);
  });
  it("under-18 on Nutrition-only is still red", () => {
    const p = nutrition({ age: 16 });
    expect(p.nutrition_red_reasons).toContain("age_under_18");
    expect(p.safety_outcome).toBe("RED_SPECIALIST");
  });
  it("a Nutrition-only submission cannot hide its red flag by reporting GREEN", () => {
    const p = nutrition({ health_flags: ["liver_cirrhosis_failure"], blocker_details: "synthetic details" });
    const r = validateConsultPayload(tamper(p, (x) => { x.safety_outcome = "GREEN"; x.nutrition_red_reasons = []; x.general_plan_eligible = true; x.review_required = false; }));
    expect(r.ok).toBe(false);
  });
  it("Training red flags (module) are unaffected", () => {
    const m = payloadFrom({ service_interest: ["training"], ts_01_has_limitation: "yes", ts_02_categories: ["oncology"], ts_03_clearance: "yes", modules: { oncology: moduleAnswer([FIRST_FLAG["oncology"] as string]) } } as any, newId(105));
    expect(m.safety_outcome).toBe("RED_SPECIALIST");
    expect(validateConsultPayload(m).ok).toBe(true);
  });
});

describe("H: CRM mapping with a skipped Exercise Safety section", () => {
  it("writes no Exercise_* picklist value and no module rows", () => {
    const { record } = map(nutrition());
    expect(record).not.toHaveProperty("Exercise_Limitation");
    expect(record).not.toHaveProperty("Exercise_Clearance");
    expect(record).not.toHaveProperty("Sport_Categories");
    expect(record["Module_Answers"] ?? []).toEqual([]);
    expect(JSON.stringify(record)).not.toContain('"Exercise_Limitation":""');
  });
  it("an answered limitation is still mapped to its picklist value", () => {
    const { record } = map(payloadFrom({ service_interest: ["training"], ts_01_has_limitation: "no" } as any, newId(106)));
    expect(record["Exercise_Limitation"]).toBe("no");
  });
});
