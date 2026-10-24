/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed JSON bodies */
// Signed Lead reference + CRM association: the parallel link to the existing Lead journey. Mocks only: no network.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "./canonical";
import { MODULE_KEYS, FIRST_FLAG, moduleAnswer, newId, payloadFrom } from "./fixtures";
import { createCrmConsultStore } from "./crm/factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./crm/mock-zoho";
import { signLeadRef, verifyLeadRef } from "./lead-ref";
import { createConsultService } from "./service";
import { type ConsultStore, type StoredConsult } from "./store";

const SECRET = "synthetic-lead-ref-secret-0123456789abcdef";
const OTHER = "another-synthetic-secret-0123456789abcdef-x";
const LEAD = "6223361000127999001";
const NOW = Date.UTC(2026, 9, 24, 10, 0, 0);
const ENV: Record<string, string> = {
  SIX2FIT_CONSULT_STORE: "crm", SIX2FIT_CONSULT_CRM_ENABLED: "true", SIX2FIT_ZOHO_ENVIRONMENT: "sandbox", SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN, SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN, SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client", SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value", SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh", SIX2FIT_ZOHO_TIMEOUT_MS: "40",
};
const mint = (o: Partial<{ leadId: string; secret: string; now: number; ttl: number; jti: string }> = {}) =>
  signLeadRef({ leadId: o.leadId ?? LEAD, secret: o.secret ?? SECRET, nowSeconds: Math.floor((o.now ?? NOW) / 1000), ttlSeconds: o.ttl ?? 3600, jti: o.jti ?? "jti-synthetic-0001" });

let net: ReturnType<typeof vi.fn>;
beforeEach(() => {
  net = vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); });
  vi.stubGlobal("fetch", net);
});
afterEach(() => {
  expect(net).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe("signed Lead reference", () => {
  it("valid reference round-trips; carries no personal data", () => {
    const t = mint();
    const v = verifyLeadRef(t, SECRET, NOW);
    expect(v).toMatchObject({ state: "valid", leadId: LEAD, jti: "jti-synthetic-0001" });
    const claims = Buffer.from(t.split(".")[1] as string, "base64url").toString("utf8");
    expect(Object.keys(JSON.parse(claims)).sort()).toEqual(["exp", "jti", "lead", "p"]);
  });
  it("tampered, wrong-secret, malformed, other-purpose and short-secret references are invalid; an old one is expired", () => {
    const t = mint();
    const [v, body, sig] = t.split(".") as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ p: "consult-lead", lead: "6223361000127999002", exp: Math.floor(NOW / 1000) + 3600, jti: "jti-synthetic-0001" })).toString("base64url");
    expect(verifyLeadRef(`${v}.${forged}.${sig}`, SECRET, NOW)).toEqual({ state: "invalid" }); // another Lead id with the old signature
    expect(verifyLeadRef(t, OTHER, NOW)).toEqual({ state: "invalid" });
    expect(verifyLeadRef(`${v}.${body}.${"0".repeat(64)}`, SECRET, NOW)).toEqual({ state: "invalid" });
    for (const bad of ["", "x", "v2.a.b", `${v}.${body}`, "v1..", `${t} `, "6223361000127999001"]) expect(verifyLeadRef(bad, SECRET, NOW)).toEqual({ state: "invalid" });
    expect(verifyLeadRef(t, "short", NOW)).toEqual({ state: "invalid" });
    expect(verifyLeadRef(mint({ now: NOW - 7200_000, ttl: 3600 }), SECRET, NOW)).toEqual({ state: "expired" });
    expect(() => mint({ leadId: "12ab" })).toThrow();
    expect(() => mint({ secret: "short" })).toThrow();
  });
  it("a reference minted for another purpose with the right key is refused", () => {
    const signedBody = `v1.${Buffer.from(JSON.stringify({ p: "onboarding", lead: LEAD, exp: Math.floor(NOW / 1000) + 3600, jti: "jti-synthetic-0001" })).toString("base64url")}`;
    // sign it correctly with the same key to prove the purpose claim itself is checked
    const sig = createHmac("sha256", SECRET).update(signedBody).digest("hex") as string;
    expect(verifyLeadRef(`${signedBody}.${sig}`, SECRET, NOW)).toEqual({ state: "invalid" });
  });
});

const nine = (id = newId(1)) =>
  payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: MODULE_KEYS, ts_03_clearance: "not_assessed", modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])) } as any, id) as any;

function crmWorld(env: Record<string, string> = {}) {
  const zoho = new MockZoho();
  const bodies: any[] = [];
  const store = createCrmConsultStore({ ...ENV, ...env }, {
    fetch: ((u: string, i: any) => {
      if (i?.method === "POST" && /\/Consultation_Submissions$/.test(new URL(u).pathname)) bodies.push(JSON.parse(i.body));
      return zoho.fetch(u as never, i as never);
    }) as never,
    now: () => NOW,
    sleep: async () => undefined,
  });
  return { zoho, store, bodies };
}
const rec = (payload: any, identity?: StoredConsult["identity"]): StoredConsult => ({
  version: 2, submission_id: payload.submission_id, payload_hash: fingerprint(payload), payload, record_ref: `staging_${payload.submission_id}`, created_at: "2026-10-24T10:00:00.000Z", ...(identity ? { identity } : {}),
});

