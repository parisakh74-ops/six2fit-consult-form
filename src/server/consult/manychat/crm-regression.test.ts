/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed JSON bodies */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsultService } from "../service";
import { newId, payloadFrom } from "../fixtures";
import { CrmConsultStore } from "../crm/crm-store";
import { createCrmConsultStore } from "../crm/factory";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "../crm/mock-zoho";
import { createManychatMarker, type ManychatMarkerConfig } from "./marker";

/**
 * CRM regression: the ManyChat marker must not change what is written to the CRM, which requests are made to it,
 * or the response, whatever ManyChat does. Uses the in-memory Zoho mock; no real network.
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
const JSON_CT = "application/json; charset=utf-8";
const CFG: ManychatMarkerConfig = {
  enabled: true,
  token: "synthetic-token-not-real",
  fieldId: 14310220,
  maxAttempts: 3,
  timeoutMs: 1000,
  retryBaseMs: 1,
};

let networkSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  networkSpy = vi.fn(() => {
    throw new Error("REAL NETWORK ACCESS ATTEMPTED");
  });
  vi.stubGlobal("fetch", networkSpy);
});
afterEach(() => {
  expect(networkSpy).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function build(manychatFetch: typeof fetch | null) {
  const zoho = new MockZoho();
  const store = createCrmConsultStore(ENV, {
    fetch: zoho.fetch,
    now: () => Date.UTC(2026, 10, 1, 10, 0, 0),
    sleep: async () => undefined,
  }) as CrmConsultStore;
  const marker = manychatFetch
    ? createManychatMarker(CFG, { fetchImpl: manychatFetch, sleep: async () => undefined })
    : null;
  const service = createConsultService({
    store,
    ...(marker
      ? { onAccepted: (i) => marker.markFormSubmitted(i.manychat_id).then(() => undefined) }
      : {}),
  });
  return { zoho, service };
}
const submit = (service: ReturnType<typeof createConsultService>, payload: any) =>
  service.submit({
    contentType: JSON_CT,
    idempotencyKey: payload.submission_id,
    body: JSON.stringify(payload),
  });
const crmShape = (z: MockZoho) => ({
  requests: z.requests.map((r) => `${r.method} ${r.path}`),
  records: z.records.map((r) => ({ ...r, id: undefined })),
});
const payload = () =>
  ({
    ...payloadFrom({}, newId(11)),
    manychat_id: "123456789",
    instagram_id: "synthetic.user",
  }) as any;
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("ManyChat marker does not change the CRM submission", () => {
  it("identical CRM requests, records and response with the marker off, succeeding, failing or hanging", async () => {
    const fixed = payload(); // one payload object: submitted_at must be identical across runs
    const baseline = build(null);
    const baseResponse = await submit(baseline.service, fixed);
    expect(baseResponse.body).toMatchObject({ ok: true, deduplicated: false });
    const baseShape = crmShape(baseline.zoho);
    expect(baseShape.records).toHaveLength(1);

    const behaviours: Record<string, typeof fetch> = {
      success: vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch,
      server_error: vi
        .fn()
        .mockResolvedValue(new Response("{}", { status: 500 })) as unknown as typeof fetch,
      network_error: vi.fn().mockRejectedValue(new Error("net")) as unknown as typeof fetch,
      hanging: vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch,
    };
    for (const [name, f] of Object.entries(behaviours)) {
      const t = build(f);
      const response = await submit(t.service, fixed);
      expect(response, name).toEqual(baseResponse);
      expect(crmShape(t.zoho), name).toEqual(baseShape);
      await tick();
      expect(f, name).toHaveBeenCalled();
    }
  });

  it("a replay (deduplicated) neither touches the CRM again nor calls ManyChat again", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const t = build(f as unknown as typeof fetch);
    await submit(t.service, payload());
    await tick();
    const requestsAfterFirst = t.zoho.requests.length;
    const replay = await submit(t.service, payload());
    await tick();
    expect(replay.body).toMatchObject({ ok: true, deduplicated: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(t.zoho.records).toHaveLength(1);
    expect(t.zoho.requests.slice(requestsAfterFirst).every((r) => r.method === "GET")).toBe(true);
  });

  it("a submission without a manychat id makes no ManyChat request", async () => {
    const f = vi.fn();
    const t = build(f as unknown as typeof fetch);
    await submit(t.service, { ...payload(), manychat_id: null });
    await tick();
    expect(f).not.toHaveBeenCalled();
    expect(t.zoho.records).toHaveLength(1);
  });

  it("never sends the instagram handle or any answer to ManyChat", async () => {
    const f = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const t = build(f as unknown as typeof fetch);
    await submit(t.service, payload());
    await tick();
    const body = (f.mock.calls[0]![1] as RequestInit).body as string;
    expect(JSON.parse(body)).toEqual({
      subscriber_id: 123456789,
      field_id: 14310220,
      field_value: true,
    });
    expect(body).not.toContain("synthetic.user");
  });
});
