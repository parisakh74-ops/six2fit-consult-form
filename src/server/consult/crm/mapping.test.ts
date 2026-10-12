/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed CRM bodies */
import { describe, expect, it } from "vitest";
import {
  adherenceBarrierOptions,
  allHealthFlags,
  budgetQuestions,
  consultChannelOptions,
  primaryGoalOptions,
  readinessQuestion,
  serviceInterestOptions,
  sexQuestion,
  sportModules,
  ts01,
  ts03,
} from "../../../features/consult/assessmentConfig";
import { fingerprint } from "../canonical";
import { MODULE_KEYS as FIXTURE_MODULES, FIRST_FLAG, moduleAnswer, payloadFrom, tamper } from "../fixtures";
import { StoreError } from "../errors";
import {
  CRM_OPTIONS,
  HEALTH_FIELDS,
  SUBFORM_OPTIONS,
  buildCrmRecord,
  buildModuleRows,
  extractModuleAnswer,
  parseCrmRecord,
  toZohoDateTime,
} from "./mapping";

const OPTS = {
  receivedAt: new Date("2026-10-12T10:00:00.123Z"),
  payloadHash: "0".repeat(64),
  maxRawPayloadChars: 31_000,
  sandboxIdPrefix: "6223361000",
};
const values = (o: { value: string }[]) => o.map((x) => x.value).sort();
const sorted = (s: ReadonlySet<string>) => [...s].sort();

const allModules = () =>
  payloadFrom({
    ts_01_has_limitation: "yes",
    ts_02_categories: FIXTURE_MODULES,
    ts_03_clearance: "not_assessed",
    modules: Object.fromEntries(FIXTURE_MODULES.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
  } as any);

const reason = (fn: () => unknown): { kind?: string; code?: string; message?: string } => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    return { kind: (e as StoreError).kind, code: (e as StoreError).code ?? "", message: (e as Error).message };
  }
  throw new Error("expected a StoreError");
};

describe("CRM option sets match the frontend configuration (drift guard)", () => {
  it.each([
    ["Consult_Channel", values(consultChannelOptions)],
    ["Sex", values(sexQuestion.options)],
    ["Exercise_Limitation", values(ts01.options)],
    ["Primary_Goals", values(primaryGoalOptions)],
    ["Adherence_Barriers", values(adherenceBarrierOptions)],
    ["Service_Interest", values(serviceInterestOptions)],
    ["Readiness_Level", values(readinessQuestion.options)],
    ["Budget_Range", [...values(budgetQuestions.IR.options), ...values(budgetQuestions.INTL.options)].sort()],
    ["Sport_Categories", sportModules.map((m) => m.key).sort()],
  ] as const)("%s", (field, expected) => {
    expect(sorted(CRM_OPTIONS[field] as Set<string>)).toEqual([...expected].sort());
  });

  it("Exercise_Clearance covers TS-03 values", () => {
    expect(sorted(CRM_OPTIONS.Exercise_Clearance)).toEqual(["no", "not_assessed", "yes"]);
    expect(ts03.options.map((o) => o.value).sort()).toEqual(["no", "not_assessed", "yes"]);
  });

  it("every frontend hard red flag exists in Hard_Red_Flags (41 options)", () => {
    const expected = sportModules.flatMap((m) => m.hardRedFlags.map((f) => `${m.key}:${f.value}`));
    for (const f of [...expected, "exercise_clearance:training_banned"]) expect(CRM_OPTIONS.Hard_Red_Flags.has(f)).toBe(true);
    expect(CRM_OPTIONS.Hard_Red_Flags.size).toBe(41);
  });

  it("health flags and reasons are covered", () => {
    expect(Object.keys(HEALTH_FIELDS).sort()).toEqual(allHealthFlags.map((f) => f.code).sort());
    const red = allHealthFlags.filter((f) => f.severity === "RED").map((f) => f.code);
    const yellow = allHealthFlags.filter((f) => f.severity === "YELLOW").map((f) => f.code);
    expect(sorted(CRM_OPTIONS.Nutrition_Red_Reasons)).toEqual([...red].sort());
    expect(sorted(CRM_OPTIONS.Nutrition_Yellow_Reasons)).toEqual([...yellow, "TS-03"].sort());
  });

  it("subform option sets match the per-module option codes", () => {
    const seen = { onset: new Set<string>(), recovery: new Set<string>(), pain: new Set<string>(), reaction: new Set<string>(), clearance: new Set<string>() } as Record<string, Set<string>>;
    for (const m of sportModules) for (const f of m.fields) if (seen[f.key]) for (const o of f.options ?? []) seen[f.key]!.add(o.value);
    expect(sorted(SUBFORM_OPTIONS.Onset)).toEqual(sorted(seen["onset"] as Set<string>));
    expect(sorted(SUBFORM_OPTIONS.Recovery)).toEqual(sorted(seen["recovery"] as Set<string>));
    expect(sorted(SUBFORM_OPTIONS.Pain)).toEqual(sorted(seen["pain"] as Set<string>));
    expect(sorted(SUBFORM_OPTIONS.Reaction)).toEqual(sorted(seen["reaction"] as Set<string>));
    expect(sorted(SUBFORM_OPTIONS.Clearance)).toEqual(sorted(seen["clearance"] as Set<string>));
  });
});

