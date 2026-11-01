/**
 * ManyChat `form_submitted` marker (server side, off by default).
 *
 * Replaces the legacy Supabase function `mark-form-submitted`: after a verified, non-duplicate submission it sets the
 * Boolean custom field `form_submitted` (id 14310220) to true on the ManyChat contact, so the existing "Consult" flow
 * (sets No, sends the link, waits 2 hours, follows up only while the field is false) stops following up.
 *
 * Guarantees: never throws, never blocks the submission, logs counters only (no ids, no token), bounded retries,
 * idempotent (the value is constant). The token comes from the server environment only.
 */

export const DEFAULT_FORM_SUBMITTED_FIELD_ID = 14310220;
const API_URL = "https://api.manychat.com/fb/subscriber/setCustomField";

export type MarkOutcome =
  | "disabled"
  | "skipped_no_id"
  | "skipped_invalid_id"
  | "skipped_no_token"
  | "marked"
  | "rejected"
  | "failed";

export interface ManychatMarkerConfig {
  enabled: boolean;
  token: string;
  fieldId: number;
  /** Total attempts (first try plus retries). */
  maxAttempts: number;
  timeoutMs: number;
  retryBaseMs: number;
}

export interface ManychatMarkerDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
}

/** ManyChat Contact Ids are integers. Anything else (empty, "unknown", free text) is skipped, never sent. */
export function parseSubscriberId(raw: string | null | undefined): number | null {
  const v = (raw ?? "").trim();
  if (!/^\d{1,16}$/.test(v)) return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function manychatConfigFromEnv(
  env: Record<string, string | undefined>,
): ManychatMarkerConfig {
  const fieldRaw = Number(env["SIX2FIT_MANYCHAT_FORM_SUBMITTED_FIELD_ID"]);
  const attempts = Number(env["SIX2FIT_MANYCHAT_MAX_ATTEMPTS"]);
  return {
    enabled: env["SIX2FIT_CONSULT_MANYCHAT_MARK"] === "true",
    token: (env["SIX2FIT_MANYCHAT_API_TOKEN"] ?? "").trim(),
    fieldId:
      Number.isSafeInteger(fieldRaw) && fieldRaw > 0 ? fieldRaw : DEFAULT_FORM_SUBMITTED_FIELD_ID,
    maxAttempts: Number.isInteger(attempts) && attempts >= 1 && attempts <= 5 ? attempts : 3,
    timeoutMs: 5000,
    retryBaseMs: 500,
  };
}

export function createManychatMarker(config: ManychatMarkerConfig, deps: ManychatMarkerDeps = {}) {
  const doFetch = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? (() => undefined);

  async function attempt(subscriberId: number): Promise<"ok" | "retry" | "rejected"> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await doFetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
        body: JSON.stringify({
          subscriber_id: subscriberId,
          field_id: config.fieldId,
          field_value: true,
        }),
        signal: controller.signal,
      });
      if (res.ok) return "ok";
      // Rate limit and server errors are worth retrying; other 4xx (bad id, bad token, missing field) are not.
      return res.status === 429 || res.status >= 500 ? "retry" : "rejected";
    } catch {
      return "retry";
    } finally {
      clearTimeout(timer);
    }
  }

  /** Never throws. Resolves to the outcome so callers and tests can observe it. */
  async function markFormSubmitted(rawId: string | null | undefined): Promise<MarkOutcome> {
    try {
      if (!config.enabled) return "disabled";
      if (!rawId || rawId.trim() === "") return "skipped_no_id";
      const id = parseSubscriberId(rawId);
      if (id === null) {
        log("consult.manychat.skipped_invalid_id");
        return "skipped_invalid_id";
      }
      if (config.token === "") {
        log("consult.manychat.skipped_no_token");
        return "skipped_no_token";
      }
      for (let n = 1; n <= config.maxAttempts; n++) {
        const result = await attempt(id);
        if (result === "ok") {
          log("consult.manychat.marked", { attempts: n });
          return "marked";
        }
        if (result === "rejected") {
          log("consult.manychat.rejected", { attempts: n });
          return "rejected";
        }
        if (n < config.maxAttempts) await sleep(config.retryBaseMs * 2 ** (n - 1));
      }
      log("consult.manychat.failed", { attempts: config.maxAttempts });
      return "failed";
    } catch {
      return "failed";
    }
  }

  return { markFormSubmitted };
}

export type ManychatMarker = ReturnType<typeof createManychatMarker>;
