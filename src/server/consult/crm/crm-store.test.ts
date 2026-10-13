/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed JSON bodies and fault objects */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signHandoff, verifyHandoff } from "../../staging-handoff";
import { fingerprint } from "../canonical";
import { createConsultService } from "../service";
import { StoreError, createConsultStore, type StoredConsult } from "../store";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, newId, payloadFrom, tamper } from "../fixtures";
import { CrmConsultStore } from "./crm-store";
import { createCrmConsultStore } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

const ENV: Record<string, string> = {
  SIX2FIT_CONSULT_STORE: "crm",
  SIX2FIT_CONSULT_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client",
  SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ZOHO_TIMEOUT_MS: "40",
};
const SECRET = "synthetic-test-secret-0123456789abcdef-xyz";
const BASE = new URL("https://onboarding-staging.example.test/");
const JSON_CT = "application/json; charset=utf-8";

let networkSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  // Any code path that reaches the real network would fail the test: the adapter only gets the mock.
  networkSpy = vi.fn(() => {
    throw new Error("REAL NETWORK ACCESS ATTEMPTED");
  });
  vi.stubGlobal("fetch", networkSpy);
});
afterEach(() => {
  expect(networkSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function setup(envOver: Record<string, string> = {}, extra: { associations?: (id: string, p: any) => any } = {}) {
  const zoho = new MockZoho();
  const sleeps: number[] = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let clock = Date.UTC(2026, 9, 12, 10, 0, 0);
  const env = { ...ENV, ...envOver };
  const store = createCrmConsultStore(env, {
    fetch: zoho.fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    log: (event, fields) => logs.push({ event, fields }),
  }) as CrmConsultStore;
  if (extra.associations) (store as any).deps.associations = extra.associations;
  return { zoho, store, sleeps, logs, advance: (ms: number) => (clock += ms) };
}

const recordFor = (payload: any): StoredConsult => ({
  version: 2,
  submission_id: payload.submission_id,
  payload_hash: fingerprint(payload),
  payload,
  record_ref: `staging_${payload.submission_id}`,
  created_at: "2026-10-12T10:00:00.000Z",
});
const nine = (id = newId(1)) =>
  payloadFrom(
    {
      ts_01_has_limitation: "yes",
      ts_02_categories: MODULE_KEYS,
      ts_03_clearance: "not_assessed",
      modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
    } as any,
    id,
  ) as any;
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Consultation_Submissions").length;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    return e as StoreError;
  }
  throw new Error("expected a StoreError");
};

describe("create / get / round trip", () => {
  it("1+2+3+4: creates one record, retrieves it by Submission_ID with the full payload and nine rows", async () => {
    const { zoho, store } = setup();
    const payload = nine();
    const r = await store.create(payload.submission_id, recordFor(payload));
    expect(r.status).toBe("created");
    expect(r.record.record_ref).toMatch(/^\d+$/);
    expect(zoho.records).toHaveLength(1);
    expect(zoho.records[0]).toMatchObject({ Submission_ID: payload.submission_id, Status: "Received", Name: payload.submission_id });

    const view = await store.getSubmission(payload.submission_id);
    expect(view?.stored.payload).toEqual(payload);
    expect(view?.stored.payload_hash).toBe(fingerprint(payload));
    expect(view?.moduleRows).toHaveLength(9);
    expect(view?.moduleRows.map((x) => x["Module"]).sort()).toEqual([...MODULE_KEYS].sort());
    expect((await store.get(payload.submission_id))?.record_ref).toBe(r.record.record_ref);
    expect(await store.get(newId(99))).toBeNull();
  });

  it("sends trigger: [] (no workflows), bearer token, no upsert and no update", async () => {
    const { zoho, store } = setup();
    await store.create(newId(1), recordFor(nine()));
    expect(zoho.requests.every((r) => r.method === "GET" || r.method === "POST")).toBe(true);
    expect(zoho.requests.filter((r) => r.path.startsWith("/crm/v8/Consultation_Submissions")).every((r) => r.auth)).toBe(true);
    expect(zoho.requests.some((r) => /upsert|update/i.test(r.path))).toBe(false);
    expect(zoho.tokenCalls).toBe(1);
  });

  it("16: preserves a Persian payload and a very large multibyte payload without truncation", async () => {
    const { zoho, store } = setup();
    const id = newId(2);
    const payload = tamper(payloadFrom({ lead_full_name: "علی رضایی" } as any, id), (p) => (p.x_fill = "سلام دنیا ".repeat(2800)));
    const rawChars = JSON.stringify(payload).length;
    expect(rawChars).toBeGreaterThan(28_000);
    expect(rawChars).toBeLessThan(31_000);
    expect(new TextEncoder().encode(JSON.stringify(payload)).length).toBeGreaterThan(40_000);
    await store.create(id, recordFor(payload));
    expect(zoho.records[0]!["Full_Name"]).toBe("علی رضایی");
    expect((await store.get(id))?.payload).toEqual(payload);
  });

  it("17: sets optional Lead/Contact lookups without creating or updating anything else", async () => {
    const { zoho, store } = setup({}, { associations: () => ({ lead: "6223361000127999001" }) });
    await store.create(newId(3), recordFor(nine(newId(3))));
    expect(zoho.records[0]!["Lead"]).toEqual({ id: "6223361000127999001" });
    expect(zoho.records[0]!["Contact"]).toBeUndefined();
    expect(zoho.requests.filter((r) => /leads|contacts/i.test(r.path))).toHaveLength(0);
    const view = await store.getSubmission(newId(3));
    expect(view?.lead).toBe("6223361000127999001");
  });

  it("a Production lookup id is refused before any request", async () => {
    const { zoho, store } = setup({}, { associations: () => ({ lead: "6067417000000000001" }) });
    const e = await fails(store.create(newId(3), recordFor(nine(newId(3)))));
    expect(e).toMatchObject({ kind: "REJECTED", code: "INVALID_LOOKUP_ID" });
    expect(zoho.requests).toHaveLength(0);
  });

  it("an association provider that returns nothing never blocks persistence", async () => {
    const { zoho, store } = setup({}, { associations: () => undefined });
    expect((await store.create(newId(4), recordFor(nine(newId(4))))).status).toBe("created");
    expect(zoho.records[0]!["Lead"]).toBeUndefined();
  });
});

describe("duplicates and retries", () => {
  it("5+6: duplicate Submission_ID returns the existing record (never overwritten); changed answers differ by hash", async () => {
    const { zoho, store } = setup();
    const id = newId(5);
    const first = nine(id);
    await store.create(id, recordFor(first));
    const before = JSON.stringify(zoho.records[0]);
    const different = tamper(first, (p) => (p.age = 31));
    const again = await store.create(id, recordFor(different));
    expect(again.status).toBe("exists");
    expect(again.record.payload_hash).toBe(fingerprint(first));
    expect(again.record.payload_hash).not.toBe(fingerprint(different));
    expect(zoho.records).toHaveLength(1);
    expect(JSON.stringify(zoho.records[0])).toBe(before);
  });

  it("an upper-case variant of an existing id is a duplicate too (case-insensitive unique field)", async () => {
    const { zoho, store } = setup();
    const id = newId(5);
    await store.create(id, recordFor(nine(id)));
    const upper = id.toUpperCase().replace("CNS_", "cns_");
    const r = await store.create(upper, recordFor(nine(upper)));
    expect(r.status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
  });

  it("7: identical retry returns exists with the same record reference", async () => {
    const { zoho, store } = setup();
    const id = newId(6);
    const a = await store.create(id, recordFor(nine(id)));
    const b = await store.create(id, recordFor(nine(id)));
    expect(b.status).toBe("exists");
    expect(b.record.record_ref).toBe(a.record.record_ref);
    expect(zoho.records).toHaveLength(1);
  });

  it("7: concurrent identical creates produce exactly one record", async () => {
    const { zoho, store } = setup();
    const id = newId(7);
    const results = await Promise.all(Array.from({ length: 6 }, () => store.create(id, recordFor(nine(id)))));
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    expect(results.filter((r) => r.status === "exists")).toHaveLength(5);
    expect(new Set(results.map((r) => r.record.record_ref)).size).toBe(1);
    expect(zoho.records).toHaveLength(1);
  });

  it("duplicate reported without an id falls back to the search (index lag tolerated)", async () => {
    const { zoho, store } = setup();
    const id = newId(8);
    await store.create(id, recordFor(nine(id)));
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 400, body: { data: [{ code: "DUPLICATE_DATA", details: { api_name: "Submission_ID" }, status: "error" }] } }, 1, "POST");
    zoho.failNext(/search$/, { kind: "status", status: 204 }, 1);
    const r = await store.create(id, recordFor(nine(id)));
    expect(r.status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
  });

  it("duplicate that never becomes readable ends in a retryable error", async () => {
    const { zoho, store } = setup();
    const id = newId(8);
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 400, body: { data: [{ code: "DUPLICATE_DATA", details: { api_name: "Submission_ID" }, status: "error" }] } }, 1, "POST");
    expect(await fails(store.create(id, recordFor(nine(id))))).toMatchObject({ kind: "UNAVAILABLE", code: "DUPLICATE_UNRESOLVED" });
    expect(zoho.records).toHaveLength(0);
  });
});

