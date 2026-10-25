import { fingerprint } from "../canonical";
import { StoreError } from "../errors";
import type { StoredConsult } from "../store";

/**
 * Mapping between the validated consult-2.1.0 payload and the Sandbox module
 * `Consultation_Submissions` (schema inventory: change plan sections 25/26).
 *
 * Rules:
 *  - `Raw_Payload_JSON` is the system of record for the answers (exact compact JSON accepted by the
 *    service). The parent fields and `Module_Answers` rows are derived, reportable copies.
 *  - Nothing is truncated. An answer or identity value that does not fit its CRM field (including the
 *    e-mail, capped at 100 characters by the validator) makes the mapping fail (`REJECTED`); only the
 *    attribution convenience copy `Landing_Page` (payload bound 300, CRM 255) is left out of the structured
 *    copy and reported by name in `degraded` (the full value stays in `Raw_Payload_JSON`).
 *  - Picklist / multi-select values are checked against the CRM option sets before sending.
 *  - No upsert, no identity creation: the optional `Lead` / `Contact` lookups are plain ids.
 */

export const CRM_TEXT_MAX = 255;
export const CRM_AREA_MAX = 2000;
export const CRM_EMAIL_MAX = 100;
export const CRM_NAME_MAX = 120;

const set = (...v: string[]) => new Set(v);

/** CRM option sets as created in the Sandbox (change plan 26.4). Verified against the frontend config by tests. */
export const CRM_OPTIONS = {
  Consult_Channel: set("whatsapp_chat", "whatsapp_call", "google_meet"),
  Sex: set("female", "male"),
  Exercise_Limitation: set("no", "yes", "unsure"),
  Exercise_Clearance: set("no", "yes", "not_assessed"),
  Safety_Outcome: set("GREEN", "YELLOW_REVIEW", "RED_SPECIALIST"),
  Budget_Currency: set("IRT", "USD"),
  Budget_Range: set("lt_5m", "5_10m", "10_20m", "gt_20m", "lt_70", "70_170", "170_270", "gt_270"),
  Readiness_Level: set("exploring", "free_only", "ready_if_results", "committed"),
  Status: set("Received", "Linked", "Needs Review", "Identity Conflict", "Reviewed", "Specialist Referred"),
  Identity_Match: set("New Lead", "Existing Lead", "Existing Contact", "Conflict"),
  Primary_Goals: set("fat_loss", "muscle_strength", "performance", "health_lifestyle", "body_recomposition"),
  Adherence_Barriers: set("motivation", "time", "no_results", "boredom", "injury", "other"),
  Service_Interest: set("nutrition", "training", "nutrition_training", "not_sure"),
  Sport_Categories: set("tendon", "ligament", "cardiovascular", "neurological", "respiratory", "hematologic", "surgery", "oncology", "other"),
  Specialist_Routing_Flags: set("competitive_athlete"),
  Nutrition_Red_Reasons: set(
    "age_under_18",
    "eating_disorder_history",
    "unstable_cardiac_or_stroke",
    "liver_cirrhosis_failure",
    "gi_disease_or_surgery",
    "unintentional_weight_loss",
    "severe_weakness_syncope",
  ),
  Nutrition_Yellow_Reasons: set("diabetes_hypoglycemia_risk", "severe_food_allergy", "TS-03"),
  Hard_Red_Flags: set(
    "tendon:complete_rupture", "tendon:visible_deformity", "tendon:sudden_strength_loss", "tendon:training_banned",
    "ligament:instability", "ligament:training_banned", "ligament:acute_symptoms",
    "cardiovascular:chest_pain", "cardiovascular:severe_dyspnea", "cardiovascular:palpitations", "cardiovascular:syncope",
    "cardiovascular:uncontrolled_cvd", "cardiovascular:recent_stroke",
    "neurological:seizure", "neurological:loss_of_consciousness", "neurological:new_weakness", "neurological:coordination_loss",
    "respiratory:severe_or_worsening", "respiratory:recent_admission", "respiratory:cannot_speak", "respiratory:cyanosis",
    "respiratory:chest_pain_syncope",
    "hematologic:severe_bleeding", "hematologic:sudden_dyspnea", "hematologic:chest_pain", "hematologic:syncope",
    "hematologic:limb_pain_swelling",
    "surgery:very_recent_surgery", "surgery:post_op_complication", "surgery:wound_dehiscence", "surgery:abnormal_discharge",
    "surgery:bleeding", "surgery:fever_wound", "surgery:post_op_chest",
    "oncology:unknown_mass", "oncology:active_cancer", "oncology:recurrent_metastatic", "oncology:active_heavy_treatment",
    "oncology:training_banned", "other:training_banned", "exercise_clearance:training_banned",
  ),
} as const;

