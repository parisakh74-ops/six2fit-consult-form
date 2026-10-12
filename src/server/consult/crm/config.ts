import { StoreError } from "../errors";

/**
 * Configuration contract of the Zoho CRM Sandbox adapter (server-side environment only).
 *
 * CRM mode is OFF unless BOTH `SIX2FIT_CONSULT_STORE=crm` and `SIX2FIT_CONSULT_CRM_ENABLED=true`
 * are set. Only the Zoho SANDBOX environment is supported: a Production API domain, a missing
 * value or a malformed value fails closed with `NOT_CONFIGURED`. Error messages never contain
 * configuration values (they may be secrets).
 *
 * Variables (nothing has a default except limits):
 *   SIX2FIT_CONSULT_CRM_ENABLED        "true"
 *   SIX2FIT_ZOHO_ENVIRONMENT           "sandbox"
 *   SIX2FIT_ZOHO_ORG_ID                expected Sandbox organisation id (digits), e.g. the CA Dev org
 *   SIX2FIT_ZOHO_API_DOMAIN            https://sandbox.zohoapis.<dc>
 *   SIX2FIT_ZOHO_ACCOUNTS_DOMAIN       https://accounts.zoho.<dc>
 *   SIX2FIT_ZOHO_MODULE_ID_PREFIX      expected id prefix of the Sandbox org (digits), checked on the module id
 *   SIX2FIT_ZOHO_CLIENT_ID / SIX2FIT_ZOHO_CLIENT_SECRET / SIX2FIT_ZOHO_REFRESH_TOKEN   Sandbox grant only
 *   SIX2FIT_ZOHO_MODULE_API_NAME       default Consultation_Submissions
 *   SIX2FIT_ZOHO_MAX_RAW_CHARS         default 31000 (Raw_Payload_JSON capacity is 32,000 characters)
 *   SIX2FIT_ZOHO_TIMEOUT_MS            default 10000
 *   SIX2FIT_ZOHO_MAX_ATTEMPTS          default 3
 */
export type CrmConfig = {
  environment: "sandbox";
  orgId: string;
  apiDomain: string;
  accountsDomain: string;
  moduleIdPrefix: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  moduleApiName: string;
  maxRawPayloadChars: number;
  requestTimeoutMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  verifyTtlMs: number;
};

/** Id prefix of the Production organisation: never accepted as the expected Sandbox prefix. */
export const PRODUCTION_ID_PREFIX = "6067417000";

const DCS = "(com|eu|in|com\\.au|jp|com\\.cn|ca|sa)";
const API_DOMAIN = new RegExp(`^https://sandbox\\.zohoapis\\.${DCS}$`);
const ACCOUNTS_DOMAIN = new RegExp(`^https://accounts\\.zoho\\.${DCS}$`);

export const DEFAULT_MODULE_API_NAME = "Consultation_Submissions";
export const DEFAULT_MAX_RAW_CHARS = 31_000;
/** Capacity of the Raw_Payload_JSON field verified in the Sandbox (characters). */
export const RAW_FIELD_CAPACITY = 32_000;

const notConfigured = (what: string): never => {
  throw new StoreError("NOT_CONFIGURED", `crm store: ${what}`, "CRM_NOT_CONFIGURED");
};

const positiveInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return notConfigured("invalid numeric limit");
  return n;
};

export function loadCrmConfig(env: Record<string, string | undefined>): CrmConfig {
  const get = (k: string) => (env[k] ?? "").trim();
  if (get("SIX2FIT_CONSULT_CRM_ENABLED") !== "true") notConfigured("CRM mode is not enabled");
  if (get("SIX2FIT_ZOHO_ENVIRONMENT").toLowerCase() !== "sandbox") notConfigured("only the sandbox environment is supported");

  const orgId = get("SIX2FIT_ZOHO_ORG_ID");
  if (!/^\d{6,20}$/.test(orgId)) notConfigured("organisation id missing or malformed");
  const apiDomain = get("SIX2FIT_ZOHO_API_DOMAIN").replace(/\/+$/, "");
  if (!API_DOMAIN.test(apiDomain)) notConfigured("api domain must be a Zoho sandbox domain");
  const accountsDomain = get("SIX2FIT_ZOHO_ACCOUNTS_DOMAIN").replace(/\/+$/, "");
  if (!ACCOUNTS_DOMAIN.test(accountsDomain)) notConfigured("accounts domain missing or invalid");
  const moduleIdPrefix = get("SIX2FIT_ZOHO_MODULE_ID_PREFIX");
  if (!/^\d{6,20}$/.test(moduleIdPrefix) || moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX)) {
    notConfigured("expected sandbox id prefix missing or refers to Production");
  }
  const clientId = get("SIX2FIT_ZOHO_CLIENT_ID");
  const clientSecret = get("SIX2FIT_ZOHO_CLIENT_SECRET");
  const refreshToken = get("SIX2FIT_ZOHO_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) notConfigured("credentials missing");

  const moduleApiName = get("SIX2FIT_ZOHO_MODULE_API_NAME") || DEFAULT_MODULE_API_NAME;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(moduleApiName)) notConfigured("module api name malformed");

  return {
    environment: "sandbox",
    orgId,
    apiDomain,
    accountsDomain,
    moduleIdPrefix,
    clientId,
    clientSecret,
    refreshToken,
    moduleApiName,
    maxRawPayloadChars: positiveInt(env["SIX2FIT_ZOHO_MAX_RAW_CHARS"], DEFAULT_MAX_RAW_CHARS, 1000, RAW_FIELD_CAPACITY),
    requestTimeoutMs: positiveInt(env["SIX2FIT_ZOHO_TIMEOUT_MS"], 10_000, 1, 60_000),
    maxAttempts: positiveInt(env["SIX2FIT_ZOHO_MAX_ATTEMPTS"], 3, 1, 6),
    retryBaseMs: 500,
    verifyTtlMs: 15 * 60 * 1000,
  };
}
