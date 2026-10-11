import type { SafetyOutcome } from "./assessmentConfig";

export type ModuleAnswer = {
  diagnosis?: string;
  onset?: string;
  recovery?: string;
  pain?: string;
  reaction?: string;
  clearance?: string;
  notes?: string;
  red_flags?: string[];
};

export type ConsultAnswers = {
  lead_full_name: string;
  whatsapp_country?: string;
  whatsapp_dial_code: string;
  whatsapp_phone: string;
  consult_channel: string;
  email?: string;

  primary_goal: string[];
  adherence_barrier: string[];
  adherence_barrier_other?: string;
  age?: number;
  height_cm?: number;
  weight_kg?: number;
  sex?: string;
  service_interest: string[];

  health_flags: string[];
  blocker_details?: string;

  ts_01_has_limitation?: string;
  ts_02_categories: string[];
  ts_03_clearance?: string;
  modules: Record<string, ModuleAnswer>;

  budget_range?: string;
  readiness_level?: string;

  preferred_contact_timezone?: string;

  consent_processing: boolean;
  consent_accuracy: boolean;
};

export type OutcomeResult = {
  safety_outcome: SafetyOutcome;
  general_plan_eligible: boolean;
  review_required: boolean;
  hard_red_flags: string[];
  module_scores: Record<string, number>;
  nutrition_red_reasons: string[];
  nutrition_yellow_reasons: string[];
  specialist_routing: boolean;
  specialist_routing_flags: string[];
};

export type ConsultPayload = {
  submission_id: string;
  form_version: string;
  submitted_at: string;

  lead_full_name: string;
  whatsapp_phone_normalized: string;
  whatsapp_country: string | null;
  email: string | null;
  consult_channel: string;

  primary_goal: string[];
  adherence_barrier: string[];
  adherence_barrier_other: string | null;
  age: number | null;
  height_cm: number | null;
  weight_kg: number | null;
  sex: string | null;
  service_interest: string[];

  /** Every flag_code with an independent true/false value. */
  health_flags: Record<string, boolean>;
  health_flags_selected: string[];
  specialist_routing: boolean;
  specialist_routing_flags: string[];
  blocker_details: string | null;

  exercise_limitation: string | null;
  exercise_clearance: string | null;
  sport_categories: string[];
  module_scores: Record<string, number>;
  hard_red_flags: string[];

  safety_outcome: SafetyOutcome;
  general_plan_eligible: boolean;
  review_required: boolean;
  crm_status: string;

  currency_route_source: "whatsapp_dial_code";
  budget_currency: string;
  budget_range: string | null;
  readiness_level: string | null;

  preferred_contact_timezone: string | null;
  /** Candidate values for the server-side onboarding prefill mapper. */
  onboarding_prefill: Record<string, unknown>;

  consent_version: string;
  consent_processing: boolean;
  consent_accuracy: boolean;

  utm_source: string | null;
  utm_campaign: string | null;
  instagram_id: string | null;
  manychat_id: string | null;
  landing_page: string | null;
};

export type SubmitResult =
  | { ok: true; crm_record_id: string; deduplicated: boolean; onboarding_url?: string }
  | { ok: false; error_code: string };
