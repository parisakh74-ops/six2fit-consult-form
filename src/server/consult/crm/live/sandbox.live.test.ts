/* eslint-disable @typescript-eslint/no-explicit-any -- live responses are inspected loosely */
/**
 * LIVE tests against the Zoho CRM CA DEV SANDBOX (Consultation_Submissions). Skipped unless
 * SIX2FIT_LIVE_SANDBOX=1 and the SIX2FIT_ZOHO_* variables are present (they are injected into the child
 * process environment by the operator's one-shot runner; never stored in files). Synthetic data only; ids carry
 * the prefix `cns_ffffffff-0000-4000-8000-` so they are recognisable. Records cannot be deleted by this integration
 * (no DELETE scope): the created ids are printed (`LIVE-RECORD`) for the evidence document.
 * Only the Consultation_Submissions module is touched; no Lead/Contact is read or written.
 */
import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../../canonical";
import { createConsultService } from "../../service";
import { StoreError, createConsultStore, type StoredConsult } from "../../store";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, payloadFrom, tamper } from "../../fixtures";
import { signHandoff, verifyHandoff } from "../../../staging-handoff";
import { CrmConsultStore } from "../crm-store";

vi.setConfig({ testTimeout: 240_000 });
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
  if (v && typeof v === "object") return depth > 6 ? "{...}" : Object.fromEntries(Object.entries(v as any).map(([k, x]) => [k, shape(x, depth + 1)]));
  return typeof v === "string" ? "string" : v === null ? null : typeof v;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Ids of records whose Submission_ID equals `id` according to the CRM search (exact match only). Search can lag behind a create. */
