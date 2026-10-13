/* eslint-disable @typescript-eslint/no-explicit-any -- fetch stub */
/**
 * Self-check: runs the LIVE suite's logic against the in-memory mock (no network) so test defects are found before
 * any real Sandbox call. Mock behaviour is an assumption; this proves the suite's own consistency only.
 */
import { vi } from "vitest";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_API_ID, MOCK_ORG_ID, MockZoho } from "../mock-zoho";

const zoho = new MockZoho();
vi.stubGlobal("fetch", ((url: string, init: any) => zoho.fetch(String(url), { method: init?.method ?? "GET", headers: init?.headers ?? {}, body: init?.body, signal: init?.signal })) as any);
Object.assign(process.env, {
  SIX2FIT_LIVE_SANDBOX: "1",
  SIX2FIT_CONSULT_STORE: "crm",
  SIX2FIT_CONSULT_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: MOCK_ORG_ID,
  SIX2FIT_ZOHO_ORG_API_ID: MOCK_ORG_API_ID,
  SIX2FIT_ZOHO_API_DOMAIN: MOCK_API_DOMAIN,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: MOCK_ACCOUNTS_DOMAIN,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: "synthetic-client",
  SIX2FIT_ZOHO_CLIENT_SECRET: "synthetic-secret-value",
  SIX2FIT_ZOHO_REFRESH_TOKEN: "synthetic-refresh",
  SIX2FIT_ZOHO_TIMEOUT_MS: "2000",
});
await import("./sandbox.live.test");