describe("timeouts and ambiguous outcomes", () => {
  it("8: timeout after the record was stored -> found by lookup, no second record", async () => {
    const { zoho, store, logs } = setup();
    const id = newId(9);
    zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 1, "POST");
    const r = await store.create(id, recordFor(nine(id)));
    expect(r.status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
    expect(posts(zoho)).toBe(1);
    expect(logs.some((l) => l.event === "crm.ambiguous")).toBe(true);
  });

  it("9: timeout with nothing stored -> retried once the lookup proves it is absent", async () => {
    const { zoho, store, sleeps } = setup();
    const id = newId(10);
    zoho.failNext(/Consultation_Submissions$/, { kind: "timeout" }, 1, "POST");
    const r = await store.create(id, recordFor(nine(id)));
    expect(r.status).toBe("created");
    expect(zoho.records).toHaveLength(1);
    expect(posts(zoho)).toBe(2);
    expect(sleeps).toEqual([500]);
  });

  it("persistent timeouts end in an error without data loss claims and without duplicates", async () => {
    const { zoho, store } = setup();
    const id = newId(10);
    zoho.failNext(/Consultation_Submissions$/, { kind: "timeout" }, 5, "POST");
    expect(await fails(store.create(id, recordFor(nine(id))))).toMatchObject({ kind: "UNAVAILABLE", code: "TIMEOUT" });
    expect(zoho.records).toHaveLength(0);
    expect(posts(zoho)).toBe(3);
  });

  it("network error then success", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "network" }, 1, "POST");
    expect((await store.create(newId(11), recordFor(nine(newId(11))))).status).toBe("created");
  });

  it("stored but answered with 5xx -> lookup finds it", async () => {
    const { zoho, store } = setup();
    const id = newId(12);
    zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-status", status: 503 }, 1, "POST");
    expect((await store.create(id, recordFor(nine(id)))).status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
  });

  it("lookup also failing keeps the outcome ambiguous (AMBIGUOUS) and never invents success", async () => {
    const { zoho, store } = setup();
    const id = newId(13);
    zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 3, "POST");
    zoho.failNext(/search$/, { kind: "status", status: 503 }, 5);
    const e = await fails(store.create(id, recordFor(nine(id))));
    expect(e).toMatchObject({ kind: "UNAVAILABLE", code: "AMBIGUOUS" });
    // A later client retry is safe and finds the stored record.
    const retry = await store.create(id, recordFor(nine(id)));
    expect(retry.status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
  });
});

