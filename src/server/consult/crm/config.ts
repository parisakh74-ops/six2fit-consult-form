import { StoreError } from "../errors";

/**
 * Configuration contract of the Zoho CRM adapter (server-side environment only).
 *
 * CRM mode is OFF unless BOTH `SIX2FIT_CONSULT_STORE=crm` and `SIX2FIT_CONSULT_CRM_ENABLED=true`
 * are set. The Zoho environment is EXPLICIT (`sandbox` or `production`, no default, never inferred):
 * host, accounts domain, organisation identity and module id prefix must all match it. A missing,
 * malformed or cross-environment value fails closed with `NOT_CONFIGURED`. Error messages never
 * contain configuration values (they may be secrets).
 *
 * Variables (nothing has a default except limits):
 *   SIX2FIT_CONSULT_CRM_ENABLED        "true"
 *   SIX2FIT_ZOHO_ENVIRONMENT           "sandbox" | "production" (required)
 *   SIX2FIT_ZOHO_ORG_ZGID              expected organisation `zgid` (digits): the "Org ID" shown in the CRM UI
 *   SIX2FIT_ZOHO_ORG_API_ID            pin of the organisation API `id` (a different number than the zgid); REQUIRED in
 *                                      production (must start with the Production prefix), optional in sandbox (must not)
 *   SIX2FIT_ZOHO_API_DOMAIN            sandbox: https://sandbox.zohoapis.<dc>   production: https://www.zohoapis.<dc>
 *   SIX2FIT_ZOHO_ACCOUNTS_DOMAIN       https://accounts.zoho.<dc> (same data centre as the API domain)
 *   SIX2FIT_ZOHO_MODULE_ID_PREFIX      expected id prefix of the organisation (digits), checked on the module id
 *   SIX2FIT_ZOHO_CLIENT_ID / SIX2FIT_ZOHO_CLIENT_SECRET / SIX2FIT_ZOHO_REFRESH_TOKEN   grant of the SAME environment only
 *   SIX2FIT_ZOHO_MODULE_API_NAME       default Consultation_Submissions
 *   SIX2FIT_ZOHO_MAX_RAW_CHARS         default 31000 (Raw_Payload_JSON capacity is 32,000 characters)
 *   SIX2FIT_ZOHO_TIMEOUT_MS            default 10000
 *   SIX2FIT_ZOHO_MAX_ATTEMPTS          default 3
 */
export type CrmConfig = {
  environment: "sandbox" | "production";
  orgZgid: string;
  orgApiId: string | undefined;
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
const PRODUCTION_API_DOMAIN = new RegExp(`^https://www\\.zohoapis\\.${DCS}$`);
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
  // The environment is ALWAYS explicit: never inferred from a token, a host name or an id prefix, and there is no default.
  const envRaw = get("SIX2FIT_ZOHO_ENVIRONMENT").toLowerCase();
  if (envRaw !== "sandbox" && envRaw !== "production") notConfigured("SIX2FIT_ZOHO_ENVIRONMENT must be explicitly 'sandbox' or 'production'");
  const environment: "sandbox" | "production" = envRaw === "production" ? "production" : "sandbox";
  const production = environment === "production";

  const orgZgid = get("SIX2FIT_ZOHO_ORG_ZGID");
  if (!/^\d{6,20}$/.test(orgZgid)) notConfigured("organisation zgid missing or malformed");
  const orgApiIdRaw = get("SIX2FIT_ZOHO_ORG_API_ID");
  if (orgApiIdRaw !== "" && !/^\d{6,25}$/.test(orgApiIdRaw)) notConfigured("organisation api id malformed");
  // Production: the organisation API id is mandatory (a second, independent identity pin) and carries the Production prefix;
  // Sandbox: it must not carry the Production prefix.
  if (production && orgApiIdRaw === "") notConfigured("organisation api id is required in production");
  if (orgApiIdRaw !== "" && orgApiIdRaw.startsWith(PRODUCTION_ID_PREFIX) !== production) notConfigured("organisation api id does not belong to the configured environment");
  const apiDomain = get("SIX2FIT_ZOHO_API_DOMAIN").replace(/\/+$/, "");
  const apiDomainMatch = (production ? PRODUCTION_API_DOMAIN : API_DOMAIN).exec(apiDomain);
  if (!apiDomainMatch) notConfigured(production ? "api domain must be a Zoho production domain (https://www.zohoapis.<dc>)" : "api domain must be a Zoho sandbox domain");
  const accountsDomain = get("SIX2FIT_ZOHO_ACCOUNTS_DOMAIN").replace(/\/+$/, "");
  const accountsMatch = ACCOUNTS_DOMAIN.exec(accountsDomain);
  if (!accountsMatch) notConfigured("accounts domain missing or invalid");
  // A token request must never go to a different data centre than the API it authorises (credentials would leave the DC).
  if (apiDomainMatch?.[1] !== accountsMatch?.[1]) notConfigured("accounts and api domains belong to different data centres");
  const moduleIdPrefix = get("SIX2FIT_ZOHO_MODULE_ID_PREFIX");
  if (!/^\d{6,20}$/.test(moduleIdPrefix)) notConfigured("expected module id prefix missing or malformed");
  // Sandbox must never carry the Production prefix; Production must carry exactly the Production organisation's prefix.
  if (production ? !moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX) : moduleIdPrefix.startsWith(PRODUCTION_ID_PREFIX)) {
    notConfigured(production ? "expected id prefix is not the Production prefix" : "expected sandbox id prefix refers to Production");
  }
  const clientId = get("SIX2FIT_ZOHO_CLIENT_ID");
  const clientSecret = get("SIX2FIT_ZOHO_CLIENT_SECRET");
  const refreshToken = get("SIX2FIT_ZOHO_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) notConfigured("credentials missing");

  const moduleApiName = get("SIX2FIT_ZOHO_MODULE_API_NAME") || DEFAULT_MODULE_API_NAME;
  if (!/^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(moduleApiName)) notConfigured("module api name malformed");

  return {
    environment,
    orgZgid,
    orgApiId: orgApiIdRaw === "" ? undefined : orgApiIdRaw,
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
