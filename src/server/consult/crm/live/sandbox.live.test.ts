/* eslint-disable @typescript-eslint/no-explicit-any -- live responses are inspected loosely */
/**
 * LIVE tests against the Zoho CRM CA DEV SANDBOX (Consultation_Submissions). Skipped unless
 * SIX2FIT_LIVE_SANDBOX=1 and the SIX2FIT_ZOHO_* variables are present (they are injected into the child
 * process environment by the operator's one-shot runner; never stored in files). Synthetic data only; ids carry
 * the prefix `cns_ffffffff-0000-4000-8000-` so they are recognisable. Records cannot be deleted by this integration
 * (no DELETE scope): the created ids are printed (`LIVE-RECORD`) for the evidence document.
 * Only the Consultation_Submissions module is touched; no Lead/Contact is read or written.
 */
import { describe, expect, it } from "vitest";
import { fingerprint } from "../../canonical";
import { createConsultService } from "../../service";
import { StoreError, createConsultStore, type StoredConsult } from "../../store";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, payloadFrom, tamper } from "../../fixtures";
import { signHandoff, verifyHandoff } from "../../../staging-handoff";
import { CrmConsultStore } from "../crm-store";

const LIVE = process.env["SIX2FIT_LIVE_SANDBOX"] === "1";
const RUN = Date.now().toString(16).padStart(12, "0").slice(-12);
const mkId = (n: number) => `cns_ffffffff-0000-4000-8000-${RUN.slice(0, 8)}${n.toString(16).padStart(4, "0")}`;
const created: string[] = [];
const note = (label: string, v: unknown) => console.log(`LIVE ${label}: ${typeof v === "string" ? v : JSON.stringify(v)}`);

const cache = new Map<string, any>();
/** One payload object per (id, overrides): the builder stamps `submitted_at` with the current time on every call. */
const nine = (id: string, over: Record<string, unknown> = {}) => {
  const key = id + JSON.stringify(over);
  if (!cache.has(key)) cache.set(key, buildNine(id, over));
  return cache.get(key);
};
const buildNine = (id: string, over: Record<string, unknown> = {}) =>
  payloadFrom(
    {
      lead_full_name: "Synthetic Live Test",
      email: "synthetic.live@example.invalid",
      ts_01_has_limitation: "yes",
      ts_02_categories: MODULE_KEYS,
      ts_03_clearance: "not_assessed",
      modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
      ...over,
    } as any,
    id,
  ) as any;
