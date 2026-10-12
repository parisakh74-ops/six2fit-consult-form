import { describe, expect, it } from "vitest";
import { validateConsultPayload } from "./validate";
import { FIRST_FLAG, MODULE_KEYS, moduleAnswer, payloadFrom, tamper } from "./fixtures";

const ok = (v: unknown) => validateConsultPayload(v);
const issuesOf = (v: unknown) => {
  const r = validateConsultPayload(v);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};
const kindOf = (v: unknown) => {
  const r = validateConsultPayload(v);
  return r.ok ? "OK" : r.kind;
};

describe("accepts what the real frontend builder produces (consult-2.1.0)", () => {
  it("baseline (no limitation)", () => {
    expect(ok(payloadFrom()).ok).toBe(true);
  });

  it.each(MODULE_KEYS)("module %s with a hard red flag", (key) => {
    const p = payloadFrom({
      ts_01_has_limitation: "yes",
      ts_02_categories: [key],
      ts_03_clearance: "no",
      modules: { [key]: moduleAnswer([FIRST_FLAG[key] as string]) },
    });
    expect(ok(p).ok).toBe(true);
  });

  it("all nine modules together", () => {
    const p = payloadFrom({
      ts_01_has_limitation: "yes",
      ts_02_categories: MODULE_KEYS,
      ts_03_clearance: "not_assessed",
      modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer()])),
    });
    expect(ok(p).ok).toBe(true);
  });

  it("`unsure` limitation behaves as active", () => {
    const p = payloadFrom({
      ts_01_has_limitation: "unsure",
      ts_02_categories: ["ligament"],
      ts_03_clearance: "no",
      modules: { ligament: moduleAnswer() },
    });
    expect(ok(p).ok).toBe(true);
  });

  it("stale module data is already dropped by the builder (deselected category)", () => {
    const p = payloadFrom({
      ts_01_has_limitation: "yes",
      ts_02_categories: ["tendon"],
      ts_03_clearance: "no",
      modules: { tendon: moduleAnswer(), cardiovascular: moduleAnswer(["chest_pain"]) },
    });
    expect(Object.keys(p.modules)).toEqual(["tendon"]);
    expect(ok(p).ok).toBe(true);
  });

  it("health flags with details, nutrition reasons and under-18", () => {
    const p = payloadFrom({
      age: 16,
      health_flags: ["liver_cirrhosis_failure", "diabetes_hypoglycemia_risk", "competitive_athlete"],
      blocker_details: "synthetic details",
    });
    expect(p.nutrition_red_reasons).toContain("age_under_18");
    expect(ok(p).ok).toBe(true);
  });

  it("Iran dial code with IRT budget, other barrier, timezone, attribution", () => {
    const p = payloadFrom({
      whatsapp_country: "IR",
      whatsapp_dial_code: "+98",
      whatsapp_phone: "9120000000",
      budget_range: "5_10m",
      adherence_barrier: ["motivation", "other"],
      adherence_barrier_other: "synthetic",
      preferred_contact_timezone: "Asia/Tehran (UTC+3:30)",
    });
    const withAttribution = { ...p, utm_source: "ig", utm_campaign: "c1", landing_page: "https://consult-staging.example.test/" };
    expect(ok(withAttribution).ok).toBe(true);
  });

  it("empty-string country (not yet selected) is accepted", () => {
    expect(ok(payloadFrom({ whatsapp_country: "" as never })).ok).toBe(true);
  });
});