describe("HTTP error mapping", () => {
  it("10: 401 refreshes the token once and then succeeds", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 401, body: { code: "INVALID_TOKEN" } }, 1, "POST");
    expect((await store.create(newId(14), recordFor(nine(newId(14))))).status).toBe("created");
    expect(zoho.tokenCalls).toBe(2);
  });

  it("10: persistent 401 -> AUTH_FAILED, nothing stored", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 401, body: { code: "INVALID_TOKEN" } }, 4, "POST");
    expect(await fails(store.create(newId(14), recordFor(nine(newId(14)))))).toMatchObject({ kind: "UNAVAILABLE", code: "AUTH_FAILED" });
    expect(zoho.records).toHaveLength(0);
  });

  it("10: 403 -> FORBIDDEN, not retried", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 403, body: { code: "NO_PERMISSION" } }, 1, "POST");
    expect(await fails(store.create(newId(15), recordFor(nine(newId(15)))))).toMatchObject({ code: "FORBIDDEN" });
    expect(posts(zoho)).toBe(1);
  });

  it("token endpoint refusal -> AUTH_FAILED without leaking credentials", async () => {
    const { store } = setup({ SIX2FIT_ZOHO_REFRESH_TOKEN: "wrong-refresh" });
    const e = await fails(store.create(newId(16), recordFor(nine(newId(16)))));
    expect(e.code).toBe("AUTH_FAILED");
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toMatch(/wrong-refresh|synthetic-secret/);
  });

  it("11: 429 waits for Retry-After and retries without a lookup", async () => {
    const { zoho, store, sleeps } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 429, headers: { "retry-after": "2" }, body: { code: "TOO_MANY_REQUESTS" } }, 1, "POST");
    expect((await store.create(newId(17), recordFor(nine(newId(17))))).status).toBe("created");
    expect(sleeps).toEqual([2000]);
    expect(zoho.requests.filter((r) => r.path.endsWith("/search"))).toHaveLength(0);
  });

  it("11: persistent 429 -> RATE_LIMITED", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 429, body: {} }, 5, "POST");
    expect(await fails(store.create(newId(17), recordFor(nine(newId(17)))))).toMatchObject({ code: "RATE_LIMITED" });
    expect(zoho.records).toHaveLength(0);
  });

  it("12: 5xx without persistence is retried after the lookup proves absence", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 503, body: {} }, 2, "POST");
    expect((await store.create(newId(18), recordFor(nine(newId(18))))).status).toBe("created");
    expect(posts(zoho)).toBe(3);
    expect(zoho.records).toHaveLength(1);
  });

  it("12: persistent 5xx -> UPSTREAM_5XX", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 500, body: {} }, 9, "POST");
    expect(await fails(store.create(newId(18), recordFor(nine(newId(18)))))).toMatchObject({ kind: "UNAVAILABLE", code: "UPSTREAM_5XX" });
  });

  it("13: unreadable create response (HTML) is ambiguous: lookup then retry", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "garbage", status: 200 }, 1, "POST");
    expect((await store.create(newId(19), recordFor(nine(newId(19))))).status).toBe("created");
    expect(zoho.records).toHaveLength(1);
  });

  it("13: success body without an id is never trusted", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 201, body: { data: [{ code: "SUCCESS", details: {} }] } }, 1, "POST");
    expect((await store.create(newId(19), recordFor(nine(newId(19))))).status).toBe("created");
    expect(zoho.records).toHaveLength(1);
  });

  it("13: invalid search / read responses fail closed", async () => {
    const { zoho, store } = setup();
    const id = newId(20);
    await store.create(id, recordFor(nine(id)));
    zoho.failNext(/search$/, { kind: "garbage" }, 1);
    expect(await fails(store.get(id))).toMatchObject({ code: "INVALID_RESPONSE" });
    zoho.failNext(/search$/, { kind: "status", status: 200, body: { nodata: true } }, 1);
    expect(await fails(store.get(id))).toMatchObject({ code: "INVALID_RESPONSE" });
    zoho.failNext(new RegExp(`/${zoho.records[0]!.id}$`), { kind: "status", status: 200, body: { data: [{ id: zoho.records[0]!.id, Submission_ID: id }] } }, 1);
    expect(await fails(store.get(id))).toMatchObject({ kind: "CORRUPT" });
  });

  it("14+field validation: a CRM validation failure is not retried and reports the field name only", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 400, body: { data: [{ code: "INVALID_DATA", details: { api_name: "Landing_Page" }, status: "error" }] } }, 1, "POST");
    const e = await fails(store.create(newId(21), recordFor(nine(newId(21)))));
    expect(e).toMatchObject({ kind: "REJECTED", code: "INVALID_DATA:Landing_Page" });
    expect(posts(zoho)).toBe(1);
  });

  it("14: mapping errors fail before any CRM call", async () => {
    const { zoho, store } = setup();
    const bad = tamper(nine(newId(22)), (p) => (p.safety_outcome = "PURPLE"));
    expect(await fails(store.create(newId(22), recordFor(bad)))).toMatchObject({ kind: "REJECTED", code: "UNKNOWN_OPTION" });
    expect(zoho.requests).toHaveLength(0);
  });

  it("15: oversized payload is refused before any CRM call, nothing is truncated", async () => {
    const { zoho, store } = setup();
    const id = newId(23);
    const big = tamper(nine(id), (p) => (p.x_fill = "a".repeat(31_100)));
    expect(await fails(store.create(id, recordFor(big)))).toMatchObject({ kind: "TOO_LARGE", code: "RAW_PAYLOAD_TOO_LARGE" });
    expect(zoho.requests).toHaveLength(0);
    expect(zoho.records).toHaveLength(0);
  });

  it("the CRM would reject what the guard lets through only above its own capacity (mock limit 32,000)", async () => {
    const { zoho, store } = setup({ SIX2FIT_ZOHO_MAX_RAW_CHARS: "32000" });
    const id = newId(24);
    const over = tamper(nine(id), (p) => (p.x_fill = "a".repeat(32_100)));
    expect(await fails(store.create(id, recordFor(over)))).toMatchObject({ kind: "TOO_LARGE" });
    zoho.rawLimit = 10_000; // simulate a smaller real capacity: INVALID_DATA is surfaced, not swallowed
    const ok = tamper(nine(id), (p) => (p.x_fill = "a".repeat(20_000)));
    expect(await fails(store.create(id, recordFor(ok)))).toMatchObject({ kind: "REJECTED", code: "INVALID_DATA:Raw_Payload_JSON" });
    expect(zoho.records).toHaveLength(0);
  });

  it("an edited CRM record is reported as corrupt, never as the original", async () => {
    const { zoho, store } = setup();
    const id = newId(25);
    await store.create(id, recordFor(nine(id)));
    zoho.records[0]!["Raw_Payload_JSON"] = (zoho.records[0]!["Raw_Payload_JSON"] as string).replace('"age":30', '"age":99');
    expect(await fails(store.get(id))).toMatchObject({ kind: "CORRUPT", code: "HASH_MISMATCH" });
  });
});

