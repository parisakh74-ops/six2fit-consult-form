/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed CRM bodies */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../canonical";
import { StoreError, type StoredConsult } from "../store";
import { newId, payloadFrom } from "../fixtures";
import { CrmConsultStore } from "./crm-store";
import { createCrmConsultStore } from "./factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

/**
 * Behaviours taken from the OFFICIAL Zoho CRM v8 documentation (not confirmed in CA Dev yet):
 *  - search `equals` behaves like "contains" (search-records page)
 *  - a single-record fetch returns subform rows (get-records page); `fields` is optional there
 *  - GET /org returns { org: [{ id, type: production|sandbox|... }] } (get-org-data page)
 *  - a token without the needed scope gets HTTP 401 OAUTH_SCOPE_MISMATCH (get-org-data / insert-records pages)
 */
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

describe("search `equals` is contains-like (documented)", () => {
  it("a shorter id that is only a substring of a stored id is NOT reported as that submission", async () => {
    const { zoho, store } = setup();
    const longId = `cns_${"a1b2c3d4".repeat(5)}`; // 44 characters, valid pattern
    const shortId = longId.slice(0, 30);
    await store.create(longId, rec(payloadFrom({}, longId)));
    // the mock search (contains) does return the long record for the short query ...
    const raw = await zoho.fetch(`${MOCK_API_DOMAIN}/crm/v8/Consultation_Submissions/search?criteria=(Submission_ID:equals:${shortId})`, {
      method: "GET",
      headers: { authorization: "Zoho-oauthtoken synthetic-access-1" },
    });
    expect(((await raw.json()) as any).data).toHaveLength(1);
    // ... and the adapter must still answer "not found", then create the short one as its own record.
    expect(await store.get(shortId)).toBeNull();
    expect((await store.create(shortId, rec(payloadFrom({}, shortId)))).status).toBe("created");
    expect(zoho.records).toHaveLength(2);
    expect((await store.get(shortId))?.submission_id).toBe(shortId);
    expect((await store.get(longId))?.submission_id).toBe(longId);
  });
});

describe("single-record read", () => {
  it("does not restrict `fields` (subform rows are only returned by an unrestricted single-record fetch)", async () => {
    const { zoho, store } = setup();
    const id = newId(1);
    await store.create(id, rec(payloadFrom({}, id)));
    await store.getSubmission(id);
    const reads = zoho.requests.filter((r) => r.method === "GET" && /Consultation_Submissions\/\d+$/.test(r.path));
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.query === "")).toBe(true);
  });
});

describe("environment guard uses the documented responses", () => {
  it("accepts only an organisation whose documented `type` is sandbox", async () => {
    const { zoho, store } = setup();
    zoho.orgType = "production";
    expect(await fails(store.create(newId(2), rec(payloadFrom({}, newId(2)))))).toMatchObject({ kind: "NOT_CONFIGURED", code: "ENV_MISMATCH" });
    zoho.orgType = "developer";
    expect(await fails(store.get(newId(2)))).toMatchObject({ code: "ENV_MISMATCH" });
    expect(zoho.requests.some((r) => r.method === "POST" && r.path.startsWith("/crm/"))).toBe(false);
  });

  it("finds the module in the documented module list and uses no undocumented endpoint", async () => {
    const { zoho, store } = setup();
    await store.create(newId(3), rec(payloadFrom({}, newId(3))));
    const paths = new Set(zoho.requests.map((r) => `${r.method} ${r.path.replace(/\d{6,}/, ":id")}`));
    for (const p of ["GET /crm/v8/org", "GET /crm/v8/settings/modules", "POST /crm/v8/Consultation_Submissions"]) expect(paths.has(p), p).toBe(true);
    expect(paths.has("GET /crm/v8/settings/modules/Consultation_Submissions")).toBe(false);
  });

  it("a module missing from the list is reported as unverified", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/settings\/modules$/, { kind: "status", status: 200, body: { modules: [{ api_name: "Leads", id: "6223361000000002375" }] } }, 1);
    expect(await fails(store.get(newId(4)))).toMatchObject({ code: "ENV_UNVERIFIED" });
  });
});

describe("missing OAuth scope (HTTP 401 OAUTH_SCOPE_MISMATCH)", () => {
  const scope = { kind: "status", status: 401, body: { code: "OAUTH_SCOPE_MISMATCH", message: "scope", status: "error" } } as const;

  it("is a configuration problem during verification and never triggers a token refresh loop", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/\/org$/, scope, 3);
    expect(await fails(store.get(newId(5)))).toMatchObject({ kind: "NOT_CONFIGURED", code: "SCOPE_MISSING" });
    expect(zoho.tokenCalls).toBe(1);
  });

  it("on create it maps to FORBIDDEN and is not retried", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/Consultation_Submissions$/, scope, 3, "POST");
    expect(await fails(store.create(newId(6), rec(payloadFrom({}, newId(6)))))).toMatchObject({ kind: "UNAVAILABLE", code: "FORBIDDEN" });
    expect(zoho.requests.filter((r) => r.method === "POST" && r.path.startsWith("/crm/"))).toHaveLength(1);
    expect(zoho.tokenCalls).toBe(1);
  });

  it("on read it maps to FORBIDDEN", async () => {
    const { zoho, store } = setup();
    zoho.failNext(/search$/, scope, 3);
    expect(await fails(store.get(newId(7)))).toMatchObject({ code: "FORBIDDEN" });
  });
});