describe("rejects structural problems without echoing values", () => {
  const base = () => payloadFrom();

  it("unexpected top-level key", () => {
    expect(issuesOf({ ...base(), rogue: 1 })).toContain("rogue:UNEXPECTED_FIELD");
  });
  it("unexpected key inside prefill and module", () => {
    expect(issuesOf(tamper(base(), (p) => (p.onboarding_prefill.extra = 1)))).toContain("onboarding_prefill.extra:UNEXPECTED_FIELD");
    const m = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["other"], ts_03_clearance: "no", modules: { other: moduleAnswer() } });
    expect(issuesOf(tamper(m, (p) => (p.modules.other.rogue = "x")))).toContain("modules.other.rogue:UNEXPECTED_FIELD");
  });
  it("missing required field", () => {
    expect(issuesOf(tamper(base(), (p) => delete p.lead_full_name))).toContain("lead_full_name:REQUIRED");
  });
  it.each([
    ["consult_channel", "telegram"],
    ["sex", "other"],
    ["readiness_level", "maybe"],
    ["exercise_limitation", "maybe"],
  ])("invalid enum value in %s", (field, value) => {
    expect(issuesOf(tamper(base(), (p) => (p[field] = value))).some((i) => i.startsWith(`${field}:`))).toBe(true);
  });
  it("invalid enum inside arrays", () => {
    expect(issuesOf(tamper(base(), (p) => (p.primary_goal = ["fat_loss", "nope"]))).length).toBeGreaterThan(0);
    expect(issuesOf(tamper(base(), (p) => (p.service_interest = [])))).toContain("service_interest:REQUIRED");
  });
  it("duplicate values in multi-select", () => {
    expect(issuesOf(tamper(base(), (p) => (p.primary_goal = ["fat_loss", "fat_loss"])))).toContain("primary_goal:DUPLICATE_VALUES");
  });
  it.each([
    ["age", 13], ["age", 101], ["height_cm", 99], ["height_cm", 251], ["weight_kg", 24], ["weight_kg", 351],
  ])("numeric bound %s=%s", (field, value) => {
    expect(issuesOf(tamper(base(), (p) => (p[field] = value))).some((i) => i.startsWith(`${field}:`))).toBe(true);
  });
  it("wrong types", () => {
    expect(issuesOf(tamper(base(), (p) => (p.age = "30")))).toContain("age:INVALID_TYPE");
    expect(issuesOf(tamper(base(), (p) => (p.consent_processing = false)))).toContain("consent_processing:INVALID_VALUE");
  });
  it("oversized text", () => {
    expect(issuesOf(tamper(base(), (p) => (p.lead_full_name = "ن".repeat(81))))).toContain("lead_full_name:TOO_LONG_OR_LARGE");
    const m = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["other"], ts_03_clearance: "no", modules: { other: moduleAnswer() } });
    expect(issuesOf(tamper(m, (p) => (p.modules.other.diagnosis = "x".repeat(201))))).toContain("modules.other.diagnosis:TOO_LONG_OR_LARGE");
    expect(issuesOf(tamper(m, (p) => (p.modules.other.notes = "x".repeat(1001))))).toContain("modules.other.notes:TOO_LONG_OR_LARGE");
    expect(issuesOf(tamper(base(), (p) => (p.blocker_details = "x".repeat(501))))).toContain("blocker_details:TOO_LONG_OR_LARGE");
  });
  it("non-object input", () => {
    expect(kindOf(null)).toBe("INVALID_PAYLOAD");
    expect(kindOf([])).toBe("INVALID_PAYLOAD");
    expect(kindOf("x")).toBe("INVALID_PAYLOAD");
  });
  it("issues never contain submitted values", () => {
    const r = validateConsultPayload(tamper(base(), (p) => (p.lead_full_name = "SECRET-NAME-VALUE-123")));
    expect(JSON.stringify(r)).not.toContain("SECRET-NAME-VALUE-123");
  });
});