export const SUBFORM_OPTIONS = {
  Onset: set("lt_2w", "2_6w", "6w_6m", "gt_6m"),
  Recovery: set("improving", "unchanged", "worsening"),
  Pain: set("none", "mild", "moderate", "severe"),
  Reaction: set("fine", "slightly_worse", "much_worse"),
  Clearance: set("cleared", "no_ban", "not_assessed"),
} as const;

/** health_flags code -> boolean field. */
export const HEALTH_FIELDS: Record<string, string> = {
  age_under_18: "HF_Age_Under_18",
  diabetes_hypoglycemia_risk: "HF_Diabetes_Hypoglycemia_Risk",
  eating_disorder_history: "HF_Eating_Disorder_History",
  unstable_cardiac_or_stroke: "HF_Unstable_Cardiac_Or_Stroke",
  liver_cirrhosis_failure: "HF_Liver_Cirrhosis_Failure",
  gi_disease_or_surgery: "HF_GI_Disease_Or_Surgery",
  unintentional_weight_loss: "HF_Unintentional_Weight_Loss",
  severe_weakness_syncope: "HF_Severe_Weakness_Syncope",
  severe_food_allergy: "HF_Severe_Food_Allergy",
  competitive_athlete: "HF_Competitive_Athlete",
};

export const MODULE_KEYS = [...CRM_OPTIONS.Sport_Categories];
export const SUBFORM_NAME = "Module_Answers";
export const MAX_SUBFORM_ROWS = 9;

const rejected = (code: string, field: string): never => {
  // Field API name only: never a value.
  throw new StoreError("REJECTED", `crm mapping: ${field}`, code);
};

export type CrmRecordBody = Record<string, unknown>;
export type MappingResult = { record: CrmRecordBody; degraded: string[]; rawChars: number };
export type MappingOptions = {
  receivedAt: Date;
  /** Fingerprint computed by the service (stored in Payload_Hash). */
  payloadHash: string;
  maxRawPayloadChars: number;
  lead?: string | undefined;
  contact?: string | undefined;
  sandboxIdPrefix: string;
  /** Initial status; default `Received` (the CRM-side resolver acts on `Received` only). */
  status?: "Received" | "Needs Review" | undefined;
  /** Set only together with a verified Lead reference. */
  identityMatch?: "Existing Lead" | undefined;
};

export const toZohoDateTime = (iso: string | Date): string => {
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return rejected("INVALID_DATE", "datetime");
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asString = (v: unknown, field: string): string | undefined => {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v !== "string") return rejected("INVALID_TYPE", field);
  return v;
};

function text(out: CrmRecordBody, degraded: string[], field: string, value: unknown, max: number, mode: "strict" | "degrade" = "strict"): void {
  const v = asString(value, field);
  if (v === undefined) return;
  if (v.length > max) {
    if (mode === "degrade") {
      degraded.push(field);
      return;
    }
    rejected("FIELD_TOO_LONG", field);
  }
  out[field] = v;
}

function option(out: CrmRecordBody, field: keyof typeof CRM_OPTIONS, value: unknown): void {
  const v = asString(value, field);
  if (v === undefined) return;
  if (!(CRM_OPTIONS[field] as Set<string>).has(v)) rejected("UNKNOWN_OPTION", field);
  out[field] = v;
}

function multi(out: CrmRecordBody, field: keyof typeof CRM_OPTIONS, value: unknown): void {
  if (value === null || value === undefined) return;
  if (!Array.isArray(value)) return rejected("INVALID_TYPE", field);
  const options = CRM_OPTIONS[field] as Set<string>;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !options.has(item)) return rejected("UNKNOWN_OPTION", field);
    seen.add(item);
  }
  if (seen.size > 0) out[field] = [...seen];
}

function num(out: CrmRecordBody, field: string, value: unknown): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "number" || !Number.isFinite(value)) return rejected("INVALID_TYPE", field);
  out[field] = value;
}

