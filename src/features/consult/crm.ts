import {
  CONSENT_VERSION,
  FORM_VERSION,
  allHealthFlags,
  budgetQuestions,
  outcomeCopy,
} from "./assessmentConfig";
import { buildActiveModules, evaluateOutcome, getActiveCategories, normalizePhone } from "./outcome";
import type { ConsultAnswers, ConsultPayload, SubmitResult } from "./types";

export function createSubmissionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `cns_${crypto.randomUUID()}`;
  }
  throw new Error("SECURE_RANDOM_UNAVAILABLE");
}

function readAttribution() {
  if (typeof window === "undefined") {
    return {
      utm_source: null,
      utm_campaign: null,
      instagram_id: null,
      manychat_id: null,
      landing_page: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const get = (k: string) => params.get(k)?.slice(0, 120) || null;
  return {
    utm_source: get("utm_source"),
    utm_campaign: get("utm_campaign"),
    instagram_id: get("instagram_id"),
    manychat_id: get("manychat_id"),
    landing_page: `${window.location.origin}${window.location.pathname}`,
  };
}

export function buildPayload(params: {
  answers: ConsultAnswers;
  countryCode: string;
  submissionId: string;
}): ConsultPayload {
  const { answers, countryCode, submissionId } = params;
  const outcome = evaluateOutcome(answers);
  const isIran = countryCode === "IR";

  const selectedFlags = answers.health_flags ?? [];
  const health_flags = Object.fromEntries(
    allHealthFlags.map((f) => [f.code, selectedFlags.includes(f.code)]),
  ) as Record<string, boolean>;
  const timezone = answers.preferred_contact_timezone?.trim() || null;
  const onboarding_prefill: Record<string, unknown> = {
    "ON-01": answers.lead_full_name.trim(),
    "ON-03": answers.sex || null,
    "ON-06.iso": answers.whatsapp_country ?? null,
    "ON-06.cc": answers.whatsapp_dial_code,
    "ON-06.n": normalizePhone(answers.whatsapp_dial_code, answers.whatsapp_phone),
    "ON-07": answers.email?.trim() || null,
    "ON-08": answers.height_cm ?? null,
    "ON-09.kg": answers.weight_kg ?? null,
    timezone,
  };

  return {
    submission_id: submissionId,
    form_version: FORM_VERSION,
    submitted_at: new Date().toISOString(),

    lead_full_name: answers.lead_full_name.trim(),
    whatsapp_phone_normalized: normalizePhone(
      answers.whatsapp_dial_code,
      answers.whatsapp_phone,
    ),
    whatsapp_dial_code: answers.whatsapp_dial_code,
    whatsapp_country: answers.whatsapp_country ?? null,
    email: answers.email?.trim() || null,
    consult_channel: answers.consult_channel,

    primary_goal: answers.primary_goal,
    adherence_barrier: answers.adherence_barrier ?? [],
    adherence_barrier_other:
      answers.adherence_barrier?.includes("other")
        ? (answers.adherence_barrier_other?.trim() ?? null)
        : null,
    age: answers.age ?? null,
    height_cm: answers.height_cm ?? null,
    weight_kg: answers.weight_kg ?? null,
    sex: answers.sex || null,
    service_interest: answers.service_interest,

    health_flags,
    health_flags_selected: allHealthFlags
      .map((f) => f.code)
      .filter((code) => selectedFlags.includes(code)),
    specialist_routing: outcome.specialist_routing,
    specialist_routing_flags: outcome.specialist_routing_flags,
    blocker_details: answers.blocker_details?.trim() || null,

    exercise_limitation: answers.ts_01_has_limitation ?? null,
    exercise_clearance: answers.ts_03_clearance ?? null,
    sport_categories: getActiveCategories(answers),
    modules: buildActiveModules(answers),
    module_scores: outcome.module_scores,
    hard_red_flags: outcome.hard_red_flags,
    nutrition_red_reasons: outcome.nutrition_red_reasons,
    nutrition_yellow_reasons: outcome.nutrition_yellow_reasons,

    safety_outcome: outcome.safety_outcome,
    general_plan_eligible: outcome.general_plan_eligible,
    review_required: outcome.review_required,
    crm_status: outcomeCopy[outcome.safety_outcome].crmStatus,

    currency_route_source: "whatsapp_dial_code",
    budget_currency: isIran ? budgetQuestions.IR.currency : budgetQuestions.INTL.currency,
    budget_range: answers.budget_range ?? null,
    readiness_level: answers.readiness_level ?? null,

    preferred_contact_timezone: timezone,
    onboarding_prefill,

    consent_version: CONSENT_VERSION,
    consent_processing: answers.consent_processing,
    consent_accuracy: answers.consent_accuracy,

    ...readAttribution(),
  };
}

/**
 * ISOLATED CRM BOUNDARY.
 *
 * This is the only browser-side CRM boundary. The actual CRM call is made by
 * the same-origin server endpoint; Zoho credentials never belong in this
 * module or in the client bundle.
 *
 * Expected server-side behaviour on integration:
 *  - Deduplicate by whatsapp_phone_normalized first, then by email.
 *  - Map safety_outcome -> crm_status, set review_required / general_plan_eligible.
 *  - Append an audit-log entry with form_version and outcome changes.
 */
export async function submitConsultToCRM(
  payload: ConsultPayload,
): Promise<SubmitResult> {
  if (!payload.submission_id || !payload.whatsapp_phone_normalized) {
    return { ok: false, error_code: "INVALID_PAYLOAD" };
  }

  const endpoint = import.meta.env["VITE_CONSULT_SUBMIT_PATH"] || "/?six2fit_api=consult";
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "Idempotency-Key": payload.submission_id,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    if (response.status === 409) return { ok: false, error_code: "SUBMISSION_CONFLICT" };
    return { ok: false, error_code: "SUBMISSION_FAILED" };
  }
  const result = (await response.json().catch(() => null)) as Partial<SubmitResult> | null;
  if (!result || result.ok !== true || typeof result.crm_record_id !== "string") {
    return { ok: false, error_code: "INVALID_SERVER_RESPONSE" };
  }
  return result as SubmitResult;
}
