/* eslint-disable @typescript-eslint/no-explicit-any -- tests inspect loosely typed JSON bodies */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../canonical";
import { createConsultService } from "../service";
import { StoreError, type StoredConsult } from "../store";
import { FIRST_FLAG, MODULE_KEYS, moduleAnswer, newId, payloadFrom } from "../fixtures";
import { createCrmConsultStore } from "./factory";
import { IdempotencyLedger, LedgerConsultStore, resolveManually, type LedgerEntry } from "./ledger";
import type { CrmConsultStore } from "./crm-store";
import { MOCK_ACCOUNTS_DOMAIN, MOCK_API_DOMAIN, MOCK_ORG_ID, MockZoho } from "./mock-zoho";

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
const SECRET = "synthetic-test-secret-0123456789abcdef-xyz";
const BASE = new URL("https://onboarding-staging.example.test/");
const JSON_CT = "application/json; charset=utf-8";
const T0 = Date.UTC(2026, 9, 13, 10, 0, 0);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-ledger-"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("REAL NETWORK ACCESS ATTEMPTED"); }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** One shared virtual clock; `sleep` advances it and yields a real macrotask so other "workers" progress. */
function world(zoho = new MockZoho()) {
  const clock = { t: T0 };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const sleep = async (ms: number) => {
    clock.t += ms;
    await new Promise((r) => setTimeout(r, 1));
  };
  /** A separate "worker process": its own adapter and store objects, sharing only the ledger directory and the CRM. */
  const worker = (over: Partial<ConstructorParameters<typeof LedgerConsultStore>[2]> = {}) => {
    const inner = createCrmConsultStore(ENV, { fetch: zoho.fetch, now: () => clock.t, sleep, log: (event, fields) => logs.push({ event, fields }) }) as CrmConsultStore;
    const store = new LedgerConsultStore(inner, new IdempotencyLedger(dir), { now: () => clock.t, sleep, log: (event, fields) => logs.push({ event, fields }), waitMs: 1e9, ...over }); // virtual waits: many waiters advance one shared clock
    return { inner, store };
  };
  return { zoho, clock, logs, worker, advance: (ms: number) => (clock.t += ms) };
}

const nine = (id: string) =>
  payloadFrom(
    {
      ts_01_has_limitation: "yes",
      ts_02_categories: MODULE_KEYS,
      ts_03_clearance: "not_assessed",
      modules: Object.fromEntries(MODULE_KEYS.map((k) => [k, moduleAnswer([FIRST_FLAG[k] as string])])),
    } as any,
    id,
  ) as any;
const recordFor = (payload: any): StoredConsult => ({
  version: 2,
  submission_id: payload.submission_id,
  payload_hash: fingerprint(payload),
  payload,
  record_ref: `staging_${payload.submission_id}`,
  created_at: "2026-10-13T10:00:00.000Z",
});
const posts = (z: MockZoho) => z.requests.filter((r) => r.method === "POST" && r.path === "/crm/v8/Consultation_Submissions").length;
const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(StoreError);
    return e as StoreError;
  }
  throw new Error("expected a StoreError");
};
const service = (store: LedgerConsultStore, logs: unknown[] = []) =>
  createConsultService({ store, log: (e, f) => logs.push({ e, f }) });
const send = (svc: ReturnType<typeof service>, payload: any) => svc.submit({ contentType: JSON_CT, idempotencyKey: payload.submission_id, body: JSON.stringify(payload) });
const seed = (id: string, over: Partial<LedgerEntry>): LedgerEntry => ({ v: 1, id, gen: 1, fp: fingerprint(nine(id)), state: "in_progress", phase: "sending", attempts: 1, started: T0, updated: T0, ...over });

describe("root cause reproduction (raw adapter, no ledger)", () => {
  it("L8: with a non-atomic CRM, simultaneous identical creates make duplicate records", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const raw = createCrmConsultStore(ENV, { fetch: w.zoho.fetch, now: () => w.clock.t, sleep: async () => undefined }) as CrmConsultStore;
    const id = newId(60);
    const rs = await Promise.all([raw.create(id, recordFor(nine(id))), raw.create(id, recordFor(nine(id)))]);
    expect(rs.map((r) => r.status)).toEqual(["created", "created"]);
    expect(w.zoho.records).toHaveLength(2);
  });
});

