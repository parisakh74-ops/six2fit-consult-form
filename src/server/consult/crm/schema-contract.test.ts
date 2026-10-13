/* eslint-disable @typescript-eslint/no-explicit-any -- the snapshot and CRM bodies are loosely typed JSON */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EMAIL_MAX_LENGTH, allHealthFlags } from "../../../features/consult/assessmentConfig";
import { fingerprint } from "../canonical";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, payloadFrom, tamper } from "../fixtures";
import { validateConsultPayload } from "../validate";
import { CRM_OPTIONS, SUBFORM_OPTIONS, SUBFORM_NAME, buildCrmRecord, MAX_SUBFORM_ROWS } from "./mapping";

type Field = { a: string; t: string; l?: number; u?: number; o?: string[]; lk?: string };
const snapshot = JSON.parse(readFileSync(join(__dirname, "sandbox-schema.snapshot.json"), "utf8")) as {
  moduleApiName: string;
  subformMaxRows: number;
  parent: Field[];
  subform: Field[];
};
const parent = new Map(snapshot.parent.map((f) => [f.a, f]));
const sub = new Map(snapshot.subform.map((f) => [f.a, f]));

const OPTS = { receivedAt: new Date("2026-10-12T10:00:00Z"), payloadHash: "0".repeat(64), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" };

const checkValue = (name: string, f: Field, v: unknown): string[] => {
  const bad: string[] = [];
  const cps = (s: string) => [...s].length;
  switch (f.t) {
    case "text":
    case "email":
    case "textarea":
      if (typeof v !== "string") bad.push(`${name}: not a string`);
      else if (cps(v) > (f.l ?? 0)) bad.push(`${name}: ${cps(v)} > ${f.l}`);
      break;
    case "boolean":
      if (typeof v !== "boolean") bad.push(`${name}: not boolean`);
      break;
    case "integer":
      if (typeof v !== "number" || !Number.isInteger(v) || String(Math.abs(v)).length > (f.l ?? 0)) bad.push(`${name}: not an integer within ${f.l} digits`);
      break;
    case "double":
      if (typeof v !== "number" || !Number.isFinite(v)) bad.push(`${name}: not a number`);
      break;
    case "datetime":
      if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/.test(v)) bad.push(`${name}: datetime format`);
      break;
    case "picklist":
      if (typeof v !== "string" || !(f.o ?? []).includes(v)) bad.push(`${name}: option not in the CRM picklist`);
      break;
    case "multiselectpicklist":
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !(f.o ?? []).includes(x))) bad.push(`${name}: option not in the CRM multi-select`);
      break;
    case "lookup":
      if (!v || typeof v !== "object" || typeof (v as any).id !== "string") bad.push(`${name}: lookup shape`);
      break;
    default:
      bad.push(`${name}: unexpected type ${f.t}`);
  }
  return bad;
};

/** Every field filled, every health flag on, nine modules, attribution, lookups. */
const full = () => {
  const base = payloadFrom({
    health_flags: allHealthFlags.map((f) => f.code),
    adherence_barrier: ["motivation", "other"],
    adherence_barrier_other: "synthetic other",
    blocker_details: "synthetic blocker",
    ts_01_has_limitation: "yes",
    ts_02_categories: MODULE_KEYS,
    ts_03_clearance: "not_assessed",
    modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
    preferred_contact_timezone: "Europe/Istanbul",
  } as any);
  return tamper(base, (p) => {
    p.utm_source = "synthetic";
    p.utm_campaign = "synthetic";
    p.instagram_id = "synthetic";
    p.manychat_id = "123";
    p.landing_page = "https://example.test/consult";
  });
};

