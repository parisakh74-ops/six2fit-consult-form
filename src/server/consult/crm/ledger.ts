import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUBMISSION_ID_PATTERN } from "../contract";
import { StoreError } from "../errors";
import type { ConsultStore, CreateResult, StoredConsult } from "../store";
import type { CrmConsultStore } from "./crm-store";

/**
 * Persistent idempotency ledger + serialized writer in front of the CRM store.
 *
 * Why: Zoho's unique `Submission_ID` check is not atomic across concurrent inserts (observed: two simultaneous
 * identical creates both succeeded) and search lags ~20 s behind a create, so neither the CRM nor a lookup can
 * arbitrate. The ledger does, on the host's local filesystem, which is shared by every worker process the hosting
 * stack may start (Passenger or otherwise) and survives restarts.
 *
 * Mechanism (no locks, no stale-lock deletion): per submission id a directory holds generation files `g1.json`,
 * `g2.json`, ... A generation is created with a temp file + hard link (`link` fails with EEXIST), so exactly one
 * process wins each generation and the file is always complete. The highest generation is the current state.
 * Only the owner of a generation rewrites it (temp file + atomic rename). Taking over is only possible by
 * creating the NEXT generation, again with exactly one winner.
 *
 * States: in_progress (a writer owns it) | created (CRM id known) | unknown (a write may have happened) |
 * released (definitely nothing written) | integrity (more than one CRM record exists: never resolved silently).
 * The ledger holds no answers: ids, the payload fingerprint, the CRM record id, state and timestamps only.
 *
 * Rules:
 *  - Only a writer holding the newest generation sends a POST, and only once per attempt (no blind retry).
 *  - A search that finds nothing is not proof of absence: an unknown outcome is only re-examined after a
 *    quiescence window (default 120 s, > 5x the measured index lag), and the re-examination looks first.
 *  - Anything that is not a confirmed create/exists answer is an error (HTTP 503), never a success.
 */

export type LedgerState = "in_progress" | "created" | "unknown" | "released" | "integrity";

export type LedgerEntry = {
  v: 1;
  id: string;
  gen: number;
  /** Canonical fingerprint of the first accepted payload (not the answers themselves). */
  fp: string;
  state: LedgerState;
  crm_id?: string;
  code?: string;
  attempts: number;
  started: number;
  updated: number;
};

const STATES = new Set<LedgerState>(["in_progress", "created", "unknown", "released", "integrity"]);
const GEN_FILE = /^g(\d{1,9})\.json$/;
const isErrno = (e: unknown, ...codes: string[]) =>
  typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");

export class IdempotencyLedger {
  constructor(private readonly baseDir: string) {}

  private dirFor(id: string): string {
    if (!SUBMISSION_ID_PATTERN.test(id)) throw new StoreError("UNAVAILABLE", "invalid id", "INVALID_ID");
    return join(this.baseDir, id);
  }

  private parse(raw: string, id: string, gen: number): LedgerEntry {
    try {
      const e = JSON.parse(raw) as LedgerEntry;
      if (!e || e.v !== 1 || e.id !== id || e.gen !== gen || typeof e.fp !== "string" || !STATES.has(e.state) || typeof e.updated !== "number") throw new Error("shape");
      return e;
    } catch {
      throw new StoreError("CORRUPT", "idempotency ledger entry is not readable", "LEDGER_CORRUPT");
    }
  }