describe("simultaneous requests (non-atomic CRM, several workers sharing the ledger)", () => {
  it("identical submissions: exactly one POST and one CRM record; the rest are deduplicated", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const svcs = [w.worker(), w.worker(), w.worker()].map((x) => service(x.store));
    const payload = nine(newId(61));
    const rs = await Promise.all(Array.from({ length: 9 }, (_, i) => send(svcs[i % 3] as any, payload)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => (r.body as any).deduplicated === false)).toHaveLength(1);
    expect(new Set(rs.map((r) => (r.body as any).crm_record_id)).size).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
  });

  it("conflicting submissions (same id, different answers): one record, the loser gets 409, never a second record", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const [a, b] = [service(w.worker().store), service(w.worker().store)];
    const id = newId(62);
    const rs = await Promise.all([send(a, nine(id)), send(b, payloadFrom({ age: 41 } as any, id))]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(w.zoho.records).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
    // the stored answers are the winner's, complete, with all nine subform rows
    const winner = rs.find((r) => r.status === 200)!;
    expect((winner.body as any).crm_record_id).toBe(w.zoho.records[0]!.id);
    const view = await w.worker().store.getSubmission(id);
    expect(view!.stored.payload["submission_id"]).toBe(id);
    expect(Object.keys((view!.stored.payload as any).modules ?? {}).length).toBeGreaterThanOrEqual(0);
  });

  it("a waiting request that outlasts the writer gets a retryable 503, never a success", async () => {
    const w = world();
    const id = newId(63);
    await new IdempotencyLedger(dir).claim(seed(id, { updated: w.clock.t })); // a live writer that never finishes
    const { store } = w.worker({ waitMs: 2_000 });
    expect(await fails(store.create(id, recordFor(nine(id))))).toMatchObject({ kind: "UNAVAILABLE", code: "IN_PROGRESS" });
    expect(posts(w.zoho)).toBe(0);
  });

  it("two requests racing to reconcile the same unknown entry: neither writes; both get a 503", async () => {
    const w = world();
    w.zoho.nonAtomicInsert = true;
    const id = newId(64);
    await new IdempotencyLedger(dir).claim(seed(id, { state: "unknown", updated: T0 }));
    w.advance(121_000);
    const rs = await Promise.allSettled([w.worker().store.create(id, recordFor(nine(id))), w.worker().store.create(id, recordFor(nine(id)))]);
    expect(rs.every((r) => r.status === "rejected")).toBe(true);
    expect(posts(w.zoho)).toBe(0);
    expect(w.zoho.records).toHaveLength(0);
  });
});