function bool(out: CrmRecordBody, field: string, value: unknown): void {
  if (typeof value !== "boolean") return rejected("INVALID_TYPE", field);
  out[field] = value;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Builds the `Module_Answers` rows (one per active module, never more than nine). */
export function buildModuleRows(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  const modules = payload["modules"];
  if (modules === undefined || modules === null) return [];
  if (!isObj(modules)) return rejected("INVALID_TYPE", SUBFORM_NAME);
  const scores = isObj(payload["module_scores"]) ? payload["module_scores"] : {};
  const rows: Array<Record<string, unknown>> = [];
  const degraded: string[] = [];
  for (const [key, raw] of Object.entries(modules)) {
    if (!CRM_OPTIONS.Sport_Categories.has(key)) return rejected("UNKNOWN_OPTION", `${SUBFORM_NAME}.Module`);
    if (!isObj(raw)) return rejected("INVALID_TYPE", SUBFORM_NAME);
    const row: Record<string, unknown> = { Module: key };
    text(row, degraded, "Diagnosis", raw["diagnosis"], CRM_TEXT_MAX);
    for (const [src, field] of [["onset", "Onset"], ["recovery", "Recovery"], ["pain", "Pain"], ["reaction", "Reaction"], ["clearance", "Clearance"]] as const) {
      const v = asString(raw[src], `${SUBFORM_NAME}.${field}`);
      if (v === undefined) continue;
      if (!(SUBFORM_OPTIONS[field] as Set<string>).has(v)) rejected("UNKNOWN_OPTION", `${SUBFORM_NAME}.${field}`);
      row[field] = v;
    }
    const flags = raw["red_flags"];
    if (Array.isArray(flags) && flags.length > 0) {
      if (flags.some((f) => typeof f !== "string")) rejected("INVALID_TYPE", `${SUBFORM_NAME}.Red_Flags`);
      text(row, degraded, "Red_Flags", (flags as string[]).join(","), CRM_TEXT_MAX);
    }
    const score = scores[`module_score_${key}`];
    if (typeof score === "number") row["Module_Score"] = score;
    text(row, degraded, "Module_Notes", raw["notes"], CRM_AREA_MAX);
    rows.push(row);
  }
  if (rows.length > MAX_SUBFORM_ROWS) rejected("TOO_MANY_ROWS", SUBFORM_NAME);
  return rows;
}

/** Maps a validated payload to the CRM record body. Pure and deterministic (apart from `receivedAt`). */
export function buildCrmRecord(payload: Record<string, unknown>, opts: MappingOptions): MappingResult {
  const out: CrmRecordBody = {};
  const degraded: string[] = [];

  const id = asString(payload["submission_id"], "Submission_ID");
  if (!id) return rejected("MISSING", "Submission_ID");
  const submissionId = id as string;
  if (submissionId.length > CRM_NAME_MAX) rejected("FIELD_TOO_LONG", "Name");
  out["Name"] = submissionId;
  out["Submission_ID"] = submissionId;
  out["Status"] = opts.status ?? "Received";

  // Complete original payload: compact JSON, size checked on the real serialisation (UTF-16 length is a
  // conservative upper bound of Zoho's character count; bytes are irrelevant, verified in the Sandbox).
  const raw = JSON.stringify(payload);
  const rawChars = raw.length;
  if (rawChars > opts.maxRawPayloadChars) {
    throw new StoreError("TOO_LARGE", "raw payload exceeds the CRM field capacity", "RAW_PAYLOAD_TOO_LARGE");
  }
  out["Raw_Payload_JSON"] = raw;
  out["Payload_Hash"] = opts.payloadHash;
  if (opts.payloadHash.length > CRM_TEXT_MAX) rejected("FIELD_TOO_LONG", "Payload_Hash");

  text(out, degraded, "Form_Version", payload["form_version"], CRM_TEXT_MAX);
  if (typeof payload["submitted_at"] === "string") out["Submitted_At_Client"] = toZohoDateTime(payload["submitted_at"]);
  out["Received_At"] = toZohoDateTime(opts.receivedAt);

  text(out, degraded, "Full_Name", payload["lead_full_name"], CRM_TEXT_MAX);
  text(out, degraded, "WhatsApp", payload["whatsapp_phone_normalized"], CRM_TEXT_MAX);
  text(out, degraded, "WhatsApp_Dial_Code", payload["whatsapp_dial_code"], CRM_TEXT_MAX);
  text(out, degraded, "WhatsApp_Country", payload["whatsapp_country"], CRM_TEXT_MAX);
  // E1: the validator caps the e-mail at the CRM limit; a longer value is refused, never left out.
  text(out, degraded, "Email", payload["email"], CRM_EMAIL_MAX);
  option(out, "Consult_Channel", payload["consult_channel"]);
  multi(out, "Primary_Goals", payload["primary_goal"]);
  multi(out, "Adherence_Barriers", payload["adherence_barrier"]);
  text(out, degraded, "Adherence_Barrier_Other", payload["adherence_barrier_other"], CRM_AREA_MAX);
  num(out, "Age", payload["age"]);
  num(out, "Height_cm", payload["height_cm"]);
  num(out, "Weight_kg", payload["weight_kg"]);
  option(out, "Sex", payload["sex"]);
  multi(out, "Service_Interest", payload["service_interest"]);

  const health = payload["health_flags"];
  if (!isObj(health)) rejected("INVALID_TYPE", "HF_*");
  for (const [code, field] of Object.entries(HEALTH_FIELDS)) bool(out, field, (health as Record<string, unknown>)[code] ?? false);
  for (const code of Object.keys(health as Record<string, unknown>)) {
    if (!(code in HEALTH_FIELDS)) rejected("UNKNOWN_OPTION", "HF_*");
  }
  bool(out, "Specialist_Routing", payload["specialist_routing"]);
  multi(out, "Specialist_Routing_Flags", payload["specialist_routing_flags"]);
  text(out, degraded, "Blocker_Details", payload["blocker_details"], CRM_AREA_MAX);

  option(out, "Exercise_Limitation", payload["exercise_limitation"]);
  option(out, "Exercise_Clearance", payload["exercise_clearance"]);
  multi(out, "Sport_Categories", payload["sport_categories"]);

  const scores = payload["module_scores"];
  if (!isObj(scores)) rejected("INVALID_TYPE", "Score_*");
  for (const [key, value] of Object.entries(scores as Record<string, unknown>)) {
    const m = /^module_score_([a-z]+)$/.exec(key);
    if (!m || !CRM_OPTIONS.Sport_Categories.has(m[1] as string)) rejected("UNKNOWN_OPTION", "Score_*");
    num(out, `Score_${capitalize(m![1] as string)}`, value);
  }

  multi(out, "Hard_Red_Flags", payload["hard_red_flags"]);
  out["Any_Hard_Red_Flag"] = Array.isArray(payload["hard_red_flags"]) && (payload["hard_red_flags"] as unknown[]).length > 0;
  multi(out, "Nutrition_Red_Reasons", payload["nutrition_red_reasons"]);
  multi(out, "Nutrition_Yellow_Reasons", payload["nutrition_yellow_reasons"]);

  option(out, "Safety_Outcome", payload["safety_outcome"]);
  bool(out, "General_Plan_Eligible", payload["general_plan_eligible"]);
  bool(out, "Review_Required", payload["review_required"]);
  text(out, degraded, "CRM_Status_Label", payload["crm_status"], CRM_TEXT_MAX);
  option(out, "Budget_Currency", payload["budget_currency"]);
  option(out, "Budget_Range", payload["budget_range"]);
  option(out, "Readiness_Level", payload["readiness_level"]);
  text(out, degraded, "Timezone", payload["preferred_contact_timezone"], CRM_TEXT_MAX);

  out["Consent_Version"] = asString(payload["consent_version"], "Consent_Version") ?? rejected("MISSING", "Consent_Version");
  bool(out, "Consent_Processing", payload["consent_processing"]);
  bool(out, "Consent_Accuracy", payload["consent_accuracy"]);

  text(out, degraded, "UTM_Source", payload["utm_source"], CRM_TEXT_MAX);
  text(out, degraded, "UTM_Campaign", payload["utm_campaign"], CRM_TEXT_MAX);
  text(out, degraded, "Instagram_ID", payload["instagram_id"], CRM_TEXT_MAX);
  text(out, degraded, "ManyChat_ID", payload["manychat_id"], CRM_TEXT_MAX);
  // Payload bound is 300 characters, the CRM text field holds 255: the structured copy is omitted when longer.
  text(out, degraded, "Landing_Page", payload["landing_page"], CRM_TEXT_MAX, "degrade");

  if (payload["onboarding_prefill"] !== undefined && payload["onboarding_prefill"] !== null) {
    const prefill = JSON.stringify(payload["onboarding_prefill"]);
    if (prefill.length > RAW_PREFILL_MAX) degraded.push("Onboarding_Prefill_JSON");
    else out["Onboarding_Prefill_JSON"] = prefill;
  }

  const rows = buildModuleRows(payload);
  if (rows.length > 0) out[SUBFORM_NAME] = rows;

  // Optional associations (ids resolved elsewhere, never created here). Sandbox ids only.
  for (const [field, value] of [["Lead", opts.lead], ["Contact", opts.contact]] as const) {
    if (value === undefined) continue;
    if (!/^\d{10,25}$/.test(value) || !value.startsWith(opts.sandboxIdPrefix)) rejected("INVALID_LOOKUP_ID", field);
    out[field] = { id: value };
  }
  if (opts.identityMatch !== undefined && opts.lead !== undefined) out["Identity_Match"] = opts.identityMatch;

  return { record: out, degraded, rawChars };
}

const RAW_PREFILL_MAX = 31_000;

export type CrmSubmissionView = {
  stored: StoredConsult;
  moduleRows: Array<Record<string, unknown>>;
  lead: string | null;
  contact: string | null;
  status: string | null;
};

/** Rebuilds the stored view from a CRM record; verifies integrity (`Payload_Hash` vs the raw payload). */
export function parseCrmRecord(record: unknown, expectedSubmissionId: string): CrmSubmissionView {
  const corrupt = (code: string): never => {
    throw new StoreError("CORRUPT", "crm record is not readable", code);
  };
  if (!isObj(record)) return corrupt("RECORD_SHAPE");
  const id = record["id"];
  const sid = record["Submission_ID"];
  const hash = record["Payload_Hash"];
  const raw = record["Raw_Payload_JSON"];
  if (typeof id !== "string" || id === "") return corrupt("NO_ID");
  if (typeof sid !== "string" || sid.toLowerCase() !== expectedSubmissionId.toLowerCase()) return corrupt("ID_MISMATCH");
  if (typeof hash !== "string" || typeof raw !== "string") return corrupt("MISSING_FIELDS");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return corrupt("RAW_JSON");
  }
  if (!isObj(payload)) return corrupt("RAW_JSON");
  // An answer edited in the CRM, or a truncated raw field, must never be taken for the original.
  if (fingerprint(payload) !== hash) return corrupt("HASH_MISMATCH");
  const createdAt = typeof record["Received_At"] === "string" ? record["Received_At"] : typeof record["Created_Time"] === "string" ? record["Created_Time"] : new Date(0).toISOString();
  const rawRows = record[SUBFORM_NAME];
  if (rawRows !== undefined && rawRows !== null && !Array.isArray(rawRows)) return corrupt("SUBFORM_SHAPE");
  const rows = Array.isArray(rawRows) ? (rawRows as unknown[]).filter(isObj) : [];
  // The subform must carry exactly the modules of the stored payload (documented: subforms are returned only
  // by an unrestricted single-record fetch). Missing, extra or duplicated rows mean the read is incomplete.
  const expectedModules = isObj(payload["modules"]) ? Object.keys(payload["modules"]).sort() : [];
  const rowModules = rows.map((r) => (typeof r["Module"] === "string" ? r["Module"] : "")).sort();
  if (rows.length !== (Array.isArray(rawRows) ? rawRows.length : 0) || JSON.stringify(rowModules) !== JSON.stringify(expectedModules)) {
    return corrupt("SUBFORM_INCOMPLETE");
  }
  const ref = (v: unknown): string | null => (isObj(v) && typeof v["id"] === "string" ? v["id"] : null);
  return {
    stored: {
      version: 2,
      submission_id: sid,
      payload_hash: hash,
      payload,
      record_ref: id,
      crm_record_id: id,
      created_at: createdAt,
    },
    moduleRows: rows,
    lead: ref(record["Lead"]),
    contact: ref(record["Contact"]),
    status: typeof record["Status"] === "string" ? record["Status"] : null,
  };
}

/** Programmatic extraction of one exercise module from a retrieved payload (no CRM JSON querying needed). */
export function extractModuleAnswer(payload: Record<string, unknown>, moduleKey: string): Record<string, unknown> | null {
  const modules = payload["modules"];
  if (!isObj(modules)) return null;
  const answer = modules[moduleKey];
  return isObj(answer) ? answer : null;
}
