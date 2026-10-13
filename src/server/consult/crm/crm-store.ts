import { SUBMISSION_ID_PATTERN } from "../contract";
import { StoreError } from "../errors";
import type { ConsultStore, CreateResult, StoredConsult } from "../store";
import { INVALID, ZohoClient, ZohoTransportError, type ZohoResponse } from "./client";
import type { CrmConfig } from "./config";
import { buildCrmRecord, parseCrmRecord, type CrmSubmissionView } from "./mapping";

export type CrmStoreDeps = {
  client: ZohoClient;
  config: CrmConfig;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Safe diagnostics only: codes, counts, timings; never answers, ids of people, tokens. */
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  /**
   * Optional association with an already identified Lead/Contact (ids only). Identity resolution is a
   * separate, later phase; failure to resolve never blocks persistence (return `undefined`).
   */
  associations?: (submissionId: string, payload: Record<string, unknown>) => { lead?: string; contact?: string } | undefined;
};

type DataItem = { code?: unknown; status?: unknown; details?: { id?: unknown; api_name?: unknown; duplicate_record?: { id?: unknown }; id_?: unknown } };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * `ConsultStore` backed by the Zoho CRM module `Consultation_Submissions` (Sandbox).
 *
 * Idempotency / duplicates:
 *  - `create` never upserts or updates. The unique field `Submission_ID` is the authoritative guard:
 *    a duplicate answer makes the adapter read the existing record and return `exists`; the service
 *    then compares canonical fingerprints (equivalent -> deduplicated success, different -> conflict).
 *  - Timeouts, 5xx and unreadable responses are AMBIGUOUS (the record may exist): the adapter looks the
 *    submission up before retrying the write, so a retry can never create a second record.
 *  - 429 is retried after the advertised delay (the request was not processed).
 *  - Every other failure ends in a `StoreError` (HTTP 503 for the browser), never in silent loss.
 */
export class CrmConsultStore implements ConsultStore {
  constructor(private readonly deps: CrmStoreDeps) {}

  private log(event: string, fields: Record<string, string | number | boolean> = {}) {
    this.deps.log?.(event, fields);
  }

  private backoff(attempt: number, retryAfterMs?: number): number {
    const base = this.deps.config.retryBaseMs * 3 ** (attempt - 1);
    return Math.max(retryAfterMs ?? 0, Math.min(base, 5000));
  }

  private assertId(submissionId: string): void {
    if (!SUBMISSION_ID_PATTERN.test(submissionId)) throw new StoreError("UNAVAILABLE", "invalid id", "INVALID_ID");
  }

  /** Full retrieval for the backend: stored view + subform rows + association ids. */
  async getSubmission(submissionId: string): Promise<CrmSubmissionView | null> {
    this.assertId(submissionId);
    await this.deps.client.verifyEnvironment();
    const found = await this.searchId(submissionId);
    if (found === null) return null;
    return this.readById(found, submissionId);
  }

  async get(submissionId: string): Promise<StoredConsult | null> {
    return (await this.getSubmission(submissionId))?.stored ?? null;
  }

  /** Search by the unique field. HTTP 204 / empty data = not found. */
  private async searchId(submissionId: string): Promise<string | null> {
    const res = await this.call("GET", `/${this.deps.config.moduleApiName}/search`, {
      query: { criteria: `(Submission_ID:equals:${submissionId})`, fields: "id,Submission_ID" },
    });
    if (res.status === 204) return null;
    const list = this.dataList(res);
    if (list.length === 0) return null;
    // Zoho documents `equals` in search as contains-like: keep only the exact (case-insensitive) Submission_ID.
    const exact: string[] = [];
    for (const item of list) {
      if (!isObj(item) || typeof item["id"] !== "string") throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
      if (typeof item["Submission_ID"] === "string" && item["Submission_ID"].toLowerCase() === submissionId.toLowerCase()) exact.push(item["id"]);
    }
    if (exact.length > 1) {
      // Cannot happen with the unique constraint; never pick one silently.
      throw new StoreError("CORRUPT", "more than one record for a submission id", "DUPLICATE_RECORDS");
    }
    return exact[0] ?? null;
  }

  private async readById(recordId: string, submissionId: string): Promise<CrmSubmissionView> {
    if (!/^\d{6,25}$/.test(recordId)) throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
    const res = await this.call("GET", `/${this.deps.config.moduleApiName}/${recordId}`);
    if (res.status === 204) throw new StoreError("UNAVAILABLE", "record not readable yet", "READ_AFTER_WRITE");
    const list = this.dataList(res);
    return parseCrmRecord(list[0], submissionId);
  }