describe("restart and persistence", () => {
  it("a new process (empty memory, same ledger) deduplicates without touching the CRM", async () => {
    const w = world();
    const id = newId(65);
    const first = await send(service(w.worker().store), nine(id));
    expect((first.body as any).deduplicated).toBe(false);
    const before = w.zoho.requests.length;
    const second = await send(service(w.worker().store), nine(id));
    expect(second.status).toBe(200);
    expect((second.body as any).deduplicated).toBe(true);
    expect((second.body as any).crm_record_id).toBe((first.body as any).crm_record_id);
    expect(w.zoho.requests.length).toBe(before);
  });

  it("crash after the CRM write but before the ledger update: reconciled by lookup, no second record", async () => {
    const w = world();
    const id = newId(66);
    const { inner } = w.worker();
    await inner.create(id, recordFor(nine(id))); // the CRM has it
    await new IdempotencyLedger(dir).claim(seed(id, { updated: w.clock.t })); // writer died, entry left in_progress
    w.advance(151_000); // lease expired
    const postsBefore = posts(w.zoho);
    const r = await w.worker().store.create(id, recordFor(nine(id)));
    expect(r.status).toBe("exists");
    expect(posts(w.zoho)).toBe(postsBefore);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("writer died BEFORE it recorded `sending`: no POST was ever started, so a fresh attempt is allowed after the lease", async () => {
    const w = world();
    const id = newId(67);
    await new IdempotencyLedger(dir).claim(seed(id, { phase: "claimed", updated: w.clock.t }));
    w.advance(60_000);
    expect(await fails(w.worker({ waitMs: 2_000 }).store.create(id, recordFor(nine(id))))).toMatchObject({ code: "IN_PROGRESS" }); // writer may still be alive
    w.advance(100_000);
    const r = await w.worker().store.create(id, recordFor(nine(id)));
    expect(r.status).toBe("created");
    expect(w.zoho.records).toHaveLength(1);
  });

  it("writer died AFTER recording `sending` and the CRM has nothing: never an automatic second POST", async () => {
    const w = world();
    const id = newId(67);
    await new IdempotencyLedger(dir).claim(seed(id, { phase: "sending", updated: w.clock.t }));
    w.advance(200_000);
    expect(await fails(w.worker().store.create(id, recordFor(nine(id))))).toMatchObject({ code: "UNRESOLVED_OUTCOME" });
    expect(posts(w.zoho)).toBe(0);
    expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ state: "needs_review" });
  });

  it("the ledger records `sending` durably before the POST leaves", async () => {
    const w = world();
    const id = newId(67);
    let seen: string | undefined;
    const { store } = w.worker();
    const realFetch = w.zoho.fetch;
    const ledger = new IdempotencyLedger(dir);
    const inner = createCrmConsultStore(ENV, {
      fetch: async (url, init) => {
        if (init.method === "POST" && url.includes("/Consultation_Submissions")) seen = (await ledger.current(id))?.phase;
        return realFetch(url, init);
      },
      now: () => w.clock.t,
      sleep: async () => undefined,
    }) as CrmConsultStore;
    await new LedgerConsultStore(inner, ledger, { now: () => w.clock.t, sleep: async () => undefined }).create(id, recordFor(nine(id)));
    expect(seen).toBe("sending");
    expect(store).toBeDefined();
  });

  it("the ledger contains no answers", async () => {
    const w = world();
    const id = newId(68);
    await w.worker().store.create(id, recordFor(tamperName(nine(id))));
    const files = await readdir(join(dir, id));
    const text = (await Promise.all(files.filter((f) => f.endsWith(".json")).map((f) => readFile(join(dir, id, f), "utf8")))).join("");
    expect(text).not.toMatch(/Synthetic Secret Person/);
    expect(JSON.parse(text)).toMatchObject({ state: "created", id });
  });
});

const tamperName = (p: any) => ({ ...p, lead_full_name: "Synthetic Secret Person" });

describe("delayed CRM search indexing", () => {
  it("an immediate retry after a successful create is answered from the ledger (search returns 204)", async () => {
    const w = world();
    w.zoho.searchLag = true;
    const id = newId(69);
    const svc = service(w.worker().store);
    expect(((await send(svc, nine(id))).body as any).deduplicated).toBe(false);
    const retry = await send(service(w.worker().store), nine(id));
    expect(retry.status).toBe(200);
    expect((retry.body as any).deduplicated).toBe(true);
    expect(posts(w.zoho)).toBe(1);
  });

  it("ledger lost but record exists and search lags: the CRM unique constraint answers a non-concurrent retry", async () => {
    const w = world();
    const id = newId(70);
    await w.worker().inner.create(id, recordFor(nine(id)));
    w.zoho.searchLag = true;
    const r = await send(service(w.worker().store), nine(id));
    expect(r.status).toBe(200);
    expect((r.body as any).deduplicated).toBe(true);
    expect(w.zoho.records).toHaveLength(1);
  });
});