describe("mapping vs the audited CA Dev schema snapshot", () => {
  it("snapshot is for the expected module", () => {
    expect(snapshot.moduleApiName).toBe("Consultation_Submissions");
    expect(snapshot.subformMaxRows).toBe(MAX_SUBFORM_ROWS);
    expect(SUBFORM_NAME).toBe("Module_Answers");
  });

  it("the validator accepts the fully populated test payload", () => {
    expect(validateConsultPayload(full()).ok).toBe(true);
  });

  it("every mapped field exists in the CRM with a compatible type, length and option", () => {
    const { record, degraded } = buildCrmRecord(full(), { ...OPTS, payloadHash: fingerprint(full()), lead: "6223361000127999001", contact: "6223361000127999002" });
    expect(degraded).toEqual([]);
    const problems: string[] = [];
    for (const [key, value] of Object.entries(record)) {
      const f = parent.get(key);
      if (!f) {
        problems.push(`${key}: not a CRM field`);
        continue;
      }
      if (f.t === "subform") {
        const rows = value as Array<Record<string, unknown>>;
        if (!Array.isArray(rows) || rows.length > snapshot.subformMaxRows) problems.push(`${key}: row limit`);
        for (const row of rows) {
          for (const [rk, rv] of Object.entries(row)) {
            const sf = sub.get(rk);
            if (!sf) problems.push(`${key}.${rk}: not a subform column`);
            else problems.push(...checkValue(`${key}.${rk}`, sf, rv));
          }
        }
      } else problems.push(...checkValue(key, f, value));
    }
    expect(problems).toEqual([]);
  });

  it("fields that the mapping never sets are exactly the known, intentional ones", () => {
    const { record } = buildCrmRecord(full(), { ...OPTS, lead: "6223361000127999001", contact: "6223361000127999002" });
    const unmapped = snapshot.parent.map((f) => f.a).filter((a) => !(a in record)).sort();
    // Identity_Match: later identity phase. Raw_Payload_Overflow: reserved for the (unapproved) attachment fallback.
    expect(unmapped).toEqual(["Identity_Match", "Raw_Payload_Overflow"]);
  });

  it("the nine active modules map to nine subform rows that use only existing columns", () => {
    const { record } = buildCrmRecord(full(), OPTS);
    const rows = record[SUBFORM_NAME] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(9);
    for (const r of rows) for (const k of Object.keys(r)) expect(sub.has(k), k).toBe(true);
  });

  it("local option sets equal the CRM picklists (both directions)", () => {
    const pairs: Array<[string, ReadonlySet<string>]> = [
      ...Object.entries(CRM_OPTIONS).map(([k, v]) => [k, v] as [string, ReadonlySet<string>]),
    ];
    for (const [field, set] of pairs) {
      const f = parent.get(field);
      expect(f, field).toBeDefined();
      expect([...set].sort(), field).toEqual([...(f?.o ?? [])].sort());
    }
    for (const [field, set] of Object.entries(SUBFORM_OPTIONS)) {
      expect([...set].sort(), field).toEqual([...(sub.get(field)?.o ?? [])].sort());
    }
    expect([...CRM_OPTIONS.Sport_Categories].sort()).toEqual([...(sub.get("Module")?.o ?? [])].sort());
  });

  it("the CRM unique field is Submission_ID only and the record name fits the submission id", () => {
    expect(snapshot.parent.filter((f) => f.u).map((f) => f.a)).toEqual(["Submission_ID"]);
    expect(parent.get("Name")?.l).toBeGreaterThanOrEqual(`cns_${"f".repeat(80)}`.length);
  });
});

describe("known length gaps between the validated payload and the CRM structured fields", () => {
  it("lists every validated bound that exceeds its CRM field (documented risk register)", () => {
    // payload bound (validate.ts) vs CRM length: only landing_page (300 > 255) exceeds after E1 (e-mail now 100).
    const gaps: Array<[string, number, number]> = [
      ["email", EMAIL_MAX_LENGTH, parent.get("Email")!.l!],
      ["landing_page", 300, parent.get("Landing_Page")!.l!],
      ["lead_full_name", 80, parent.get("Full_Name")!.l!],
      ["blocker_details", 500, parent.get("Blocker_Details")!.l!],
      ["adherence_barrier_other", 500, parent.get("Adherence_Barrier_Other")!.l!],
      ["utm_source", 120, parent.get("UTM_Source")!.l!],
      ["preferred_contact_timezone", 80, parent.get("Timezone")!.l!],
    ];
    expect(gaps.filter(([, payloadMax, crmMax]) => payloadMax > crmMax).map(([n]) => n)).toEqual(["landing_page"]);
    expect(EMAIL_MAX_LENGTH).toBe(parent.get("Email")!.l);
  });

  it("an e-mail over the CRM limit is refused by the validator and by the mapping (never omitted)", () => {
    const email = `${"a".repeat(64)}@${"b".repeat(30)}.example.test`; // 108 characters
    expect(email.length).toBeGreaterThan(100);
    const payload = tamper(payloadFrom(), (p) => {
      p.email = email;
      p.onboarding_prefill["ON-07"] = email;
    });
    expect(validateConsultPayload(payload).ok).toBe(false);
    expect(() => buildCrmRecord(payload, OPTS)).toThrow(/mapping: Email/);
  });
});