  private dataList(res: ZohoResponse): unknown[] {
    this.classifyFailure(res);
    const j = res.json;
    if (j === INVALID || j === null || !isObj(j) || !Array.isArray(j["data"])) {
      throw new StoreError("UNAVAILABLE", "invalid crm response", "INVALID_RESPONSE");
    }
    return j["data"] as unknown[];
  }

  /** Transport wrapper: maps a transport failure to a retryable StoreError. */
  private async call(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown } = {}): Promise<ZohoResponse> {
    try {
      return await this.deps.client.request(method, path, opts);
    } catch (e) {
      if (e instanceof ZohoTransportError) throw new StoreError("UNAVAILABLE", `crm ${e.reason}`, e.reason === "timeout" ? "TIMEOUT" : "NETWORK");
      throw e;
    }
  }

  /** Throws for the HTTP failures that are never a successful outcome of a read. */
  private classifyFailure(res: ZohoResponse): void {
    const s = res.status;
    if (s >= 200 && s < 300) return;
    if (s === 401 && isObj(res.json) && res.json["code"] === "OAUTH_SCOPE_MISMATCH") throw new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN");
    if (s === 401) throw new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED");
    if (s === 403) throw new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN");
    if (s === 429) throw new StoreError("UNAVAILABLE", "crm rate limited", "RATE_LIMITED");
    if (s >= 500) throw new StoreError("UNAVAILABLE", "crm unavailable", "UPSTREAM_5XX");
    throw new StoreError("UNAVAILABLE", "crm request refused", `HTTP_${s}`);
  }

  async create(submissionId: string, record: StoredConsult): Promise<CreateResult> {
    this.assertId(submissionId);
    const { config } = this.deps;
    const association = this.deps.associations?.(submissionId, record.payload);
    const mapped = buildCrmRecord(record.payload, {
      receivedAt: new Date(this.deps.now()),
      payloadHash: record.payload_hash,
      maxRawPayloadChars: config.maxRawPayloadChars,
      lead: association?.lead,
      contact: association?.contact,
      sandboxIdPrefix: config.moduleIdPrefix,
    });
    if (mapped.degraded.length > 0) this.log("crm.mapping.degraded", { fields: mapped.degraded.join(",") });
    await this.deps.client.verifyEnvironment();

    const body = { data: [mapped.record], trigger: [] as string[] };
    let lastError: StoreError | null = null;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      let res: ZohoResponse | null = null;
      let transport: "timeout" | "network" | null = null;
      try {
        res = await this.deps.client.request("POST", `/${config.moduleApiName}`, { body });
      } catch (e) {
        if (e instanceof ZohoTransportError) transport = e.reason;
        else throw e;
      }

      if (res !== null) {
        const outcome = this.interpretCreate(res);
        if (outcome.kind === "created") {
          this.log("crm.created", { attempt, rawChars: mapped.rawChars });
          return { status: "created", record: { ...record, record_ref: outcome.id, crm_record_id: outcome.id } };
        }
        if (outcome.kind === "duplicate") return this.resolveDuplicate(submissionId, outcome.existingId);
        if (outcome.kind === "fatal") throw outcome.error;
        if (outcome.kind === "retry-safe") {
          // 429: not processed. Wait and retry without a lookup.
          lastError = new StoreError("UNAVAILABLE", "crm rate limited", "RATE_LIMITED");
          this.log("crm.retry", { attempt, reason: "rate_limited" });
          if (attempt < config.maxAttempts) await this.deps.sleep(this.backoff(attempt, outcome.retryAfterMs));
          continue;
        }
        // "ambiguous": fall through to the lookup below.
        lastError = new StoreError("UNAVAILABLE", "crm outcome unknown", outcome.code);
      } else {
        lastError = new StoreError("UNAVAILABLE", "crm outcome unknown", transport === "timeout" ? "TIMEOUT" : "NETWORK");
      }

      // Ambiguous outcome: the record may already exist. Look it up before any further write.
      this.log("crm.ambiguous", { attempt, reason: lastError.code ?? "unknown" });
      try {
        const existingId = await this.searchId(submissionId);
        if (existingId !== null) {
          const view = await this.readById(existingId, submissionId);
          return { status: "exists", record: view.stored };
        }
      } catch (e) {
        if (!(e instanceof StoreError) || e.kind === "CORRUPT") throw e;
        // The lookup failed as well: still unknown. A later attempt (or a client retry) is safe.
        this.log("crm.lookup_failed", { attempt, reason: e.code ?? "unknown" });
        lastError = new StoreError("UNAVAILABLE", "crm outcome unknown", "AMBIGUOUS");
      }
      if (attempt < config.maxAttempts) await this.deps.sleep(this.backoff(attempt));
    }
    throw lastError ?? new StoreError("UNAVAILABLE", "crm create failed", "EXHAUSTED");
  }

  private interpretCreate(
    res: ZohoResponse,
  ):
    | { kind: "created"; id: string }
    | { kind: "duplicate"; existingId: string | null }
    | { kind: "fatal"; error: StoreError }
    | { kind: "retry-safe"; retryAfterMs: number | undefined }
    | { kind: "ambiguous"; code: string } {
    const s = res.status;
    if (s === 401 && isObj(res.json) && res.json["code"] === "OAUTH_SCOPE_MISMATCH") {
      return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    }
    if (s === 401) return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED") };
    if (s === 403) return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    if (s === 429) return { kind: "retry-safe", retryAfterMs: res.retryAfterMs };
    if (s >= 500) return { kind: "ambiguous", code: "UPSTREAM_5XX" };

    const j = res.json;
    if (j === INVALID || j === null || !isObj(j)) {
      // 2xx/4xx without a readable body: we cannot tell whether it was stored.
      return { kind: "ambiguous", code: "INVALID_RESPONSE" };
    }
    // Error envelope (HTTP 4xx): { code, details, message, status }
    const top = typeof j["code"] === "string" ? j["code"] : undefined;
    const items = Array.isArray(j["data"]) ? (j["data"] as DataItem[]) : null;
    const item = items?.[0];
    const code = typeof item?.code === "string" ? item.code : top;
    if (code === "SUCCESS" && items?.length === 1) {
      const id = item?.details?.id;
      if (typeof id === "string" && /^\d{6,25}$/.test(id)) return { kind: "created", id };
      return { kind: "ambiguous", code: "INVALID_RESPONSE" };
    }
    if (code === "DUPLICATE_DATA") {
      const dup = item?.details?.id ?? item?.details?.duplicate_record?.id ?? (isObj(j["details"]) ? ((j["details"] as Record<string, unknown>)["id"] ?? (isObj((j["details"] as Record<string, unknown>)["duplicate_record"]) ? ((j["details"] as { duplicate_record: { id?: unknown } }).duplicate_record.id) : undefined)) : undefined);
      return { kind: "duplicate", existingId: typeof dup === "string" && /^\d{6,25}$/.test(dup) ? dup : null };
    }
    if (code === "INVALID_TOKEN" || code === "AUTHENTICATION_FAILURE") {
      return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authentication failed", "AUTH_FAILED") };
    }
    if (code === "OAUTH_SCOPE_MISMATCH" || code === "NO_PERMISSION" || code === "NO_ACCESS") {
      return { kind: "fatal", error: new StoreError("UNAVAILABLE", "crm authorization failed", "FORBIDDEN") };
    }
    if (code === "TOO_MANY_REQUESTS" || code === "RATE_LIMIT_EXCEEDED") return { kind: "retry-safe", retryAfterMs: res.retryAfterMs };
    if (code === "INTERNAL_ERROR" || code === "SERVICE_UNAVAILABLE") return { kind: "ambiguous", code: "UPSTREAM_ERROR" };
    if (typeof code === "string" && s >= 400 && s < 500) {
      // Field validation failure (INVALID_DATA, MANDATORY_NOT_FOUND, NOT_ALLOWED, ...): our defect, never retried.
      const field = typeof item?.details === "object" && item?.details && typeof item.details.api_name === "string" ? item.details.api_name : undefined;
      return { kind: "fatal", error: new StoreError("REJECTED", "crm rejected the record", `${code}${field ? `:${field}` : ""}`.slice(0, 120)) };
    }
    return { kind: "ambiguous", code: "INVALID_RESPONSE" };
  }

  /** A duplicate answer means the submission exists: fetch it (id from the error, else by search). */
  private async resolveDuplicate(submissionId: string, existingId: string | null): Promise<CreateResult> {
    let id = existingId;
    // The search index can lag behind the write: a few short retries, never a second write.
    for (let attempt = 1; id === null && attempt <= this.deps.config.maxAttempts; attempt += 1) {
      id = await this.searchId(submissionId);
      if (id === null && attempt < this.deps.config.maxAttempts) await this.deps.sleep(this.backoff(attempt));
    }
    if (id === null) throw new StoreError("UNAVAILABLE", "duplicate reported but record not found", "DUPLICATE_UNRESOLVED");
    const view = await this.readById(id, submissionId);
    this.log("crm.duplicate", {});
    return { status: "exists", record: view.stored };
  }
}