describe("buildCrmRecord", () => {
  it("maps the baseline payload to every approved parent field", () => {
    const payload = payloadFrom() as unknown as Record<string, unknown>;
    const { record, degraded } = buildCrmRecord(payload, { ...OPTS, payloadHash: fingerprint(payload) });
    expect(degraded).toEqual([]);
    for (const k of [
      "Name", "Submission_ID", "Status", "Raw_Payload_JSON", "Payload_Hash", "Form_Version", "Submitted_At_Client", "Received_At",
      "Full_Name", "WhatsApp", "WhatsApp_Dial_Code", "WhatsApp_Country", "Email", "Consult_Channel", "Primary_Goals", "Age", "Height_cm",
      "Weight_kg", "Sex", "Service_Interest", "Specialist_Routing", "Exercise_Limitation", "Safety_Outcome", "General_Plan_Eligible",
      "Review_Required", "CRM_Status_Label", "Budget_Currency", "Budget_Range", "Readiness_Level", "Consent_Version", "Consent_Processing",
      "Consent_Accuracy", "Any_Hard_Red_Flag", "Onboarding_Prefill_JSON", ...Object.values(HEALTH_FIELDS),
      ...FIXTURE_MODULES.map((m) => `Score_${m.charAt(0).toUpperCase()}${m.slice(1)}`),
    ]) {
      expect(record, k).toHaveProperty(k);
    }
    expect(record["Name"]).toBe(payload["submission_id"]);
    expect(record["Status"]).toBe("Received");
    expect(record["Submitted_At_Client"]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$/);
    expect(record["Received_At"]).toBe("2026-10-12T10:00:00+00:00");
    expect(record["Module_Answers"]).toBeUndefined();
    expect(record["Lead"]).toBeUndefined();
    expect(JSON.parse(record["Raw_Payload_JSON"] as string)).toEqual(JSON.parse(JSON.stringify(payload)));
  });

  it("creates nine subform rows with the approved columns", () => {
    const payload = allModules() as unknown as Record<string, unknown>;
    const { record } = buildCrmRecord(payload, OPTS);
    const rows = record["Module_Answers"] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r["Module"]).sort()).toEqual([...FIXTURE_MODULES].sort());
    expect(rows[0]).toMatchObject({ Diagnosis: "synthetic diagnosis", Onset: "6w_6m", Recovery: "improving", Pain: "mild", Reaction: "fine", Clearance: "cleared", Module_Notes: "synthetic note" });
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["Clearance", "Diagnosis", "Module", "Module_Notes", "Module_Score", "Onset", "Pain", "Reaction", "Recovery", "Red_Flags"]);
      expect(typeof r["Module_Score"]).toBe("number");
    }
    const flags = record["Hard_Red_Flags"] as string[];
    expect(flags.length).toBeGreaterThanOrEqual(9);
    expect(record["Any_Hard_Red_Flag"]).toBe(true);
    expect((record["Sport_Categories"] as string[]).length).toBe(9);
  });

  it("every module key and its first hard red flag is accepted by the CRM option sets", () => {
    for (const k of FIXTURE_MODULES) {
      const payload = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: [k], ts_03_clearance: "no", modules: { [k]: moduleAnswer([FIRST_FLAG[k] as string]) } } as any) as unknown as Record<string, unknown>;
      expect(() => buildCrmRecord(payload, OPTS), k).not.toThrow();
    }
  });

  it("keeps Persian text exactly and does not count bytes", () => {
    const payload = tamper(payloadFrom({ lead_full_name: "پریسا خداب" } as any), (p) => {
      p.x_fill = "سلام ".repeat(5000); // 25,000 characters, ~46 KB in UTF-8
    });
    const { record, rawChars } = buildCrmRecord(payload, OPTS);
    expect(record["Full_Name"]).toBe("پریسا خداب");
    expect(rawChars).toBeGreaterThan(25_000);
    expect(new TextEncoder().encode(record["Raw_Payload_JSON"] as string).length).toBeGreaterThan(rawChars);
    expect(JSON.parse(record["Raw_Payload_JSON"] as string).x_fill).toBe(payload["x_fill"]);
  });

  it("rejects an oversized raw payload by characters, never truncates", () => {
    const big = (n: number) => tamper(payloadFrom(), (p) => (p.x_fill = "a".repeat(n)));
    const overhead = JSON.stringify(big(0)).length;
    expect(() => buildCrmRecord(big(31_000 - overhead), OPTS)).not.toThrow();
    const r = reason(() => buildCrmRecord(big(31_001 - overhead), OPTS));
    expect(r).toMatchObject({ kind: "TOO_LARGE", code: "RAW_PAYLOAD_TOO_LARGE" });
    // Multi-byte content below the character limit is accepted although its UTF-8 size is far above it.
    const persian = tamper(payloadFrom(), (p) => (p.x_fill = "ب".repeat(30_900 - overhead)));
    expect(() => buildCrmRecord(persian, OPTS)).not.toThrow();
  });

  it("field mapping errors name the field only and never include values", () => {
    const bad = tamper(payloadFrom(), (p) => (p.safety_outcome = "SECRET-VALUE-XYZ"));
    const r = reason(() => buildCrmRecord(bad, OPTS));
    expect(r).toMatchObject({ kind: "REJECTED", code: "UNKNOWN_OPTION" });
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE-XYZ");

    const longNote = tamper(payloadFrom(), (p) => (p.blocker_details = "ب".repeat(2001)));
    expect(reason(() => buildCrmRecord(longNote, OPTS))).toMatchObject({ kind: "REJECTED", code: "FIELD_TOO_LONG" });

    const badFlag = tamper(allModules() as any, (p) => (p.hard_red_flags = ["not:a_flag"]));
    expect(reason(() => buildCrmRecord(badFlag, OPTS))).toMatchObject({ code: "UNKNOWN_OPTION" });

    const tenRows = tamper(allModules() as any, (p) => (p.modules.extra = {}));
    expect(reason(() => buildCrmRecord(tenRows, OPTS))).toMatchObject({ kind: "REJECTED" });
  });

  it("attribution fields longer than the CRM text field are left out of the structured copy but kept in the raw payload", () => {
    const payload = tamper(payloadFrom(), (p) => (p.landing_page = `https://example.test/${"a".repeat(280)}`));
    const { record, degraded } = buildCrmRecord(payload, OPTS);
    expect(degraded).toEqual(["Landing_Page"]);
    expect(record["Landing_Page"]).toBeUndefined();
    expect(JSON.parse(record["Raw_Payload_JSON"] as string).landing_page).toBe(payload["landing_page"]);
  });

  it("supports optional Lead/Contact lookups for Sandbox ids only", () => {
    const payload = payloadFrom() as unknown as Record<string, unknown>;
    const { record } = buildCrmRecord(payload, { ...OPTS, lead: "6223361000127999001", contact: "6223361000127999002" });
    expect(record["Lead"]).toEqual({ id: "6223361000127999001" });
    expect(record["Contact"]).toEqual({ id: "6223361000127999002" });
    expect(reason(() => buildCrmRecord(payload, { ...OPTS, lead: "6067417000000000001" }))).toMatchObject({ code: "INVALID_LOOKUP_ID" });
    expect(reason(() => buildCrmRecord(payload, { ...OPTS, contact: "not-an-id" }))).toMatchObject({ code: "INVALID_LOOKUP_ID" });
  });

  it("buildModuleRows is empty without active modules", () => {
    expect(buildModuleRows(payloadFrom() as unknown as Record<string, unknown>)).toEqual([]);
  });

  it("toZohoDateTime rejects garbage", () => {
    expect(toZohoDateTime("2026-10-12T10:00:00.999Z")).toBe("2026-10-12T10:00:00+00:00");
    expect(reason(() => toZohoDateTime("nope"))).toMatchObject({ kind: "REJECTED" });
  });
});

