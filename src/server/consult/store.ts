import { randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SUBMISSION_ID_PATTERN } from "./contract";
import { createCrmConsultStore } from "./crm/factory";
import { StoreError } from "./errors";

/**
 * A persisted consultation submission. `record_ref` is the stable reference returned to the
 * browser as `crm_record_id` (kept as `staging_<submission_id>` while CRM is not connected).
 */
export type StoredConsult = {
  /** 2 = canonical fingerprint; legacy records (no version) carry the old key-order hash. */
  version?: 2;
  submission_id?: string;
  payload_hash: string;
  payload: Record<string, unknown>;
  record_ref?: string;
  crm_record_id?: string;
  created_at: string;
};

export type CreateResult =
  | { status: "created"; record: StoredConsult }
  | { status: "exists"; record: StoredConsult };

/**
 * Create-only persistence port. Implemented today by `FileConsultStore` (isolated
 * development/testing) and later by a `CrmStore` (Consultation Submissions module, unique
 * `Submission_ID`). Implementations MUST:
 *  - never overwrite or delete an existing submission,
 *  - make `create` atomic and idempotent (exactly one concurrent caller gets `created`),
 *  - preserve the payload losslessly,
 *  - throw `StoreError` (without payload data) on failure.
 */
export interface ConsultStore {
  get(submissionId: string): Promise<StoredConsult | null>;
  create(submissionId: string, record: StoredConsult): Promise<CreateResult>;
}

export { StoreError } from "./errors";

const isErrno = (e: unknown, ...codes: string[]) =>
  typeof e === "object" && e !== null && codes.includes((e as NodeJS.ErrnoException).code ?? "");

/**
 * File adapter (development/testing only). Atomic create-only semantics:
 * the record is written to a private temp file and then hard-linked to its final name;
 * `link` fails with EEXIST if the submission already exists, so there is no claim file and
 * therefore no permanently "in progress" state. A crash before the link leaves only a temp
 * file (ignored, removable with `sweepStaleTemps`); a crash after the link leaves a complete
 * record, so a retry deduplicates. Limitation: only safe on one filesystem that supports
 * hard links; the fallback (exclusive create + write) is not crash-atomic and is flagged by
 * `fallbackUsed`. Records contain full answers in plaintext: never use in Production (D13).
 */
export class FileConsultStore implements ConsultStore {
  public fallbackUsed = false;

  constructor(private readonly baseDir: string) {}

  private dir() {
    return join(this.baseDir, "consult");
  }

  private pathFor(submissionId: string) {
    if (!SUBMISSION_ID_PATTERN.test(submissionId)) throw new StoreError("UNAVAILABLE", "invalid id");
    return join(this.dir(), `${submissionId}.json`);
  }

  async get(submissionId: string): Promise<StoredConsult | null> {
    const path = this.pathFor(submissionId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      if (isErrno(e, "ENOENT")) return null;
      throw new StoreError("UNAVAILABLE", "read failed");
    }
    try {
      const parsed = JSON.parse(raw) as StoredConsult;
      if (!parsed || typeof parsed !== "object" || typeof parsed.payload_hash !== "string") throw new Error("shape");
      return parsed;
    } catch {
      throw new StoreError("CORRUPT", "stored record is not readable");
    }
  }

  async create(submissionId: string, record: StoredConsult): Promise<CreateResult> {
    const finalPath = this.pathFor(submissionId);
    const tempPath = `${finalPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await mkdir(this.dir(), { recursive: true });
      await writeFile(tempPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      throw new StoreError("UNAVAILABLE", "write failed");
    }
    try {
      try {
        await link(tempPath, finalPath);
        return { status: "created", record };
      } catch (e) {
        if (isErrno(e, "EEXIST")) {
          const existing = await this.get(submissionId);
          if (existing) return { status: "exists", record: existing };
          throw new StoreError("UNAVAILABLE", "record vanished");
        }
        if (!isErrno(e, "EPERM", "ENOSYS", "EXDEV", "EOPNOTSUPP", "ENOTSUP")) {
          throw new StoreError("UNAVAILABLE", "link failed");
        }
        // Filesystem without hard links: exclusive create (not crash-atomic).
        this.fallbackUsed = true;
        try {
          const handle = await open(finalPath, "wx", 0o600);
          try {
            await handle.writeFile(JSON.stringify(record), "utf8");
            await handle.sync();
          } finally {
            await handle.close();
          }
          return { status: "created", record };
        } catch (e2) {
          if (isErrno(e2, "EEXIST")) {
            const existing = await this.get(submissionId);
            if (existing) return { status: "exists", record: existing };
          }
          throw new StoreError("UNAVAILABLE", "create failed");
        }
      }
    } finally {
      await unlink(tempPath).catch(() => undefined);
    }
  }

  /** Housekeeping for temp files left by interrupted writes. Never touches final records. */
  async sweepStaleTemps(maxAgeMs: number, now = Date.now()): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return 0;
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      const full = join(this.dir(), name);
      try {
        const info = await stat(full);
        if (now - info.mtimeMs >= maxAgeMs) {
          await unlink(full);
          removed += 1;
        }
      } catch {
        /* ignore */
      }
    }
    return removed;
  }
}

/** Selects the store: `file` (default) or the Zoho CRM Sandbox adapter (`crm`, explicitly enabled). */
export function createConsultStore(
  env: Record<string, string | undefined>,
  storageDir: string,
): ConsultStore {
  const kind = (env["SIX2FIT_CONSULT_STORE"] ?? "file").trim().toLowerCase();
  if (kind === "file") return new FileConsultStore(storageDir);
  if (kind === "crm") return createCrmConsultStore(env);
  throw new StoreError("NOT_CONFIGURED", "unknown store");
}
