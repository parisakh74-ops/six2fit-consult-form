import { FORM_VERSION } from "../../features/consult/assessmentConfig";
import { fingerprint, legacyPayloadHash } from "./canonical";
import {
  DEFAULT_MAX_BODY_BYTES,
  SUBMISSION_ID_PATTERN,
  errorResult,
  type ConsultResult,
} from "./contract";
import { StoreError, type ConsultStore, type StoredConsult } from "./store";
import { validateConsultPayload } from "./validate";

export type ConsultServiceDeps = {
  store: ConsultStore;
  now?: () => number;
  maxBodyBytes?: number;
  /** Structured logger; receives codes and counters only, never answers, ids or paths. */
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export type ConsultSubmitInput = {
  contentType: string | null;
  idempotencyKey: string | null;
  /** Raw request body text (already limited by the HTTP layer; re-checked here). */
  body: string;
};

export function recordRef(submissionId: string): string {
  // Kept as `staging_<id>` while CRM is not connected (same meaning as before).
  return `staging_${submissionId}`;
}

/** The single authoritative implementation of POST /api/consult/submit business logic. */
export function createConsultService(deps: ConsultServiceDeps) {
  const now = deps.now ?? (() => Date.now());
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const log = deps.log ?? (() => undefined);

  function success(submissionId: string, payload: Record<string, unknown>, deduplicated: boolean, ref: string): ConsultResult {
    return {
      status: 200,
      body: {
        ok: true,
        crm_record_id: ref,
        deduplicated,
      },
    };
  }

  function sameSubmission(existing: StoredConsult, incoming: Record<string, unknown>, hash: string): boolean {
    if (existing.payload_hash === hash) return true;
    // Legacy records (no version) were hashed with JSON.stringify of the whole payload.
    return existing.version === undefined && existing.payload_hash === legacyPayloadHash(incoming);
  }

  async function submit(input: ConsultSubmitInput): Promise<ConsultResult> {
    const startedAt = now();
    const done = (result: ConsultResult, event: string): ConsultResult => {
      log(event, { status: result.status, ms: now() - startedAt });
      return result;
    };

    if (!/^application\/json\s*(;|$)/i.test(input.contentType ?? "")) {
      return done(errorResult("UNSUPPORTED_MEDIA_TYPE"), "consult.rejected.media_type");
    }
    if (Buffer.byteLength(input.body, "utf8") > maxBody) {
      return done(errorResult("PAYLOAD_TOO_LARGE"), "consult.rejected.too_large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(input.body);
    } catch {
      return done(errorResult("INVALID_JSON"), "consult.rejected.invalid_json");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return done(errorResult("INVALID_PAYLOAD", { issues: [{ path: "", code: "INVALID_TYPE" }] }), "consult.rejected.shape");
    }
    const payload = parsed as Record<string, unknown>;

    const submissionId = payload["submission_id"];
    const key = input.idempotencyKey ?? "";
    if (!SUBMISSION_ID_PATTERN.test(key) || (typeof submissionId === "string" && submissionId !== key)) {
      return done(errorResult("INVALID_IDEMPOTENCY_KEY"), "consult.rejected.idempotency_key");
    }
    if (payload["form_version"] !== FORM_VERSION) {
      return done(errorResult("UNSUPPORTED_FORM_VERSION"), "consult.rejected.form_version");
    }

    const validation = validateConsultPayload(payload);
    if (!validation.ok) {
      const code = validation.kind;
      return done(errorResult(code, { issues: validation.issues }), `consult.rejected.${code.toLowerCase()}`);
    }

    const id = key;
    const hash = fingerprint(payload);
    try {
      const existing = await deps.store.get(id);
      if (existing) {
        return sameSubmission(existing, payload, hash)
          ? done(success(id, payload, true, existing.record_ref ?? existing.crm_record_id ?? recordRef(id)), "consult.deduplicated")
          : done(errorResult("SUBMISSION_CONFLICT"), "consult.conflict");
      }

      const record: StoredConsult = {
        version: 2,
        submission_id: id,
        payload_hash: hash,
        payload, // lossless: exactly what the browser sent (already validated, never filtered)
        record_ref: recordRef(id),
        created_at: new Date(now()).toISOString(),
      };
      const created = await deps.store.create(id, record);
      if (created.status === "created") return done(success(id, payload, false, created.record.record_ref ?? (record.record_ref as string)), "consult.created");
      // Lost a race with a concurrent identical/conflicting request.
      return sameSubmission(created.record, payload, hash)
        ? done(success(id, payload, true, created.record.record_ref ?? created.record.crm_record_id ?? recordRef(id)), "consult.deduplicated")
        : done(errorResult("SUBMISSION_CONFLICT"), "consult.conflict");
    } catch (error) {
      const kind = error instanceof StoreError ? error.kind : "UNEXPECTED";
      const code = error instanceof StoreError ? error.code : undefined;
      log(code === "DUPLICATE_RECORDS" ? "consult.integrity_exception" : "consult.storage_failure", { kind, ...(code ? { code } : {}), ms: now() - startedAt });
      return errorResult("STORAGE_UNAVAILABLE");
    }
  }

  return { submit };
}

export type ConsultService = ReturnType<typeof createConsultService>;
