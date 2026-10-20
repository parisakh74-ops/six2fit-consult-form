/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed CRM bodies */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { contactSchema } from "../../../features/consult/schema";
import { EMAIL_MAX_LENGTH } from "../../../features/consult/assessmentConfig";
import { fingerprint } from "../canonical";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, newId, payloadFrom, tamper } from "../fixtures";
import { createConsultService } from "../service";
import { StoreError, type StoredConsult } from "../store";
import { validateConsultPayload } from "../validate";
import { CrmConsultStore } from "./crm-store";
import { createCrmConsultStore } from "./factory";
import { buildCrmRecord, parseCrmRecord } from "./mapping";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

/** Approved decisions D1-D4 and E1 (PM, 2026-10-12). Mock results only: not verified Zoho API behaviour. */
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
let spy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  spy = vi.fn(() => {
    throw new Error("REAL NETWORK ACCESS ATTEMPTED");
  });
  vi.stubGlobal("fetch", spy);
});
afterEach(() => {
  expect(spy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function setup() {
  const zoho = new MockZoho();
  const store = createCrmConsultStore(ENV, { fetch: zoho.fetch, sleep: async () => undefined }) as CrmConsultStore;
  return { zoho, store };
}
const rec = (payload: any): StoredConsult => ({ version: 2, submission_id: payload.submission_id, payload_hash: fingerprint(payload), payload, record_ref: "x", created_at: "2026-10-12T10:00:00Z" });
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    return e as StoreError;
  }
  throw new Error("expected StoreError");
};
const withModules = (keys: string[], id: string) =>
  payloadFrom(
    keys.length
      ? ({
          ts_01_has_limitation: "yes",
          ts_02_categories: keys,
          ts_03_clearance: "no",
          modules: Object.fromEntries(keys.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
        } as any)
      : {},
    id,
  ) as any;
const emailOfLength = (n: number) => `${"a".repeat(n - "@example.test".length)}@example.test`;

describe("D1 exact Submission_ID matching", () => {
  const A = `cns_${"a1b2c3d4".repeat(5)}`; // 44 characters
  const raw = (zoho: MockZoho, q: string) =>
    zoho.fetch(`${MOCK_API_DOMAIN}/crm/v8/Consultation_Submissions/search?criteria=(Submission_ID:equals:${q})`, { method: "GET", headers: { authorization: "Zoho-oauthtoken synthetic-access-1" } });

  it("exact id is found", async () => {
    const { store } = setup();
    await store.create(A, rec(payloadFrom({}, A)));
    expect((await store.get(A))?.submission_id).toBe(A);
  });

  it("a partial id (a prefix of a stored id, which a contains-like search returns) is never selected", async () => {
    const { zoho, store } = setup();
    await store.create(A, rec(payloadFrom({}, A)));
    await store.get(A); // initialises the token for the raw probe below
    for (const q of [A.slice(0, 24), A.slice(0, 30), A.slice(0, 40)]) {
      expect(((await (await raw(zoho, q)).json()) as any).data, "contains-like search returns it").toHaveLength(1);
      expect(await store.get(q)).toBeNull();
    }
  });

  it("a similar id (one character different) is a different submission", async () => {
    const { zoho, store } = setup();
    const near = `${A.slice(0, -1)}${A.endsWith("0") ? "1" : "0"}`;
    await store.create(A, rec(payloadFrom({}, A)));
    expect(await store.get(near)).toBeNull();
    expect((await store.create(near, rec(payloadFrom({}, near)))).status).toBe("created");
    expect(zoho.records).toHaveLength(2);
    expect((await store.get(near))?.submission_id).toBe(near);
    expect((await store.get(A))?.submission_id).toBe(A);
  });

  it("a case variant is the same submission (the CRM unique field is case-insensitive)", async () => {
    const { zoho, store } = setup();
    const upper = A.toUpperCase().replace(/^CNS_/, "cns_");
    await store.create(A, rec(payloadFrom({}, A)));
    expect((await store.get(upper))?.submission_id).toBe(A);
    expect((await store.create(upper, rec(payloadFrom({}, upper)))).status).toBe("exists");
    expect(zoho.records).toHaveLength(1);
  });

  it("several candidates: the exact one is chosen deterministically, others are ignored", async () => {
    const { zoho, store } = setup();
    const longer = `${A}ab`;
    await store.create(longer, rec(payloadFrom({}, longer)));
    await store.create(A, rec(payloadFrom({}, A)));
    for (let i = 0; i < 3; i++) expect((await store.get(A))?.submission_id).toBe(A);
    expect(zoho.records).toHaveLength(2);
  });

  it("two exact records (impossible with the unique field) fail safely as CORRUPT, nothing is picked", async () => {
    const { zoho, store } = setup();
    await store.create(A, rec(payloadFrom({}, A)));
    zoho.records.push({ ...zoho.records[0]!, id: "6223361000127069999" });
    expect(await fails(store.get(A))).toMatchObject({ kind: "CORRUPT", code: "DUPLICATE_RECORDS" });
  });

  it("a candidate without a readable Submission_ID makes the answer unusable instead of guessed", async () => {
    const { zoho, store } = setup();
    await store.create(A, rec(payloadFrom({}, A)));
    zoho.failNext(/search$/, { kind: "status", status: 200, body: { data: [{ id: "6223361000127060101" }] } }, 1);
    expect(await store.get(A)).toBeNull();
    zoho.failNext(/search$/, { kind: "status", status: 200, body: { data: [{ Submission_ID: A }] } }, 1);
    expect(await fails(store.get(A))).toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("D2 complete record retrieval including Module_Answers", () => {
  it.each([[0], [1], [9]])("round-trips %i applicable exercise modules with the subform", async (n) => {
    const { zoho, store } = setup();
    const id = newId(10 + n);
    const payload = withModules(MODULE_KEYS.slice(0, n), id);
    await store.create(id, rec(payload));
    const view = await store.getSubmission(id);
    expect(view?.stored.payload).toEqual(payload);
    expect(view?.moduleRows).toHaveLength(n);
    expect(view?.moduleRows.map((r) => r["Module"]).sort()).toEqual(MODULE_KEYS.slice(0, n).sort());
    const reads = zoho.requests.filter((r) => r.method === "GET" && /Consultation_Submissions\/\d+$/.test(r.path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.query === "")).toBe(true);
  });

  it("a record whose subform is missing, short, extra or for other modules is NOT accepted as complete", async () => {
    const { zoho, store } = setup();
    const id = newId(30);
    await store.create(id, rec(withModules(["tendon", "surgery", "other"], id)));
    const original = JSON.parse(JSON.stringify(zoho.records[0]));
    const check = async (mutate: (r: any) => void, code: string) => {
      zoho.records[0] = JSON.parse(JSON.stringify(original));
      mutate(zoho.records[0]);
      expect(await fails(store.getSubmission(id))).toMatchObject({ kind: "CORRUPT", code });
    };
    await check((r) => delete r.Module_Answers, "SUBFORM_INCOMPLETE");
    await check((r) => (r.Module_Answers = []), "SUBFORM_INCOMPLETE");
    await check((r) => r.Module_Answers.pop(), "SUBFORM_INCOMPLETE");
    await check((r) => r.Module_Answers.push({ Module: "oncology" }), "SUBFORM_INCOMPLETE");
    await check((r) => (r.Module_Answers[0].Module = "ligament"), "SUBFORM_INCOMPLETE");
    await check((r) => r.Module_Answers.push(r.Module_Answers[0]), "SUBFORM_INCOMPLETE");
    await check((r) => (r.Module_Answers = "nope"), "SUBFORM_SHAPE");
    zoho.records[0] = original;
    expect((await store.getSubmission(id))?.moduleRows).toHaveLength(3);
  });

  it("a duplicate answer whose existing record has an incomplete subform is not reported as an equivalent submission", async () => {
    const { zoho, store } = setup();
    const id = newId(31);
    await store.create(id, rec(withModules(["tendon", "ligament"], id)));
    zoho.records[0]!["Module_Answers"] = [];
    expect(await fails(store.create(id, rec(withModules(["tendon", "ligament"], id))))).toMatchObject({ kind: "CORRUPT", code: "SUBFORM_INCOMPLETE" });
  });

  it("raw payload and fingerprint verification are kept", () => {
    const payload = withModules(["tendon"], newId(32));
    const { record } = buildCrmRecord(payload, { receivedAt: new Date(), payloadHash: fingerprint(payload), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" });
    const stored = { ...record, id: "6223361000127060100" };
    expect(parseCrmRecord(stored, payload.submission_id).stored.payload).toEqual(payload);
    expect(() => parseCrmRecord({ ...stored, Payload_Hash: "0".repeat(64) }, payload.submission_id)).toThrow(/not readable/);
  });
});

describe("D3 Sandbox environment verification", () => {
  const verified = async (zoho: MockZoho, store: CrmConsultStore) => {
    const id = newId(40);
    return fails(store.create(id, rec(payloadFrom({}, id))));
  };
  const noWrite = (zoho: MockZoho) => expect(zoho.requests.some((r) => r.method === "POST" && r.path.startsWith("/crm/"))).toBe(false);

  it.each([["production"], ["developer"], ["bigin"], [""], ["SANDBOX"]])("organisation type %j is refused", async (type) => {
    const { zoho, store } = setup();
    zoho.orgType = type;
    expect(await verified(zoho, store)).toMatchObject({ kind: "NOT_CONFIGURED", code: "ENV_MISMATCH" });
    noWrite(zoho);
  });

  it("a missing organisation type, id or an empty/ambiguous organisation list is refused", async () => {
    const one = { id: "6223361000000000999", zgid: MOCK_ORG_ID, type: "sandbox" };
    for (const body of [{ org: [{ id: "6223361000000000999", zgid: MOCK_ORG_ID }] }, { org: [{ zgid: MOCK_ORG_ID, type: "sandbox" }] }, { org: [{ id: "6223361000000000999", type: "sandbox" }] }, { org: [] }, { org: [one, one] }, {}]) {
      const { zoho, store } = setup();
      zoho.failNext(/\/org$/, { kind: "status", status: 200, body }, 1);
      expect(await verified(zoho, store)).toMatchObject({ kind: "NOT_CONFIGURED" });
      noWrite(zoho);
    }
  });

  it("a wrong organisation id is refused even when type, module and id prefix look right", async () => {
    const { zoho, store } = setup();
    zoho.orgId = "111111111";
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
  });

  it("the id prefix alone never proves the environment: a Production org with a Sandbox-looking module id is refused", async () => {
    const { zoho, store } = setup();
    zoho.orgType = "production";
    zoho.moduleId = "6223361000127040089";
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
  });

  it("the module is taken from the documented list; absent, ambiguous or malformed lists are refused", async () => {
    const lists: unknown[] = [
      { modules: [{ api_name: "Leads", id: "6223361000000002375" }] },
      { modules: [{ api_name: "Consultation_Submissions", id: "6223361000127040089" }, { api_name: "Consultation_Submissions", id: "6223361000127040090" }] },
      { modules: [{ api_name: "Consultation_Submissions" }] },
      { modules: "nope" },
      {},
    ];
    for (const body of lists) {
      const { zoho, store } = setup();
      zoho.failNext(/settings\/modules$/, { kind: "status", status: 200, body }, 1);
      expect(await verified(zoho, store)).toMatchObject({ kind: "NOT_CONFIGURED", code: "ENV_UNVERIFIED" });
      noWrite(zoho);
    }
  });

  it("a module id of the wrong organisation prefix is still refused (additional check)", async () => {
    const { zoho, store } = setup();
    zoho.moduleId = "7777777000000000001";
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
  });

  it("observed contract: the API id is a different number than the zgid; comparing the UI Org ID with the API id is refused", async () => {
    const { zoho, store } = setup();
    zoho.orgApiId = MOCK_ORG_ID; // an org whose API id equals the expected zgid is NOT the expected org unless its zgid matches
    zoho.orgId = "111111111";
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
  });

  it("an optional pin of the organisation API id is enforced", async () => {
    const zoho = new MockZoho();
    const store = createCrmConsultStore({ ...ENV, SIX2FIT_ZOHO_ORG_API_ID: "6223361000000000111" }, { fetch: zoho.fetch, sleep: async () => undefined }) as CrmConsultStore;
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
    const ok = new MockZoho();
    const store2 = createCrmConsultStore({ ...ENV, SIX2FIT_ZOHO_ORG_API_ID: ok.orgApiId }, { fetch: ok.fetch, sleep: async () => undefined }) as CrmConsultStore;
    expect((await store2.create(newId(45), rec(payloadFrom({}, newId(45))))).status).toBe("created");
  });

  it("the token's api_domain must belong to the configured data centre (generic www host accepted, never used for requests)", async () => {
    const { zoho, store } = setup();
    zoho.tokenApiDomain = "https://www.zohoapis.com";
    expect((await store.create(newId(46), rec(payloadFrom({}, newId(46))))).status).toBe("created");
    expect(zoho.requests.every((r) => r.path === "/oauth/v2/token" || r.path.startsWith("/crm/v8/"))).toBe(true);
  });

  it("the token's api_domain of another data centre is refused", async () => {
    const { zoho, store } = setup();
    zoho.tokenApiDomain = "https://sandbox.zohoapis.eu";
    expect(await verified(zoho, store)).toMatchObject({ code: "ENV_MISMATCH" });
    noWrite(zoho);
    expect(zoho.requests.every((r) => r.path === "/oauth/v2/token")).toBe(true);
  });

  it("a failed guard is not cached: a later call verifies again", async () => {
    const { zoho, store } = setup();
    zoho.orgType = "production";
    await verified(zoho, store);
    zoho.orgType = "sandbox";
    expect((await store.create(newId(41), rec(payloadFrom({}, newId(41))))).status).toBe("created");
  });

  it("uses only documented endpoints", async () => {
    const { zoho, store } = setup();
    await store.create(newId(42), rec(payloadFrom({}, newId(42))));
    expect(zoho.requests.map((r) => r.path).some((p) => /settings\/modules\/[A-Za-z]/.test(p))).toBe(false);
  });
});

describe("D4 OAuth scope errors", () => {
  const scope = { kind: "status", status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", message: "Client does not have ZohoCRM.org.READ scope SECRET-BODY-XYZ", status: "error" } } as const;
  const ids = () => newId(50);

  it.each([["/org"], ["settings/modules$"]])("scope error while verifying (%s): configuration error, no refresh, no loop", async (where) => {
    const { zoho, store } = setup();
    zoho.failNext(new RegExp(where), scope, 20);
    const e = await fails(store.get(ids()));
    expect(e).toMatchObject({ kind: "NOT_CONFIGURED", code: "SCOPE_MISSING" });
    expect(zoho.tokenCalls).toBe(1);
    expect(zoho.requests.filter((r) => new RegExp(where).test(r.path))).toHaveLength(1);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toMatch(/SECRET-BODY|synthetic-secret|synthetic-refresh|synthetic-access/);
  });

  it("scope error on create: FORBIDDEN, one attempt, one token, no refresh loop, nothing stored", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, scope, 20, "POST");
    const e = await fails(store.create(ids(), rec(payloadFrom({}, ids()))));
    expect(e).toMatchObject({ kind: "UNAVAILABLE", code: "FORBIDDEN" });
    expect(zoho.requests.filter((r) => r.method === "POST" && r.path.startsWith("/crm/"))).toHaveLength(1);
    expect(zoho.tokenCalls).toBe(1);
    expect(zoho.records).toHaveLength(0);
    expect(JSON.stringify({ m: e.message, c: e.code })).not.toMatch(/SECRET-BODY/);
  });

  it.each([["search$"], ["Consultation_Submissions/\\d+$"]])("scope error on retrieval (%s): FORBIDDEN without refresh", async (where) => {
    const { zoho, store } = setup();
    const id = ids();
    await store.create(id, rec(payloadFrom({}, id)));
    const tokens = zoho.tokenCalls;
    zoho.failNext(new RegExp(where), scope, 20);
    const e = await fails(store.get(id));
    expect(e).toMatchObject({ code: "FORBIDDEN" });
    expect(zoho.tokenCalls).toBe(tokens);
  });

  it("a plain expired token (401 INVALID_TOKEN) is still refreshed exactly once", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 401, body: { code: "INVALID_TOKEN" } }, 1, "POST");
    expect((await store.create(ids(), rec(payloadFrom({}, ids())))).status).toBe("created");
    expect(zoho.tokenCalls).toBe(2);
  });

  it("the service answers 503 and logs only safe codes", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, scope, 20, "POST");
    const logs: any[] = [];
    const service = createConsultService({ store, tokenSecret: "synthetic-test-secret-0123456789abcdef-xyz", onboardingBaseUrl: new URL("https://onboarding-staging.example.test/"), log: (e, f) => logs.push({ e, ...f }) });
    const payload = payloadFrom({}, ids());
    const r = await service.submit({ contentType: "application/json; charset=utf-8", idempotencyKey: ids(), body: JSON.stringify(payload) });
    expect(r.status).toBe(503);
    expect(logs.find((l) => l.e === "consult.storage_failure")).toMatchObject({ kind: "UNAVAILABLE", code: "FORBIDDEN" });
    expect(JSON.stringify(logs)).not.toMatch(/SECRET-BODY|synthetic-secret|Zoho-oauthtoken/);
  });
});

describe("E1 e-mail limited to the CRM field length (100 characters)", () => {
  const sample = (n: number) => {
    const email = emailOfLength(n);
    expect(email).toHaveLength(n);
    return email;
  };
  const payloadWith = (email: string) =>
    tamper(payloadFrom(), (p) => {
      p.email = email;
      p.onboarding_prefill["ON-07"] = email;
    });
  const contact = { lead_full_name: "سارا احمدی", whatsapp_dial_code: "+1", whatsapp_phone: "4165551234", consult_channel: "whatsapp_chat" };

  it("the shared limit equals the CRM field length", () => {
    expect(EMAIL_MAX_LENGTH).toBe(100);
  });

  it.each([[99, true], [100, true], [101, false]])("browser form schema: %i characters -> accepted=%s", (n, ok) => {
    const r = contactSchema.safeParse({ ...contact, email: sample(n) });
    expect(r.success).toBe(ok);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.path[0] === "email");
      expect(issue?.message).toBe("ایمیل نباید بیشتر از ۱۰۰ کاراکتر باشد"); // clear message for the user
    }
  });

  it("browser form: empty and ordinary valid e-mails still pass; a malformed one still fails", () => {
    expect(contactSchema.safeParse({ ...contact, email: "" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...contact, email: "sara.ahmadi@example.test" }).success).toBe(true);
    expect(contactSchema.safeParse({ ...contact, email: "not-an-email" }).success).toBe(false);
  });

  it.each([[99, true], [100, true], [101, false]])("server validator: %i characters -> accepted=%s", (n, ok) => {
    const r = validateConsultPayload(payloadWith(sample(n)));
    expect(r.ok).toBe(ok);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("email");
  });

  it("server validator: null and a normal address are still accepted; other contact fields are untouched", () => {
    expect(validateConsultPayload(tamper(payloadFrom(), (p) => (p.email = null))).ok).toBe(false); // prefill must match
    expect(validateConsultPayload(payloadFrom()).ok).toBe(true);
    expect(validateConsultPayload(tamper(payloadFrom(), (p) => (p.lead_full_name = "ب".repeat(81)))).ok).toBe(false);
    expect(validateConsultPayload(tamper(payloadFrom(), (p) => (p.lead_full_name = "ب".repeat(80)))).ok).toBe(false); // prefill mirrors the name
  });

  it.each([[99], [100]])("valid %i-character e-mails reach the structured CRM Email field unchanged", (n) => {
    const payload = payloadWith(sample(n)) as any;
    const { record, degraded } = buildCrmRecord(payload, { receivedAt: new Date(), payloadHash: fingerprint(payload), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" });
    expect(record["Email"]).toBe(sample(n));
    expect(degraded).not.toContain("Email");
  });

  it("the mapping refuses an over-limit e-mail instead of omitting it", () => {
    const payload = payloadWith(sample(101)) as any;
    expect(() => buildCrmRecord(payload, { receivedAt: new Date(), payloadHash: "0".repeat(64), maxRawPayloadChars: 31_000, sandboxIdPrefix: "6223361000" })).toThrow(/mapping: Email/);
  });

  it("end to end: a 100-character e-mail is stored; a 101-character one is rejected before storage (400, nothing stored)", async () => {
    const { zoho, store } = setup();
    const service = createConsultService({ store, tokenSecret: "synthetic-test-secret-0123456789abcdef-xyz", onboardingBaseUrl: new URL("https://onboarding-staging.example.test/"), log: () => undefined });
    const send = (payload: any) => service.submit({ contentType: "application/json; charset=utf-8", idempotencyKey: payload.submission_id, body: JSON.stringify(payload) });
    const ok = tamper(payloadFrom({}, newId(60)), (p) => {
      p.email = sample(100);
      p.onboarding_prefill["ON-07"] = sample(100);
    });
    expect((await send(ok)).status).toBe(200);
    expect(zoho.records[0]!["Email"]).toBe(sample(100));
    const bad = tamper(payloadFrom({}, newId(61)), (p) => {
      p.email = sample(101);
      p.onboarding_prefill["ON-07"] = sample(101);
    });
    const r = await send(bad);
    expect(r.status).toBe(400);
    expect(zoho.records).toHaveLength(1);
  });
});