const searchIds = async (s: CrmConsultStore, id: string): Promise<string[]> => {
  const r = await client(s).request("GET", "/Consultation_Submissions/search", { query: { criteria: `(Submission_ID:equals:${id})`, fields: "id,Submission_ID" } });
  const data = r.status === 204 || !r.json || !Array.isArray(r.json.data) ? [] : r.json.data;
  return data.filter((x: any) => String(x.Submission_ID).toLowerCase() === id.toLowerCase()).map((x: any) => x.id);
};
const waitSearch = async (s: CrmConsultStore, id: string, maxMs = 150_000): Promise<string[]> => {
  const t0 = Date.now();
  for (;;) {
    const ids = await searchIds(s, id);
    if (ids.length > 0) {
      note("LIVE-SEARCH-LAG", { idSuffix: id.slice(-8), ms: Date.now() - t0 });
      return ids;
    }
    if (Date.now() - t0 > maxMs) {
      note("LIVE-SEARCH-LAG", { idSuffix: id.slice(-8), ms: `>${maxMs}` });
      return [];
    }
    await sleep(3000);
  }
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
    const immediate = await client(store).request("GET", `/Consultation_Submissions/${r.record.record_ref}`);
    note("LIVE-BY-ID-IMMEDIATE", { http: immediate.status, found: immediate.json?.data?.[0]?.Submission_ID === id });
    expect(immediate.json.data[0].Submission_ID).toBe(id);
    const searchNow = await searchIds(store, id);
    note("LIVE-SEARCH-IMMEDIATELY-AFTER-CREATE", { found: searchNow.length });
  });

  it("L2 retrieve by Submission_ID: complete Raw_Payload_JSON, hash, nine Module_Answers rows", async () => {
    const id = mkId(1);
    const p = nine(id);
    expect(await waitSearch(store, id)).toHaveLength(1);
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
    const rid = (await waitSearch(store, id))[0];
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
    const before = await waitSearch(store, id);
    const again = await store.create(id, rec(nine(id)));
    expect(again.status).toBe("exists");
    const after = await searchIds(store, id);
    expect(after).toHaveLength(1);
    expect(after[0]).toBe(before[0]);
    expect(again.record.record_ref).toBe(before[0]);
  });

  it("L5 duplicate Submission_ID: record the real DUPLICATE_DATA contract (direct insert, nothing created)", async () => {
    const id = mkId(1);
    const mapped = (await import("../mapping")).buildCrmRecord(nine(id), { receivedAt: new Date(), payloadHash: fingerprint(nine(id)), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" }).record;
    const r = await client(store).request("POST", "/Consultation_Submissions", { body: { data: [mapped], trigger: [] } });
    note("LIVE-RESPONSE-SHAPE duplicate-insert", { status: r.status, shape: shape(r.json) });
    const item = r.json?.data?.[0] ?? r.json;
    expect(item.code).toBe("DUPLICATE_DATA");
    note("LIVE-DUPLICATE-code/status", { http: r.status, code: item.code, detailsKeys: Object.keys(item.details ?? {}) });
    expect(await searchIds(store, id)).toHaveLength(1);
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
    expect(await waitSearch(store, id)).toHaveLength(1);
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
    expect(await waitSearch(store, id)).toHaveLength(1);
  });

  it("L9 Persian / Unicode round trip, including a large multi-byte raw payload", async () => {
    const id = mkId(4);
    const p = tamper(nine(id, { lead_full_name: "پریسا خداب", blocker_details: "توضیح آزمایشی ".repeat(30) }), (x) => (x.x_fill = "سلام دنیا ".repeat(2500)));
    const raw = JSON.stringify(p).length;
    expect(raw).toBeLessThan(31_000);
    // First write under a deliberately tiny client timeout (150 ms): the request is aborted client-side, Zoho may still
    // process it. The adapter must end with at most ONE logical submission (ambiguous-write recovery).
    await store.get(mkId(9)); // warms the environment guard with the normal timeout
    const cfg = (store as any).deps.config as { requestTimeoutMs: number };
    const normalTimeout = cfg.requestTimeoutMs;
    cfg.requestTimeoutMs = 150;
    let outcome = "";
    try {
      outcome = (await store.create(id, rec(p))).status;
    } catch (e) {
      outcome = e instanceof StoreError ? `StoreError ${e.kind}:${e.code}` : "other error";
    } finally {
      cfg.requestTimeoutMs = normalTimeout;
    }
    note("LIVE-TIMEOUT-WRITE-OUTCOME", outcome);
    let ids = await waitSearch(store, id, 90_000);
    note("LIVE-TIMEOUT-WRITE-RECORDS-AFTER", ids.length);
    if (ids.length === 0) {
      // the aborted request never reached Zoho: a normal retry creates it (still exactly one record in total)
      const r2 = await store.create(id, rec(p));
      expect(r2.status).toBe("created");
      ids = await waitSearch(store, id);
    }
    expect(ids).toHaveLength(1);
    created.push(`${id} -> ${ids[0]}`);
    note("LIVE-RECORD", `${id} -> ${ids[0]} (raw chars ${raw})`);
    const again9 = await store.create(id, rec(p));
    expect(again9.status).toBe("exists");
    expect(again9.record.record_ref).toBe(ids[0]);
    const rid = ids[0];
    const view = await store.getSubmission(id);
    expect(view!.stored.payload).toEqual(p);
    const got = await client(store).request("GET", `/Consultation_Submissions/${rid}`);
    expect(got.json.data[0].Full_Name).toBe("پریسا خداب");
  });

  it("L10 field-length validation: the CRM rejects an over-long field and stores nothing (direct insert)", async () => {
    const id = mkId(5);
    const mapped = (await import("../mapping")).buildCrmRecord(nine(id), { receivedAt: new Date(), payloadHash: fingerprint(nine(id)), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" }).record;
    const bad = { ...mapped, Blocker_Details: "ب".repeat(2001) };
    const r = await client(store).request("POST", "/Consultation_Submissions", { body: { data: [bad], trigger: [] } });
    note("LIVE-RESPONSE-SHAPE invalid-length", { status: r.status, shape: shape(r.json), code: r.json?.data?.[0]?.code ?? r.json?.code });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await waitSearch(store, id, 20_000)).toHaveLength(0);
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