  /** The newest generation, or null when the id was never seen. */
  async current(id: string): Promise<LedgerEntry | null> {
    const dir = this.dirFor(id);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "ledger read failed", "LEDGER_IO");
    }
    let top = 0;
    for (const n of names) {
      const m = GEN_FILE.exec(n);
      if (m) top = Math.max(top, Number(m[1]));
    }
    if (top === 0) return null;
    try {
      return this.parse(await readFile(join(dir, `g${top}.json`), "utf8"), id, top);
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError("UNAVAILABLE", "ledger read failed", "LEDGER_IO");
    }
  }

  /** Atomically creates generation `entry.gen`. Returns false if another process created it first. */
  async claim(entry: LedgerEntry): Promise<boolean> {
    const dir = this.dirFor(entry.id);
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new StoreError("UNAVAILABLE", "ledger write failed", "LEDGER_IO");
    }
    try {
      await link(temp, join(dir, `g${entry.gen}.json`));
      return true;
    } catch (e) {
      if (isErrno(e, "EEXIST")) return false;
      // No hard links on this filesystem: refuse (a non-atomic fallback would defeat the purpose).
      throw new StoreError("UNAVAILABLE", "ledger claim failed", isErrno(e, "EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP") ? "LEDGER_NO_HARDLINK" : "LEDGER_IO");
    } finally {
      await unlink(temp).catch(() => undefined);
    }
  }

  /** Rewrites a generation this process owns (temp file + atomic rename). */
  async update(entry: LedgerEntry): Promise<void> {
    const dir = this.dirFor(entry.id);
    const temp = join(dir, `t-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
    try {
      await writeFile(temp, JSON.stringify(entry), { encoding: "utf8", mode: 0o600, flag: "wx" });
      // POSIX rename-over is atomic and never blocked by readers; Windows can refuse while a reader has the file open.
      for (let i = 0; ; i += 1) {
        try {
          await rename(temp, join(dir, `g${entry.gen}.json`));
          break;
        } catch (e) {
          if (i >= 20 || !isErrno(e, "EPERM", "EACCES", "EBUSY")) throw e;
          await new Promise((r) => setTimeout(r, 5));
        }
      }
    } catch {
      await unlink(temp).catch(() => undefined);
      throw new StoreError("UNAVAILABLE", "ledger write failed", "LEDGER_IO");
    }
  }
}

export type LedgerStoreOptions = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  /** An in_progress entry older than this has no live writer (crash/restart). Must exceed the worst-case CRM call time. */
  leaseMs?: number;
  /** An unknown outcome is not re-examined before this much time has passed (index lag measured ~21-24 s). */
  quiesceMs?: number;
  /** How long a request waits for another writer of the same submission before answering 503. */
  waitMs?: number;
  pollMs?: number;
};

const stub = (e: LedgerEntry, atMs: number): StoredConsult => ({
  version: 2,
  submission_id: e.id,
  payload_hash: e.fp,
  payload: {}, // the ledger never holds answers; the service only needs the fingerprint and the reference
  ...(e.crm_id ? { record_ref: e.crm_id, crm_record_id: e.crm_id } : {}),
  created_at: new Date(atMs).toISOString(),
});

/** `ConsultStore` = ledger (arbiter) + `CrmConsultStore` (writer). Create-only, never overwrites. */
export class LedgerConsultStore implements ConsultStore {
  private readonly lease: number;
  private readonly quiesce: number;
  private readonly wait: number;
  private readonly poll: number;

  constructor(
    private readonly inner: CrmConsultStore,
    private readonly ledger: IdempotencyLedger,
    private readonly opts: LedgerStoreOptions,
  ) {
    this.lease = opts.leaseMs ?? 150_000;
    this.quiesce = opts.quiesceMs ?? 120_000;
    this.wait = opts.waitMs ?? 20_000;
    this.poll = opts.pollMs ?? 250;
  }

  private log(event: string, fields: Record<string, string | number | boolean> = {}) {
    this.opts.log?.(event, fields);
  }

  /** Full CRM view for later phases (Onboarding): by CRM id from the ledger when known, else by search. */
  getSubmission(id: string) {
    return this.inner.getSubmission(id);
  }

  async get(id: string): Promise<StoredConsult | null> {
    const e = await this.ledger.current(id);
    if (!e) return this.inner.get(id);
    if (e.state === "integrity") throw new StoreError("CORRUPT", "more than one record for a submission id", "DUPLICATE_RECORDS");
    if (e.state === "created") return stub(e, e.updated);
    // in_progress / unknown / released: the service goes on to create(), which arbitrates through the ledger.
    return null;
  }

  async create(id: string, record: StoredConsult): Promise<CreateResult> {
    const fp = record.payload_hash;
    const now = this.opts.now;
    for (let round = 0; round < 8; round += 1) {
      const cur = await this.ledger.current(id);
      if (cur === null) {
        const mine: LedgerEntry = { v: 1, id, gen: 1, fp, state: "in_progress", attempts: 1, started: now(), updated: now() };
        if (await this.ledger.claim(mine)) return this.write(mine, record);
        continue; // lost the race: re-read
      }
      if (cur.state === "integrity") throw new StoreError("CORRUPT", "more than one record for a submission id", "DUPLICATE_RECORDS");
      if (cur.state === "created") return { status: "exists", record: stub(cur, cur.updated) };
      if (cur.state === "released") {
        const mine: LedgerEntry = { v: 1, id, gen: cur.gen + 1, fp, state: "in_progress", attempts: cur.attempts + 1, started: now(), updated: now() };
        if (await this.ledger.claim(mine)) return this.write(mine, record);
        continue;
      }
      // in_progress or unknown from here on.
      if (cur.fp !== fp) {
        // Same id, different answers while the first outcome is still open: the first one wins (409 via the service).
        this.log("ledger.conflict");
        return { status: "exists", record: stub(cur, cur.updated) };
      }
      const age = now() - cur.updated;
      if (cur.state === "in_progress" && age < this.lease) {
        await this.waitForChange(id, cur.gen);
        continue;
      }
      // unknown, or in_progress whose writer is gone (lease expired): treat as unknown.
      if (age < this.quiesce) throw new StoreError("UNAVAILABLE", "outcome of an earlier attempt is still unknown", "OUTCOME_UNKNOWN");
      const mine: LedgerEntry = { v: 1, id, gen: cur.gen + 1, fp, state: "in_progress", attempts: cur.attempts + 1, started: cur.started, updated: now() };
      if (!(await this.ledger.claim(mine))) continue;
      this.log("ledger.reconcile", { attempts: mine.attempts });
      return this.reconcileThenWrite(mine, cur, record);
    }
    throw new StoreError("UNAVAILABLE", "could not settle idempotency state", "LEDGER_CONTENDED");
  }

  /** Waits for the owner of generation `gen` to finish; throws IN_PROGRESS (503, safe to retry) if it does not. */
  private async waitForChange(id: string, gen: number): Promise<void> {
    const t0 = this.opts.now();
    for (;;) {
      await this.opts.sleep(this.poll);
      const e = await this.ledger.current(id);
      if (!e || e.gen !== gen || e.state !== "in_progress") return;
      if (this.opts.now() - t0 >= this.wait) throw new StoreError("UNAVAILABLE", "another request for this submission is in progress", "IN_PROGRESS");
    }
  }

  private async reconcileThenWrite(mine: LedgerEntry, previous: LedgerEntry, record: StoredConsult): Promise<CreateResult> {
    let found: string | null;
    try {
      found = await this.inner.lookupId(mine.id);
    } catch (e) {
      // Lookup failed: nothing learned. Hand the state back as unknown with the original timestamp.
      await this.settle({ ...mine, state: e instanceof StoreError && e.kind === "CORRUPT" ? "integrity" : "unknown", updated: e instanceof StoreError && e.kind === "CORRUPT" ? this.opts.now() : previous.updated, ...(e instanceof StoreError && e.code ? { code: e.code } : {}) });
      throw e;
    }
    if (found === null) return this.write(mine, record);
    try {
      const view = await this.inner.readRecord(found, mine.id);
      await this.settle({ ...mine, fp: view.stored.payload_hash, state: "created", crm_id: found, updated: this.opts.now() });
      return { status: "exists", record: view.stored };
    } catch (e) {
      await this.settle({ ...mine, state: e instanceof StoreError && e.kind === "CORRUPT" ? "integrity" : "unknown", updated: previous.updated, crm_id: found });
      throw e;
    }
  }

  /** The single place where a POST can happen: the caller owns the newest generation. */
  private async write(mine: LedgerEntry, record: StoredConsult): Promise<CreateResult> {
    let result: CreateResult;
    try {
      result = await this.inner.create(mine.id, record);
    } catch (e) {
      const store = e instanceof StoreError ? e : null;
      const state: LedgerState = store?.kind === "CORRUPT" ? "integrity" : store?.notWritten === true ? "released" : "unknown";
      await this.settle({ ...mine, state, updated: this.opts.now(), ...(store?.code ? { code: store.code } : {}) });
      throw e;
    }
    const id = result.record.record_ref ?? result.record.crm_record_id;
    // A ledger failure after a confirmed CRM answer must not turn a true success into an error: the entry stays
    // in_progress and is reconciled (lookup first) by the next request.
    await this.settle({ ...mine, fp: result.record.payload_hash, state: "created", ...(id ? { crm_id: id } : {}), updated: this.opts.now() });
    return result;
  }

  private async settle(entry: LedgerEntry): Promise<void> {
    try {
      await this.ledger.update(entry);
    } catch {
      this.log("ledger.update_failed", { state: entry.state });
    }
  }
}