describe("environment safeguards (fail closed)", () => {
  it("CRM mode is disabled by default and without explicit enablement", () => {
    expect(() => createConsultStore({}, "unused")).not.toThrow(); // default is the file store
    expect(() => createConsultStore({ SIX2FIT_CONSULT_STORE: "crm" }, "unused")).toThrow(StoreError);
    expect(() => createCrmConsultStore({ ...ENV, SIX2FIT_CONSULT_CRM_ENABLED: "yes" })).toThrow(/not enabled/);
  });

  it.each([
    ["production environment", { SIX2FIT_ZOHO_ENVIRONMENT: "production" }],
    ["production api domain", { SIX2FIT_ZOHO_API_DOMAIN: "https://www.zohoapis.com" }],
    ["lookalike domain", { SIX2FIT_ZOHO_API_DOMAIN: "https://sandbox.zohoapis.com.evil.test" }],
    ["http api domain", { SIX2FIT_ZOHO_API_DOMAIN: "http://sandbox.zohoapis.com" }],
    ["accounts lookalike", { SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: "https://accounts.zoho.com.evil.test" }],
    ["missing org zgid", { SIX2FIT_ZOHO_ORG_ZGID: "" }],
    ["malformed org api id", { SIX2FIT_ZOHO_ORG_API_ID: "12ab" }],
    ["production id prefix", { SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6067417000" }],
    ["missing prefix", { SIX2FIT_ZOHO_MODULE_ID_PREFIX: "" }],
    ["missing client id", { SIX2FIT_ZOHO_CLIENT_ID: "" }],
    ["missing secret", { SIX2FIT_ZOHO_CLIENT_SECRET: "" }],
    ["missing refresh token", { SIX2FIT_ZOHO_REFRESH_TOKEN: "" }],
    ["bad numeric limit", { SIX2FIT_ZOHO_MAX_ATTEMPTS: "99" }],
    ["bad module name", { SIX2FIT_ZOHO_MODULE_API_NAME: "x; DROP" }],
  ])("18: refuses %s without echoing configuration values", (_name, over) => {
    let message = "";
    try {
      createCrmConsultStore({ ...ENV, ...over });
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      expect((e as StoreError).kind).toBe("NOT_CONFIGURED");
      message = (e as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toMatch(/synthetic|zohoapis|6067417000|x; DROP/);
  });

  it("18: organisation mismatch -> NOT_CONFIGURED, no write", async () => {
    const { zoho, store } = setup();
    zoho.orgId = "123456789";
    expect(await fails(store.create(newId(30), recordFor(nine(newId(30)))))).toMatchObject({ kind: "NOT_CONFIGURED", code: "ENV_MISMATCH" });
    expect(posts(zoho)).toBe(0);
  });

  it("18: Production module id -> NOT_CONFIGURED, no write", async () => {
    const { zoho, store } = setup();
    zoho.moduleId = "6067417000000999999";
    expect(await fails(store.create(newId(30), recordFor(nine(newId(30)))))).toMatchObject({ code: "ENV_MISMATCH" });
    expect(posts(zoho)).toBe(0);
    zoho.moduleId = "7777777000000000001";
    expect(await fails(store.get(newId(30)))).toMatchObject({ code: "ENV_MISMATCH" });
  });

  it("18: token api_domain: generic www host of the same data centre is accepted (observed), other hosts/data centres are refused", async () => {
    const ok = setup();
    ok.zoho.tokenApiDomain = "https://www.zohoapis.com";
    expect((await ok.store.create(newId(30), recordFor(nine(newId(30))))).status).toBe("created");
    for (const bad of ["https://www.zohoapis.eu", "https://developer.zohoapis.com", "https://evil.example", "http://www.zohoapis.com", "not a url"]) {
      const { zoho, store } = setup();
      zoho.tokenApiDomain = bad;
      expect(await fails(store.create(newId(30), recordFor(nine(newId(30)))))).toMatchObject({ kind: "NOT_CONFIGURED", code: "ENV_MISMATCH" });
      expect(posts(zoho)).toBe(0);
    }
  });

  it("18: unreadable organisation or module answers cannot be verified -> no write", async () => {
    const a = setup();
    a.zoho.failNext(/\/org$/, { kind: "status", status: 200, body: { org: [] } }, 1);
    expect(await fails(a.store.create(newId(31), recordFor(nine(newId(31)))))).toMatchObject({ code: "ENV_UNVERIFIED" });
    const b = setup();
    b.zoho.failNext(/settings\/modules/, { kind: "status", status: 404, body: {} }, 1);
    expect(await fails(b.store.create(newId(31), recordFor(nine(newId(31)))))).toMatchObject({ code: "ENV_UNVERIFIED" });
    expect(posts(a.zoho) + posts(b.zoho)).toBe(0);
  });

  it("verification is cached and repeated after the TTL", async () => {
    const { zoho, store, advance } = setup();
    await store.create(newId(32), recordFor(nine(newId(32))));
    await store.get(newId(32));
    const orgCalls = () => zoho.requests.filter((r) => r.path === "/crm/v8/org").length;
    expect(orgCalls()).toBe(1);
    advance(16 * 60 * 1000);
    await store.get(newId(32));
    expect(orgCalls()).toBe(2);
  });

  it("19: no secret or answer ever reaches the diagnostics", async () => {
    const { zoho, store, logs } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "timeout" }, 1, "POST");
    const id = newId(33);
    await store.create(id, recordFor(tamper(nine(id), (p) => (p.lead_full_name = "Synthetic Secret Person"))));
    const text = JSON.stringify(logs);
    expect(text).not.toMatch(/synthetic-secret|synthetic-refresh|synthetic-access|Synthetic Secret Person|Zoho-oauthtoken/);
  });
});

describe("service integration (contract, idempotency, Onboarding token)", () => {
  const make = (zohoSetup = setup()) => {
    const service = createConsultService({ store: zohoSetup.store, tokenSecret: SECRET, onboardingBaseUrl: BASE, log: () => undefined });
    return { ...zohoSetup, service };
  };
  const send = (service: ReturnType<typeof make>["service"], payload: unknown) =>
    service.submit({ contentType: JSON_CT, idempotencyKey: (payload as any).submission_id, body: JSON.stringify(payload) });

  it("20: success body is unchanged, crm_record_id is the CRM id and the Onboarding token verifies", async () => {
    const { service, zoho } = make();
    const payload = payloadFrom({}, newId(40));
    const r = await send(service, payload);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["crm_record_id", "deduplicated", "ok", "onboarding_url"]);
    expect((r.body as any).crm_record_id).toBe(zoho.records[0]!.id);
    expect((r.body as any).deduplicated).toBe(false);
    const claims = verifyHandoff(new URL((r.body as any).onboarding_url).searchParams.get("session") as string, SECRET);
    expect(claims.consult_submission_id).toBe(newId(40));
    expect(typeof signHandoff).toBe("function");
  });

  it("5+6: same submission retried -> deduplicated 200; changed answers -> 409; one record", async () => {
    const { service, zoho } = make();
    const payload = payloadFrom({}, newId(41));
    expect(((await send(service, payload)).body as any).deduplicated).toBe(false);
    const retry = await send(service, tamper(payload, (p) => (p.submitted_at = "2026-10-12T12:00:00.000Z")));
    expect(retry.status).toBe(200);
    expect((retry.body as any).deduplicated).toBe(true);
    const conflict = await send(service, tamper(payloadFrom({ age: 41 } as any, newId(41)), () => undefined));
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ ok: false, error_code: "SUBMISSION_CONFLICT" });
    expect(zoho.records).toHaveLength(1);
  });

  it("7: concurrent identical requests -> one created, the rest deduplicated", async () => {
    const { service, zoho } = make();
    const payload = payloadFrom({}, newId(42));
    const rs = await Promise.all(Array.from({ length: 5 }, () => send(service, payload)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => (r.body as any).deduplicated === false)).toHaveLength(1);
    expect(zoho.records).toHaveLength(1);
  });

  it("8: timeout after persistence still answers success once (no duplicate record)", async () => {
    const m = make();
    m.zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 1, "POST");
    const r = await send(m.service, payloadFrom({}, newId(43)));
    expect(r.status).toBe(200);
    expect(m.zoho.records).toHaveLength(1);
  });

  it("CRM outage maps to the existing 503 contract; no answers in the response", async () => {
    const m = make();
    m.zoho.failNext(/Consultation_Submissions/, { kind: "status", status: 503, body: {} }, 20);
    const r = await send(m.service, payloadFrom({}, newId(44)));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, error_code: "STORAGE_UNAVAILABLE" });
    expect(m.zoho.records).toHaveLength(0);
  });

  it("oversized or unmappable submissions are refused with 503, never stored partially", async () => {
    const m = make();
    const logs: any[] = [];
    const service = createConsultService({ store: m.store, tokenSecret: SECRET, onboardingBaseUrl: BASE, log: (e, f) => logs.push({ e, ...f }) });
    // A payload the service validates is far below the guard; force the guard with a tiny limit.
    const tiny = setup({ SIX2FIT_ZOHO_MAX_RAW_CHARS: "1000" });
    const small = createConsultService({ store: tiny.store, tokenSecret: SECRET, onboardingBaseUrl: BASE, log: (e, f) => logs.push({ e, ...f }) });
    const r = await send(small, payloadFrom({}, newId(45)));
    expect(r.status).toBe(503);
    expect(tiny.zoho.records).toHaveLength(0);
    expect(logs.some((l) => l.e === "consult.storage_failure" && l.kind === "TOO_LARGE" && l.code === "RAW_PAYLOAD_TOO_LARGE")).toBe(true);
    expect(service).toBeDefined();
  });

  it("the largest valid-shaped submission (nine modules, all notes) fits the CRM capacity", async () => {
    const m = make();
    const payload = payloadFrom(
      {
        ts_01_has_limitation: "yes",
        ts_02_categories: MODULE_KEYS,
        ts_03_clearance: "no",
        blocker_details: "ب".repeat(500),
        modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, { ...moduleAnswer([FIRST_FLAG[k] as string]), diagnosis: "ب".repeat(200), notes: "ب".repeat(1000) }])),
      } as any,
      newId(46),
    );
    const raw = JSON.stringify(payload).length;
    expect(raw).toBeLessThan(31_000);
    const r = await send(m.service, payload);
    expect(r.status).toBe(200);
    expect(m.zoho.records).toHaveLength(1);
  });
});
