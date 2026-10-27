import { describe, expect, it } from "vitest";

import { FORM_VERSION, sportModules, ts03 } from "./assessmentConfig";
import { buildPayload } from "./crm";
import { buildActiveModules, evaluateOutcome, getActiveCategories } from "./outcome";
import type { ConsultAnswers, ModuleAnswer } from "./types";

/** Hard red flags per module, copied from the approved question set (40 values). */
const HARD_FLAGS: Record<string, string[]> = {
  tendon: ["complete_rupture", "visible_deformity", "sudden_strength_loss", "training_banned"],
  ligament: ["instability", "training_banned", "acute_symptoms"],
  cardiovascular: [
    "chest_pain",
    "severe_dyspnea",
    "palpitations",
    "syncope",
    "uncontrolled_cvd",
    "recent_stroke",
  ],
  neurological: ["seizure", "loss_of_consciousness", "new_weakness", "coordination_loss"],
  respiratory: [
    "severe_or_worsening",
    "recent_admission",
    "cannot_speak",
    "cyanosis",
    "chest_pain_syncope",
  ],
  hematologic: ["severe_bleeding", "sudden_dyspnea", "chest_pain", "syncope", "limb_pain_swelling"],
  surgery: [
    "very_recent_surgery",
    "post_op_complication",
    "wound_dehiscence",
    "abnormal_discharge",
    "bleeding",
    "fever_wound",
    "post_op_chest",
  ],
  oncology: ["unknown_mass", "active_cancer", "recurrent_metastatic", "active_heavy_treatment", "training_banned"],
  other: ["training_banned"],
};
const MODULE_KEYS = Object.keys(HARD_FLAGS);

const base = (): ConsultAnswers =>
  ({
    lead_full_name: "  Synthetic Test User ",
    whatsapp_country: "CA",
    whatsapp_dial_code: "+1",
    whatsapp_phone: "4165550100",
    consult_channel: "whatsapp_chat",
    email: "synthetic@example.test",
    primary_goal: ["fat_loss"],
    adherence_barrier: [],
    age: 30,
    height_cm: 170,
    weight_kg: 70,
    sex: "female",
    service_interest: ["nutrition_training"],
    health_flags: [],
    ts_01_has_limitation: "no",
    ts_02_categories: [],
    modules: {},
    consent_processing: true,
    consent_accuracy: true,
  }) as unknown as ConsultAnswers;

const fullModule = (flags: string[] = []): ModuleAnswer => ({
  diagnosis: "  synthetic diagnosis ",
  onset: "6w_6m", // 1 point
  recovery: "improving", // 0
  pain: "mild", // 1
  reaction: "fine", // 0
  clearance: "cleared", // 0
  notes: " synthetic note ",
  red_flags: flags,
});

