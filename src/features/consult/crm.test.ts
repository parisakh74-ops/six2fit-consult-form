import { describe, expect, it } from "vitest";

import { buildPayload } from "./crm";
import type { ConsultAnswers } from "./types";

describe("consult CRM payload", () => {
  it("builds onboarding prefill from the submitted consult answers", () => {
    const answers = {
      lead_full_name: "Synthetic Test User",
      whatsapp_country: "CA",
      whatsapp_dial_code: "+1",
      whatsapp_phone: "4165550100",
      consult_channel: "whatsapp",
      email: "synthetic@example.test",
      primary_goal: ["fat_loss"],
      adherence_barrier: [],
      age: 30,
      height_cm: 170,
      weight_kg: 70,
      sex: "female",
      service_interest: ["training"],
      health_flags: [],
      ts_01_has_limitation: "no",
      ts_02_categories: [],
      modules: {},
      consent_processing: true,
      consent_accuracy: true,
    } as ConsultAnswers;

    const payload = buildPayload({
      answers,
      countryCode: "CA",
      submissionId: "cns_synthetic_submission_001",
    });

    expect(payload.onboarding_prefill).toMatchObject({
      "ON-01": "Synthetic Test User",
      "ON-03": "female",
      "ON-06.iso": "CA",
      "ON-06.cc": "+1",
      "ON-07": "synthetic@example.test",
      "ON-08": 170,
      "ON-09.kg": 70,
    });
  });
});