describe("parseCrmRecord", () => {
  const build = (payload: Record<string, unknown>) => {
    const { record } = buildCrmRecord(payload, { ...OPTS, payloadHash: fingerprint(payload) });
    return { ...record, id: "6223361000127060100" };
  };

  it("round-trips the payload and exposes subform rows and extraction", () => {
    const payload = allModules() as unknown as Record<string, unknown>;
    const view = parseCrmRecord(build(payload), payload["submission_id"] as string);
    expect(view.stored.payload).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(view.moduleRows).toHaveLength(9);
    expect(extractModuleAnswer(view.stored.payload, "surgery")).toMatchObject({ diagnosis: "synthetic diagnosis" });
    expect(extractModuleAnswer(view.stored.payload, "nope")).toBeNull();
    expect(view.stored.record_ref).toBe("6223361000127060100");
  });

  it("detects a changed or truncated raw payload", () => {
    const payload = payloadFrom() as unknown as Record<string, unknown>;
    const rec: any = build(payload);
    rec.Raw_Payload_JSON = (rec.Raw_Payload_JSON as string).replace('"age":30', '"age":31');
    expect(reason(() => parseCrmRecord(rec, payload["submission_id"] as string))).toMatchObject({ kind: "CORRUPT", code: "HASH_MISMATCH" });
    rec.Raw_Payload_JSON = (rec.Raw_Payload_JSON as string).slice(0, 100);
    expect(reason(() => parseCrmRecord(rec, payload["submission_id"] as string))).toMatchObject({ kind: "CORRUPT", code: "RAW_JSON" });
  });

  it.each([["not an object"], [null], [{}]])("rejects unreadable records (%j)", (rec) => {
    expect(reason(() => parseCrmRecord(rec, "cns_00000000-0000-4000-8000-000000000001"))).toMatchObject({ kind: "CORRUPT" });
  });
});