describe("conditional answers", () => {
  it("health flag requires blocker details", () => {
    const p = payloadFrom({ health_flags: ["severe_food_allergy"], blocker_details: "synthetic" });
    expect(issuesOf(tamper(p, (x) => (x.blocker_details = null)))).toContain("blocker_details:REQUIRED");
  });
  it("other barrier requires text; text without other is rejected", () => {
    const p = payloadFrom({ adherence_barrier: ["other"], adherence_barrier_other: "synthetic" });
    expect(issuesOf(tamper(p, (x) => (x.adherence_barrier_other = null)))).toContain("adherence_barrier_other:REQUIRED");
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.adherence_barrier_other = "x")))).toContain("adherence_barrier_other:UNEXPECTED_FIELD");
  });
  it("limitation requires categories, clearance and every required module field", () => {
    const base = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["surgery"], ts_03_clearance: "no", modules: { surgery: moduleAnswer() } });
    expect(issuesOf(tamper(base, (x) => (x.sport_categories = [])))).toContain("sport_categories:REQUIRED");
    expect(issuesOf(tamper(base, (x) => (x.exercise_clearance = null)))).toContain("exercise_clearance:REQUIRED");
    expect(issuesOf(tamper(base, (x) => delete x.modules.surgery.pain))).toContain("modules.surgery.pain:REQUIRED");
    expect(issuesOf(tamper(base, (x) => (x.modules = {})))).toContain("modules.surgery:REQUIRED");
  });
  it("limitation `no` must not carry categories or module answers", () => {
    const base = payloadFrom();
    expect(issuesOf(tamper(base, (x) => (x.sport_categories = ["tendon"])))).toContain("sport_categories:INCONSISTENT");
    expect(issuesOf(tamper(base, (x) => (x.modules = { tendon: { diagnosis: "x" } })))).toContain("modules:INCONSISTENT");
  });
  it("answers for an inactive module are rejected, not dropped", () => {
    const base = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["tendon"], ts_03_clearance: "no", modules: { tendon: moduleAnswer() } });
    const bad = tamper(base, (x) => (x.modules.cardiovascular = { diagnosis: "x", onset: "lt_2w", recovery: "improving", pain: "none", reaction: "fine", clearance: "cleared", red_flags: [] }));
    expect(issuesOf(bad)).toContain("modules.cardiovascular:INACTIVE_MODULE");
  });
  it("module option and red-flag membership is per module", () => {
    const base = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["tendon"], ts_03_clearance: "no", modules: { tendon: moduleAnswer() } });
    expect(issuesOf(tamper(base, (x) => (x.modules.tendon.onset = "nope"))).some((i) => i.startsWith("modules.tendon.onset"))).toBe(true);
    expect(issuesOf(tamper(base, (x) => (x.modules.tendon.red_flags = ["chest_pain"]))).some((i) => i.startsWith("modules.tendon.red_flags"))).toBe(true);
  });
  it("health_flags_selected must match the boolean map", () => {
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.health_flags_selected = ["age_under_18"])))).toContain("health_flags_selected:INCONSISTENT");
  });
  it("phone, country, currency and budget consistency", () => {
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.whatsapp_dial_code = "+98")))).toContain("whatsapp_phone_normalized:INCONSISTENT");
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.whatsapp_country = "IR")))).toContain("whatsapp_country:INCONSISTENT");
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.budget_currency = "IRT")))).toContain("budget_currency:INCONSISTENT");
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.budget_range = "5_10m")))).toContain("budget_range:INVALID_VALUE");
  });
  it("onboarding prefill must mirror the answers", () => {
    expect(issuesOf(tamper(payloadFrom(), (x) => (x.onboarding_prefill["ON-08"] = 171)))).toContain("onboarding_prefill.ON-08:INCONSISTENT");
  });
});

describe("outcome integrity (server recomputation)", () => {
  const red = () => payloadFrom({ health_flags: ["liver_cirrhosis_failure"], blocker_details: "synthetic" });
  it("accepts the recomputed values", () => expect(kindOf(red())).toBe("OK"));
  it.each([
    ["safety_outcome", "GREEN"],
    ["general_plan_eligible", true],
    ["review_required", false],
    ["crm_status", "Consult – Green"],
    ["specialist_routing", true],
  ])("tampered %s -> OUTCOME_MISMATCH", (field, value) => {
    const r = validateConsultPayload(tamper(red(), (p) => (p[field] = value)));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("OUTCOME_MISMATCH");
      expect(r.issues.some((i) => i.path === field)).toBe(true);
    }
  });
  it("tampered nutrition reasons, red flags and scores", () => {
    expect(kindOf(tamper(red(), (p) => (p.nutrition_red_reasons = [])))).toBe("OUTCOME_MISMATCH");
    expect(kindOf(tamper(red(), (p) => (p.nutrition_yellow_reasons = ["TS-03"])))).toBe("OUTCOME_MISMATCH");
    const m = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["tendon"], ts_03_clearance: "no", modules: { tendon: moduleAnswer(["complete_rupture"]) } });
    expect(kindOf(tamper(m, (p) => (p.hard_red_flags = [])))).toBe("OUTCOME_MISMATCH");
    expect(kindOf(tamper(m, (p) => (p.module_scores.module_score_tendon = 0)))).toBe("OUTCOME_MISMATCH");
  });
  it("a submission cannot hide a red flag by reporting GREEN", () => {
    const m = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["oncology"], ts_03_clearance: "yes", modules: { oncology: moduleAnswer(["active_cancer"]) } });
    expect(m.safety_outcome).toBe("RED_SPECIALIST");
    expect(kindOf(tamper(m, (p) => { p.safety_outcome = "GREEN"; p.hard_red_flags = []; }))).toBe("OUTCOME_MISMATCH");
  });
  it("mirrors the current frontend rule: TS-03 is scored even when limitation is `no` (finding F1)", () => {
    // The form does not reset ts_03_clearance when the user changes TS-01 back to "no".
    const p = payloadFrom({ ts_01_has_limitation: "no", ts_03_clearance: "yes" });
    expect(p.hard_red_flags).toEqual(["exercise_clearance:training_banned"]);
    expect(kindOf(p)).toBe("OK");
  });
});