describe("payload contract consult-2.1.0", () => {
  it("carries the new form version and the new top-level keys", () => {
    const payload = buildPayload({ answers: base(), tz: "2", submissionId: "cns_test" });
    expect(FORM_VERSION).toBe("consult-2.1.0");
    expect(payload.form_version).toBe("consult-2.1.0");
    expect(payload.whatsapp_dial_code).toBe("+1");
    expect(payload).toHaveProperty("modules");
    expect(payload).toHaveProperty("nutrition_red_reasons");
    expect(payload).toHaveProperty("nutrition_yellow_reasons");
    expect(payload.modules).toEqual({});
  });

  it.each(MODULE_KEYS)("serialises the complete answers of the %s module", (key) => {
    const flags = [HARD_FLAGS[key]![0]!];
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "yes",
      ts_02_categories: [key],
      ts_03_clearance: "no",
      modules: { [key]: fullModule(flags) },
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(payload.sport_categories).toEqual([key]);
    expect(payload.modules).toEqual({
      [key]: {
        diagnosis: "synthetic diagnosis",
        onset: "6w_6m",
        recovery: "improving",
        pain: "mild",
        reaction: "fine",
        clearance: "cleared",
        notes: "synthetic note",
        red_flags: flags,
      },
    });
    expect(payload.module_scores[`module_score_${key}`]).toBe(2);
    expect(payload.hard_red_flags).toEqual([`${key}:${flags[0]}`]);
    expect(payload.safety_outcome).toBe("RED_SPECIALIST");
    // every other module score stays 0 and is still present
    expect(Object.keys(payload.module_scores)).toHaveLength(sportModules.length);
  });

  it("serialises all nine modules at once", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "yes",
      ts_02_categories: MODULE_KEYS,
      ts_03_clearance: "no",
      modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, fullModule([])])),
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(Object.keys(payload.modules).sort()).toEqual([...MODULE_KEYS].sort());
    for (const key of MODULE_KEYS) expect(payload.module_scores[`module_score_${key}`]).toBe(2);
    expect(payload.hard_red_flags).toEqual([]);
  });

  it("excludes stale answers of a deselected module", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "yes",
      ts_02_categories: ["tendon"],
      ts_03_clearance: "no",
      modules: {
        tendon: fullModule([]),
        cardiovascular: fullModule(["chest_pain"]), // filled earlier, then deselected
      },
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(Object.keys(payload.modules)).toEqual(["tendon"]);
    expect(payload.hard_red_flags).toEqual([]);
    expect(payload.module_scores["module_score_cardiovascular"]).toBe(0);
    expect(JSON.stringify(payload)).not.toContain("chest_pain");
  });

  it("sends no module data when TS-01 is no, even with stale form state", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "no",
      ts_02_categories: ["tendon"],
      modules: { tendon: fullModule(["complete_rupture"]) },
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(payload.modules).toEqual({});
    expect(payload.sport_categories).toEqual([]);
    expect(payload.hard_red_flags).toEqual([]);
    expect(payload.safety_outcome).toBe("GREEN");
  });

  it("treats `unsure` as an active limitation", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "unsure",
      ts_02_categories: ["ligament"],
      ts_03_clearance: "no",
      modules: { ligament: fullModule([]) },
    };
    expect(getActiveCategories(answers)).toEqual(["ligament"]);
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(payload.exercise_limitation).toBe("unsure");
    expect(payload.modules["ligament"]).toBeDefined();
  });

  it("de-duplicates repeated categories", () => {
    expect(
      getActiveCategories({ ts_01_has_limitation: "yes", ts_02_categories: ["tendon", "tendon"] }),
    ).toEqual(["tendon"]);
  });

  it("omits empty optional answers but keeps red_flags as an empty array", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "yes",
      ts_02_categories: ["other"],
      ts_03_clearance: "no",
      modules: {
        other: { diagnosis: "x", onset: "gt_6m", recovery: "improving", pain: "none", reaction: "fine", clearance: "cleared", notes: "   " },
      },
    };
    const entry = buildActiveModules(answers)["other"]!;
    expect(entry).not.toHaveProperty("notes");
    expect(entry.red_flags).toEqual([]);
  });

  it("reports nutrition red and yellow reasons exactly as evaluated", () => {
    const yellowTs03 = ts03.options.find((o) => o.severity === "YELLOW")?.value;
    expect(yellowTs03).toBeDefined();
    const answers: ConsultAnswers = {
      ...base(),
      age: 16,
      health_flags: ["liver_cirrhosis_failure", "diabetes_hypoglycemia_risk", "competitive_athlete"],
      ts_01_has_limitation: "yes",
      ts_02_categories: ["other"],
      ts_03_clearance: yellowTs03 as string,
      modules: { other: fullModule([]) },
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    const expected = evaluateOutcome(answers);
    expect(payload.nutrition_red_reasons).toEqual(expected.nutrition_red_reasons);
    expect(payload.nutrition_yellow_reasons).toEqual(expected.nutrition_yellow_reasons);
    expect(payload.nutrition_red_reasons).toEqual(
      expect.arrayContaining(["liver_cirrhosis_failure", "age_under_18"]),
    );
    expect(payload.nutrition_yellow_reasons).toEqual(
      expect.arrayContaining(["diabetes_hypoglycemia_risk", "TS-03"]),
    );
    expect(payload.specialist_routing_flags).toEqual(["competitive_athlete"]);
  });

  it("returns empty reasons when nothing is flagged", () => {
    const payload = buildPayload({ answers: base(), tz: "2", submissionId: "cns_test" });
    expect(payload.nutrition_red_reasons).toEqual([]);
    expect(payload.nutrition_yellow_reasons).toEqual([]);
  });

  it("survives JSON serialisation without losing or adding keys", () => {
    const answers: ConsultAnswers = {
      ...base(),
      ts_01_has_limitation: "yes",
      ts_02_categories: ["surgery", "oncology"],
      ts_03_clearance: "no",
      modules: { surgery: fullModule(["bleeding"]), oncology: fullModule([]) },
    };
    const payload = buildPayload({ answers, tz: "2", submissionId: "cns_test" });
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
    // keep the previously submitted keys
    for (const key of [
      "submission_id",
      "form_version",
      "submitted_at",
      "lead_full_name",
      "whatsapp_phone_normalized",
      "health_flags",
      "health_flags_selected",
      "module_scores",
      "hard_red_flags",
      "safety_outcome",
      "crm_status",
      "onboarding_prefill",
      "consent_version",
      "utm_source",
      "landing_page",
    ]) {
      expect(payload).toHaveProperty(key);
    }
    expect(payload.lead_full_name).toBe("Synthetic Test User");
  });
});

describe("F1: payload never carries a stale TS-03", () => {
  it("exercise_clearance is null when TS-01 is no, even if the form state still holds a value", () => {
    const payload = buildPayload({
      answers: { ...base(), ts_01_has_limitation: "no", ts_02_categories: [], ts_03_clearance: "yes", modules: {} },
      tz: "2",
      submissionId: "cns_test",
    });
    expect(payload.exercise_clearance).toBeNull();
    expect(payload.safety_outcome).toBe("GREEN");
    expect(payload.hard_red_flags).toEqual([]);
  });
});