const rec = (payload: any): StoredConsult => ({ version: 2, submission_id: payload.submission_id, payload_hash: fingerprint(payload), payload, record_ref: "local", created_at: new Date().toISOString() });
const asStore = () => createConsultStore(process.env as Record<string, string>, "unused") as CrmConsultStore;
const client = (s: CrmConsultStore) => (s as any).deps.client as { request: (m: "GET" | "POST", p: string, o?: any) => Promise<{ status: number; json: any }> };
const shape = (v: unknown, depth = 0): unknown => {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return depth > 3 ? "{...}" : Object.fromEntries(Object.entries(v as any).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v === "string" ? "string" : v === null ? null : typeof v;
};

describe.skipIf(!LIVE)("LIVE CA Dev sandbox: Consultation_Submissions", () => {
  const store = LIVE ? asStore() : (undefined as unknown as CrmConsultStore);

  it("L1 create one synthetic submission (guard verifies zgid/type/module first)", async () => {
    const id = mkId(1);
    const p = nine(id);
    const r = await store.create(id, rec(p));
    expect(r.status).toBe("created");
    expect(r.record.record_ref).toMatch(/^\d{10,25}$/);
    created.push(`${id} -> ${r.record.record_ref}`);
    note("LIVE-RECORD", `${id} -> ${r.record.record_ref}`);
  });

  it("L2 retrieve by Submission_ID: complete Raw_Payload_JSON, hash, nine Module_Answers rows", async () => {
    const id = mkId(1);
    const p = nine(id);
    const view = await store.getSubmission(id);
    expect(view).not.toBeNull();
    expect(view!.stored.payload).toEqual(p);
    expect(view!.stored.payload_hash).toBe(fingerprint(p));
    expect(view!.moduleRows).toHaveLength(9);
    expect(view!.moduleRows.map((r) => r["Module"]).sort()).toEqual([...MODULE_KEYS].sort());
    for (const row of view!.moduleRows) expect(Object.keys(row).sort()).toEqual(expect.arrayContaining(["Diagnosis", "Module", "Onset", "Pain", "Reaction", "Recovery", "Clearance", "Red_Flags", "Module_Score", "Module_Notes"]));
  });

  it("L3 structured parent fields match the mapping (raw record read)", async () => {
    const id = mkId(1);
    const p = nine(id);
    const search = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    const rid = search.json.data[0].id;
    const got = await client(store).request("GET", `/Consultation_Submissions/${rid}`);
    const r = got.json.data[0];
    note("LIVE-RESPONSE-SHAPE get-by-id", shape(r));
    expect(r.Submission_ID).toBe(id);
    expect(r.Name).toBe(id);
    expect(r.Status).toBe("Received");
    expect(r.Full_Name).toBe("Synthetic Live Test");
    expect(r.Email).toBe("synthetic.live@example.invalid");
    expect(r.Age).toBe(p.age);
    expect(r.Safety_Outcome).toBe(p.safety_outcome);
    expect(r.Review_Required).toBe(p.review_required);
    expect([...r.Hard_Red_Flags].sort()).toEqual([...p.hard_red_flags].sort());
    expect([...r.Sport_Categories].sort()).toEqual([...MODULE_KEYS].sort());
    expect(r.Lead ?? null).toBeNull();
    expect(r.Contact ?? null).toBeNull();
    expect(JSON.parse(r.Raw_Payload_JSON)).toEqual(p);
    expect(r.Payload_Hash).toBe(fingerprint(p));
    expect(Array.isArray(r.Module_Answers) && r.Module_Answers.length === 9).toBe(true);
  });

  it("L4 identical retry returns the existing record, no second record", async () => {
    const id = mkId(1);
    const before = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    const again = await store.create(id, rec(nine(id)));
    expect(again.status).toBe("exists");
    const after = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    expect(after.json.data).toHaveLength(1);
    expect(after.json.data[0].id).toBe(before.json.data[0].id);
  });

  it("L5 duplicate Submission_ID: record the real DUPLICATE_DATA contract (direct insert, nothing created)", async () => {
    const id = mkId(1);
    const mapped = (await import("../mapping")).buildCrmRecord(nine(id), { receivedAt: new Date(), payloadHash: fingerprint(nine(id)), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" }).record;
    const r = await client(store).request("POST", "/Consultation_Submissions", { body: { data: [mapped], trigger: [] } });
    note("LIVE-RESPONSE-SHAPE duplicate-insert", { status: r.status, shape: shape(r.json) });
    const item = r.json?.data?.[0] ?? r.json;
    expect(item.code).toBe("DUPLICATE_DATA");
    note("LIVE-DUPLICATE-code/status", { http: r.status, code: item.code, detailsKeys: Object.keys(item.details ?? {}) });
    const search = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    expect(search.json.data).toHaveLength(1);
  });

  it("L6 case variant of the id is the same submission (unique field is case-insensitive)", async () => {
    const id = mkId(1);
    const upper = id.toUpperCase().replace(/^CNS_/, "cns_");
    expect(upper).not.toBe(id);
    const r = await store.create(upper, rec(nine(upper)));
    expect(r.status).toBe("exists");
  });

  it("L7 service + CrmStore: created, deduplicated retry, conflicting retry (409), Onboarding token intact", async () => {
    const SECRET = "synthetic-live-secret-0123456789abcdef";
    const service = createConsultService({ store, tokenSecret: SECRET, onboardingBaseUrl: new URL("https://onboarding-staging.example.test/"), log: () => undefined });
    const id = mkId(2);
    const p = nine(id);
    const send = (x: any) => service.submit({ contentType: "application/json; charset=utf-8", idempotencyKey: x.submission_id, body: JSON.stringify(x) });
    const first = await send(p);
    expect(first.status).toBe(200);
    expect((first.body as any).deduplicated).toBe(false);
    expect((first.body as any).crm_record_id).toMatch(/^\d{10,25}$/);
    created.push(`${id} -> ${(first.body as any).crm_record_id}`);
    note("LIVE-RECORD", `${id} -> ${(first.body as any).crm_record_id}`);
    const claims = verifyHandoff(new URL((first.body as any).onboarding_url).searchParams.get("session") as string, SECRET);
    expect(claims.consult_submission_id).toBe(id);
    expect(typeof signHandoff).toBe("function");
    const retry = await send(tamper(p, (x) => (x.submitted_at = "2026-10-13T12:00:00.000Z")));
    expect(retry.status).toBe(200);
    expect((retry.body as any).deduplicated).toBe(true);
    expect((retry.body as any).crm_record_id).toBe((first.body as any).crm_record_id);
    const conflict = await send(nine(id, { age: 41 }));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ ok: false, error_code: "SUBMISSION_CONFLICT" });
    const count = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    expect(count.json.data).toHaveLength(1);
    // the stored answers are still the original ones
    expect((await store.get(id))!.payload).toEqual(p);
  });

  it("L8 concurrent identical submissions create exactly one record", async () => {
    const id = mkId(3);
    const p = nine(id);
    const results = await Promise.all(Array.from({ length: 4 }, () => store.create(id, rec(p))));
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.record.record_ref)).size).toBe(1);
    const created1 = results.find((r) => r.status === "created")!;
    created.push(`${id} -> ${created1.record.record_ref}`);
    note("LIVE-RECORD", `${id} -> ${created1.record.record_ref}`);
    const count = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    expect(count.json.data).toHaveLength(1);
  });

  it("L9 Persian / Unicode round trip, including a large multi-byte raw payload", async () => {
    const id = mkId(4);
    const p = tamper(nine(id, { lead_full_name: "پریسا خداب", blocker_details: "توضیح آزمایشی ".repeat(30) }), (x) => (x.x_fill = "سلام دنیا ".repeat(2500)));
    const raw = JSON.stringify(p).length;
    expect(raw).toBeLessThan(31_000);
    const r = await store.create(id, rec(p));
    expect(r.status).toBe("created");
    created.push(`${id} -> ${r.record.record_ref}`);
    note("LIVE-RECORD", `${id} -> ${r.record.record_ref} (raw chars ${raw})`);
    const view = await store.getSubmission(id);
    expect(view!.stored.payload).toEqual(p);
    const search = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    const got = await client(store).request("GET", `/Consultation_Submissions/${search.json.data[0].id}`);
    expect(got.json.data[0].Full_Name).toBe("پریسا خداب");
  });

  it("L10 field-length validation: the CRM rejects an over-long field and stores nothing (direct insert)", async () => {
    const id = mkId(5);
    const mapped = (await import("../mapping")).buildCrmRecord(nine(id), { receivedAt: new Date(), payloadHash: fingerprint(nine(id)), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" }).record;
    const bad = { ...mapped, Blocker_Details: "ب".repeat(2001) };
    const r = await client(store).request("POST", "/Consultation_Submissions", { body: { data: [bad], trigger: [] } });
    note("LIVE-RESPONSE-SHAPE invalid-length", { status: r.status, shape: shape(r.json), code: r.json?.data?.[0]?.code ?? r.json?.code });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const search = await client(store).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id" } });
    expect(search.status === 204 || (search.json?.data ?? []).length === 0).toBe(true);
  });

  it("L11 authentication failure: a bogus token is rejected with a safe 401 (no quota use beyond one call)", async () => {
    const res = await fetch(`${(store as any).deps.config.apiDomain}/crm/v8/Consultation_Submissions/search?criteria=${encodeURIComponent("(Submission_ID:equals:cns_ffffffff-0000-4000-8000-000000000000)")}`, { headers: { authorization: "Zoho-oauthtoken invalid-synthetic-token" } });
    const j: any = await res.json().catch(() => null);
    note("LIVE-RESPONSE-SHAPE bad-token", { status: res.status, code: j?.code });
    expect(res.status).toBe(401);
  });

  it("L12 oversized payload is refused locally before any request; nothing is stored", async () => {
    const id = mkId(6);
    const big = tamper(nine(id), (x) => (x.x_fill = "a".repeat(31_500)));
    try {
      await store.create(id, rec(big));
      throw new Error("expected refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("TOO_LARGE");
    }
    expect(await store.get(id)).toBeNull();
  });

  it("L13 summary of created records", () => {
    note("LIVE-RECORDS-CREATED", created);
    expect(created.length).toBeGreaterThanOrEqual(3);
  });
});