describe("CRM association", () => {
  it("valid reference: Lead lookup + Identity_Match 'Existing Lead', status stays Received, no workflow by default", async () => {
    const { zoho, store, bodies } = crmWorld();
    const p = nine();
    await store.create(p.submission_id, rec(p, { ref_state: "valid", lead_id: LEAD }));
    expect(zoho.records[0]).toMatchObject({ Lead: { id: LEAD }, Identity_Match: "Existing Lead", Status: "Received" });
    expect(zoho.records[0]!["Contact"]).toBeUndefined();
    expect(bodies[0].trigger).toEqual([]);
  });
  it("no reference: nothing linked, Status Received, Identity_Match empty", async () => {
    const { zoho, store } = crmWorld();
    const p = nine(newId(2));
    await store.create(p.submission_id, rec(p));
    expect(zoho.records[0]).toMatchObject({ Status: "Received" });
    expect(zoho.records[0]!["Lead"]).toBeUndefined();
    expect(zoho.records[0]!["Identity_Match"]).toBeUndefined();
  });
  it("invalid or expired reference: never linked, Status 'Needs Review'", async () => {
    for (const [i, state] of (["invalid", "expired"] as const).entries()) {
      const { zoho, store } = crmWorld();
      const p = nine(newId(10 + i));
      await store.create(p.submission_id, rec(p, { ref_state: state }));
      expect(zoho.records[0]).toMatchObject({ Status: "Needs Review" });
      expect(zoho.records[0]!["Lead"]).toBeUndefined();
    }
  });
  it("a Lead id of another organisation (wrong id prefix) is refused before any write", async () => {
    const { zoho, store } = crmWorld();
    const p = nine(newId(3));
    await expect(store.create(p.submission_id, rec(p, { ref_state: "valid", lead_id: "6067417000000999001" }))).rejects.toThrow();
    expect(zoho.records).toHaveLength(0);
  });
  it("the workflow trigger is sent only when explicitly enabled", async () => {
    const on = crmWorld({ SIX2FIT_CONSULT_CRM_TRIGGER_WORKFLOW: "true" });
    const p = nine(newId(4));
    await on.store.create(p.submission_id, rec(p));
    expect(on.bodies[0].trigger).toEqual(["workflow"]);
    const off = crmWorld({ SIX2FIT_CONSULT_CRM_TRIGGER_WORKFLOW: "false" });
    await off.store.create(p.submission_id, rec(p));
    expect(off.bodies[0].trigger).toEqual([]);
  });
});

describe("service: the reference is verified server-side and never changes the fingerprint", () => {
  function svc(secret?: string) {
    const created: StoredConsult[] = [];
    const store: ConsultStore = {
      get: async () => null,
      create: async (_id, record) => (created.push(record), { status: "created", record }),
    };
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const service = createConsultService({ store, now: () => NOW, ...(secret ? { leadRefSecret: secret } : {}), log: (event, fields) => logs.push({ event, ...(fields ? { fields } : {}) }) });
    return { service, created, logs };
  }
  const submit = (service: ReturnType<typeof svc>["service"], p: any, leadRef?: string | null) =>
    service.submit({ contentType: "application/json", idempotencyKey: p.submission_id, body: JSON.stringify(p), ...(leadRef !== undefined ? { leadRef } : {}) });

  it("valid -> identity valid with the Lead id; invalid/expired -> state only; absent or feature off -> none", async () => {
    const a = svc(SECRET);
    const p1 = nine(newId(20));
    expect((await submit(a.service, p1, mint())).status).toBe(200);
    expect(a.created[0]!.identity).toEqual({ ref_state: "valid", lead_id: LEAD });
    const p2 = nine(newId(21));
    await submit(a.service, p2, mint({ secret: OTHER }));
    expect(a.created[1]!.identity).toEqual({ ref_state: "invalid" });
    const p3 = nine(newId(22));
    await submit(a.service, p3, mint({ now: NOW - 7200_000, ttl: 60 }));
    expect(a.created[2]!.identity).toEqual({ ref_state: "expired" });
    const p4 = nine(newId(23));
    await submit(a.service, p4);
    expect(a.created[3]!.identity).toEqual({ ref_state: "none" });
    const off = svc();
    await submit(off.service, nine(newId(24)), mint());
    expect(off.created[0]!.identity).toEqual({ ref_state: "none" });
    expect(JSON.stringify(a.logs)).not.toContain(LEAD);
  });
  it("an invalid reference never blocks the submission (the customer's answers are kept)", async () => {
    const a = svc(SECRET);
    expect((await submit(a.service, nine(newId(25)), "garbage")).status).toBe(200);
    expect(a.created).toHaveLength(1);
  });
  it("a Lead id smuggled in the body is refused; the fingerprint ignores the reference", async () => {
    const a = svc(SECRET);
    const p = nine(newId(26));
    const smuggled = { ...p, lead_id: LEAD };
    expect((await submit(a.service, smuggled, mint())).status).toBe(400);
    expect(a.created).toHaveLength(0);
    await submit(a.service, p, mint());
    await submit(svc(SECRET).service, p, mint({ jti: "jti-synthetic-0002" }));
    expect(fingerprint(p)).toBe(a.created[0]!.payload_hash);
  });
});