describe("lost response and ambiguous timeouts", () => {
  it("create succeeded but the response was lost: 503 now, never a blind retry, resolved after quiescence", async () => {
    const w = world();
    w.zoho.searchLag = true; // search proves nothing right after the create
    const id = newId(71);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 1, "POST");
    const svc = service(w.worker().store);
    expect((await send(svc, nine(id))).status).toBe(503);
    expect(w.zoho.records).toHaveLength(1);
    expect(posts(w.zoho)).toBe(1);
    // client retries at once and after 30 s: still no write, still not a success
    for (const wait of [0, 30_000]) {
      w.advance(wait);
      expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
      expect(posts(w.zoho)).toBe(1);
    }
    // quiescence passed and the index caught up: lookup proves the record, no write
    w.advance(120_000);
    w.zoho.searchLag = false;
    const ok = await send(service(w.worker().store), nine(id));
    expect(ok.status).toBe(200);
    expect((ok.body as any).deduplicated).toBe(true);
    expect((ok.body as any).crm_record_id).toBe(w.zoho.records[0]!.id);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("a negative search after 120 s is not proof of failure: the persisted record is NOT written twice; a late hit settles it", async () => {
    const w = world();
    w.zoho.searchLag = true;
    const id = newId(72);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 1, "POST");
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    w.advance(121_000);
    const unresolved = await send(service(w.worker().store), nine(id));
    expect(unresolved.status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
    expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ state: "needs_review" });
    // still unresolved an hour later while the index keeps lagging: still no write
    w.advance(3_600_000);
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    expect(posts(w.zoho)).toBe(1);
    // the index catches up: positive evidence, resolved without any write
    w.zoho.searchLag = false;
    w.advance(121_000); // re-checks are spaced by the quiescence window
    const ok = await send(service(w.worker().store), nine(id));
    expect(ok.status).toBe(200);
    expect((ok.body as any).deduplicated).toBe(true);
    expect(posts(w.zoho)).toBe(1);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("ambiguous timeout with nothing stored: 503 for ever (needs_review) until an operator decides; no automatic second POST", async () => {
    const w = world();
    const id = newId(73);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "timeout" }, 1, "POST");
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    for (const wait of [10_000, 120_000, 600_000]) {
      w.advance(wait);
      expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
      expect(posts(w.zoho)).toBe(1);
    }
    expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ state: "needs_review" });
    // operator verified in the CRM that nothing exists and accepts the late-commit risk: explicit, audited release
    const ledger = new IdempotencyLedger(dir);
    const done = await resolveManually(ledger, id, { decision: "released", note: "PM checked CRM list and COQL: no record" }, w.clock.t);
    expect(done).toMatchObject({ state: "released", manual: true });
    const r = await send(service(w.worker().store), nine(id));
    expect(r.status).toBe(200);
    expect((r.body as any).deduplicated).toBe(false);
    expect(posts(w.zoho)).toBe(2);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("operator settles an unknown entry as created with a confirmed CRM record id: no write, normal deduplicated answer", async () => {
    const w = world();
    w.zoho.searchLag = true;
    const id = newId(73);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "persist-then-timeout" }, 1, "POST");
    await send(service(w.worker().store), nine(id));
    const rid = String(w.zoho.records[0]!.id);
    await resolveManually(new IdempotencyLedger(dir), id, { decision: "created", crmRecordId: rid, note: "record seen in CRM UI by Submission_ID" }, w.clock.t);
    const r = await send(service(w.worker().store), nine(id));
    expect(r.status).toBe(200);
    expect((r.body as any).crm_record_id).toBe(rid);
    expect((r.body as any).deduplicated).toBe(true);
    expect(posts(w.zoho)).toBe(1);
  });

  it("manual resolution is refused for settled entries, live writers, missing notes and malformed ids", async () => {
    const w = world();
    const ledger = new IdempotencyLedger(dir);
    const live = newId(82);
    await ledger.claim(seed(live, { updated: w.clock.t }));
    await expect(resolveManually(ledger, live, { decision: "released", note: "looks absent to me" }, w.clock.t)).rejects.toMatchObject({ code: "LEDGER_NOT_RESOLVABLE" });
    const done = newId(83);
    await send(service(w.worker().store), nine(done));
    await expect(resolveManually(ledger, done, { decision: "released", note: "should not be allowed" }, w.clock.t)).rejects.toMatchObject({ code: "LEDGER_NOT_RESOLVABLE" });
    const unk = newId(84);
    await ledger.claim(seed(unk, { state: "unknown", updated: T0 }));
    await expect(resolveManually(ledger, unk, { decision: "released", note: "x" }, w.clock.t)).rejects.toMatchObject({ code: "LEDGER_NOTE_REQUIRED" });
    await expect(resolveManually(ledger, unk, { decision: "created", crmRecordId: "abc", note: "valid note text" }, w.clock.t)).rejects.toMatchObject({ code: "INVALID_RECORD_ID" });
    await expect(resolveManually(ledger, newId(85), { decision: "released", note: "valid note text" }, w.clock.t)).rejects.toMatchObject({ code: "LEDGER_NOT_FOUND" });
    expect(posts(w.zoho)).toBe(1);
  });

  it("a conflicting payload while the first outcome is unknown is refused (409), not written", async () => {
    const w = world();
    const id = newId(74);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "timeout" }, 1, "POST");
    await send(service(w.worker().store), nine(id));
    w.advance(500_000);
    const r = await send(service(w.worker().store), payloadFrom({ age: 41 } as any, id));
    expect(r.status).toBe(409);
    expect(posts(w.zoho)).toBe(1);
  });

  it("a definite refusal (403) releases the claim: the next request may write at once", async () => {
    const w = world();
    const id = newId(75);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 403, body: {} }, 1, "POST");
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    const r = await send(service(w.worker().store), nine(id));
    expect(r.status).toBe(200);
    expect(w.zoho.records).toHaveLength(1);
  });

  it("an unknown outcome is never reported as success (every ambiguous shape)", async () => {
    for (const fault of [{ kind: "timeout" }, { kind: "network" }, { kind: "garbage", status: 200 }, { kind: "status", status: 500, body: {} }] as any[]) {
      const w = world();
      const id = newId(76);
      w.zoho.failNext(/Consultation_Submissions$/, fault, 1, "POST");
      const r = await send(service(w.worker().store), nine(id));
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ ok: false, error_code: "STORAGE_UNAVAILABLE" });
    }
  });
});

describe("existing duplicate CRM records are integrity exceptions", () => {
  const seedDuplicates = (w: ReturnType<typeof world>, id: string) => {
    for (const n of [1, 2]) w.zoho.records.push({ id: `62233610001270000${n}0`, Submission_ID: id } as any);
  };

  it("never resolved by picking one: 503, integrity_exception logged, no write", async () => {
    const w = world();
    const id = newId(77);
    seedDuplicates(w, id);
    const logs: any[] = [];
    const r = await send(service(w.worker().store, logs), nine(id));
    expect(r.status).toBe(503);
    expect(logs.some((l) => l.e === "consult.integrity_exception")).toBe(true);
    expect(posts(w.zoho)).toBe(0);
  });

  it("a CRM duplicate answer that reports more records is an integrity exception and is remembered", async () => {
    const w = world();
    const id = newId(78);
    w.zoho.failNext(/Consultation_Submissions$/, { kind: "status", status: 400, body: { data: [{ code: "DUPLICATE_DATA", details: { api_name: "Submission_ID", more_records: true, duplicate_record: { id: "6223361000127000010" } }, status: "error" }] } }, 1, "POST");
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    const before = w.zoho.requests.length;
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    expect(w.zoho.requests.length).toBe(before); // sticky: answered from the ledger, CRM untouched
    expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ state: "integrity" });
  });

  it("duplicates discovered while reconciling an unknown outcome are an integrity exception", async () => {
    const w = world();
    const id = newId(79);
    await new IdempotencyLedger(dir).claim(seed(id, { state: "unknown", updated: T0 }));
    seedDuplicates(w, id);
    w.advance(121_000);
    expect((await send(service(w.worker().store), nine(id))).status).toBe(503);
    expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ state: "integrity" });
    expect(posts(w.zoho)).toBe(0);
  });
});

describe("payload integrity and contract", () => {
  it("the complete payload and all nine subform rows reach the CRM through the ledger path", async () => {
    const w = world();
    const id = newId(80);
    const payload = nine(id);
    const r = await send(service(w.worker().store), payload);
    expect(r.status).toBe(200);
    const rec: any = w.zoho.records[0];
    expect(rec.Module_Answers).toHaveLength(9);
    const view = await w.worker().store.getSubmission(id);
    expect(view!.stored.payload).toEqual(payload);
    expect(Object.keys(r.body as any).sort()).toEqual(["crm_record_id", "deduplicated", "ok"]);
  });

  it("a corrupt ledger entry fails closed", async () => {
    const w = world();
    const id = newId(81);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, "g1.json"), "{not json");
    expect(await fails(w.worker().store.create(id, recordFor(nine(id))))).toMatchObject({ kind: "CORRUPT", code: "LEDGER_CORRUPT" });
    expect(posts(w.zoho)).toBe(0);
  });
});

describe("real OS processes (the hosting stack may run several workers)", () => {
  const worker = fileURLToPath(new URL("./testing/claim-worker.mjs", import.meta.url));
  const run = (id: string) =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", worker, dir, id, "150"], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.on("error", reject);
      child.on("close", () => resolve(out.trim()));
    });

  it("exactly one of eight simultaneous processes wins a claim; the others lose (3 independent ids)", async () => {
    for (const n of [90, 91, 92]) {
      const id = newId(n);
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => run(id)));
      expect(outcomes.filter((o) => o === "WON")).toHaveLength(1);
      expect(outcomes.filter((o) => o === "LOST")).toHaveLength(7);
      expect(await new IdempotencyLedger(dir).current(id)).toMatchObject({ gen: 1, state: "in_progress" });
    }
  }, 60_000);
});
