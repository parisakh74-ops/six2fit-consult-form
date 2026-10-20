/* eslint-disable @typescript-eslint/no-explicit-any -- test helpers inspect loosely typed JSON bodies */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fingerprint, legacyPayloadHash } from "./canonical";
import { createConsultService, recordRef } from "./service";
import { FileConsultStore, StoreError } from "./store";
import { MemoryStore, SUBMISSION_ID, moduleAnswer, newId, payloadFrom, tamper } from "./fixtures";

const SECRET = "synthetic-test-secret-0123456789abcdef-xyz";
const BASE = new URL("https://onboarding-staging.example.test/");
const JSON_CT = "application/json; charset=utf-8";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "consult-svc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(opts: { store?: any; now?: () => number; logs?: any[]; max?: number } = {}) {
  const store = opts.store ?? new FileConsultStore(dir);
  const logs = opts.logs ?? [];
  const service = createConsultService({
    store,
    
    
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.max ? { maxBodyBytes: opts.max } : {}),
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  return { store, service, logs };
}
const send = (service: ReturnType<typeof make>["service"], payload: unknown, over: { key?: string | null; ct?: string | null; raw?: string } = {}) =>
  service.submit({
    contentType: over.ct === undefined ? JSON_CT : over.ct,
    idempotencyKey: over.key === undefined ? ((payload as { submission_id?: string }).submission_id ?? null) : over.key,
    body: over.raw ?? JSON.stringify(payload),
  });
const session = (url: string) => new URL(url).searchParams.get("session") as string;

describe("success contract", () => {
  it("returns { ok, crm_record_id, deduplicated } (no Onboarding URL) and stores the payload losslessly", async () => {
    const { service, store } = make();
    const payload = payloadFrom();
    const r = await send(service, payload);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, crm_record_id: recordRef(SUBMISSION_ID), deduplicated: false });
    expect(Object.keys(r.body).sort()).toEqual(["crm_record_id", "deduplicated", "ok"]);
    const stored = await (store as FileConsultStore).get(SUBMISSION_ID);
    expect(stored?.payload).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(stored?.version).toBe(2);
  });

  it("stores complete module answers (nothing dropped)", async () => {
    const { service, store } = make();
    const payload = payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["surgery", "oncology"], ts_03_clearance: "no", modules: { surgery: moduleAnswer(["bleeding"]), oncology: moduleAnswer() } });
    expect((await send(service, payload)).status).toBe(200);
    expect((await store.get(SUBMISSION_ID))?.payload["modules"]).toEqual(JSON.parse(JSON.stringify(payload.modules)));
  });
});

describe("idempotency", () => {
  it("identical retry (new submitted_at) is deduplicated and still carries no Onboarding access", async () => {
    let t = Date.UTC(2026, 9, 12, 10, 0, 0);
    const { service } = make({ now: () => t });
    const payload = payloadFrom();
    const first = await send(service, payload);
    expect((first.body as any).onboarding_url).toBeUndefined();
    t += 25 * 3600 * 1000;
    const retry = await send(service, { ...payload, submitted_at: new Date(t).toISOString() });
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ deduplicated: true, crm_record_id: recordRef(SUBMISSION_ID) });
    expect(Object.keys(retry.body).sort()).toEqual(["crm_record_id", "deduplicated", "ok"]);
  });

  it("same id with a different payload -> 409 SUBMISSION_CONFLICT", async () => {
    const { service } = make();
    await send(service, payloadFrom());
    const r = await send(service, payloadFrom({ weight_kg: 71 }));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error_code: "SUBMISSION_CONFLICT" });
  });

  it("a legitimate resubmission (new id, changed answers) creates a second record", async () => {
    const { service, store } = make({ store: new MemoryStore() });
    expect((await send(service, payloadFrom({}, newId(1)))).body).toMatchObject({ deduplicated: false });
    expect((await send(service, payloadFrom({ weight_kg: 72 }, newId(2)))).body).toMatchObject({ deduplicated: false });
    expect((store as MemoryStore).records.size).toBe(2);
  });

  it("five simultaneous identical requests: one record, no 409, no stuck state", async () => {
    const { service, store } = make();
    const payload = payloadFrom();
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send(service, payload)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(results.filter((r) => (r.body as any).deduplicated === false)).toHaveLength(1);
    expect(readdirSync(join(dir, "consult")).filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(await store.get(SUBMISSION_ID)).not.toBeNull();
  });

  it("concurrent conflicting requests (same id, different answers): exactly one wins, the rest get 409", async () => {
    const { service } = make();
    const results = await Promise.all([60, 61, 62, 63, 64].map((w) => send(service, payloadFrom({ weight_kg: w }))));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it("restart: a new service/store instance deduplicates against persisted data", async () => {
    await send(make().service, payloadFrom());
    const after = await send(make().service, payloadFrom());
    expect(after.body).toMatchObject({ ok: true, deduplicated: true });
  });
});

describe("failure and recovery", () => {
  it("storage write failure -> 503 STORAGE_UNAVAILABLE, then the retry succeeds (no stuck state)", async () => {
    const mem = new MemoryStore();
    const { service } = make({ store: mem });
    mem.failNext = "create";
    const failed = await send(service, payloadFrom());
    expect(failed.status).toBe(503);
    expect(failed.body).toMatchObject({ ok: false, error_code: "STORAGE_UNAVAILABLE" });
    const retry = await send(service, payloadFrom());
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ deduplicated: false });
  });

  it("read failure -> 503 and no write attempted", async () => {
    const mem = new MemoryStore();
    mem.failNext = "get";
    const { service } = make({ store: mem });
    expect((await send(service, payloadFrom())).status).toBe(503);
    expect(mem.creates).toBe(0);
  });

  it("interrupted persistence (temp file left behind) does not block a retry", async () => {
    mkdirSync(join(dir, "consult"), { recursive: true });
    writeFileSync(join(dir, "consult", `${SUBMISSION_ID}.json.999.deadbeef.tmp`), '{"partial":');
    const { service } = make();
    expect((await send(service, payloadFrom())).body).toMatchObject({ ok: true, deduplicated: false });
  });

  it("a legacy claim file without a record no longer causes a permanent in-progress state", async () => {
    mkdirSync(join(dir, "claims"), { recursive: true });
    writeFileSync(join(dir, "claims", `consult-${SUBMISSION_ID}`), "{}");
    const { service } = make();
    expect((await send(service, payloadFrom())).status).toBe(200);
  });

  it("a corrupt stored record -> 503 and the record is not overwritten", async () => {
    mkdirSync(join(dir, "consult"), { recursive: true });
    const file = join(dir, "consult", `${SUBMISSION_ID}.json`);
    writeFileSync(file, "{not json");
    const { service } = make();
    expect((await send(service, payloadFrom())).status).toBe(503);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("legacy records (v1 hash, stored onboarding_url) still deduplicate identical retries", async () => {
    const payload = JSON.parse(JSON.stringify(payloadFrom()));
    mkdirSync(join(dir, "consult"), { recursive: true });
    writeFileSync(
      join(dir, "consult", `${SUBMISSION_ID}.json`),
      JSON.stringify({ payload_hash: legacyPayloadHash(payload), payload, crm_record_id: `staging_${SUBMISSION_ID}`, onboarding_url: "https://old.example/?session=stale", created_at: "2026-10-01T00:00:00.000Z" }),
    );
    const { service } = make();
    const r = await send(service, payload);
    expect(r.body).toMatchObject({ ok: true, deduplicated: true, crm_record_id: `staging_${SUBMISSION_ID}` });
    expect(JSON.stringify(r.body)).not.toMatch(/stale|onboarding/i); // a stored legacy URL is never replayed
  });

  it("an unsupported store selection is reported without details", async () => {
    expect(() => {
      throw new StoreError("NOT_CONFIGURED", "x");
    }).toThrow();
  });
});

describe("request validation and error contract", () => {
  const { service } = make({ store: new MemoryStore() });
  const SECRETISH = "SECRET-DIAGNOSIS-TEXT-987";

  it("invalid JSON -> 400 INVALID_JSON (not 503)", async () => {
    const r = await send(service, null, { key: SUBMISSION_ID, raw: "{not-json" });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ ok: false, error_code: "INVALID_JSON" });
  });
  it("non-object JSON -> 400 INVALID_PAYLOAD", async () => {
    expect((await send(service, null, { key: SUBMISSION_ID, raw: "[1,2]" })).body).toMatchObject({ error_code: "INVALID_PAYLOAD" });
  });
  it("wrong content type -> 415", async () => {
    expect((await send(service, payloadFrom(), { ct: "text/plain" })).status).toBe(415);
    expect((await send(service, payloadFrom(), { ct: null })).status).toBe(415);
  });
  it("oversized body -> 413", async () => {
    const small = make({ store: new MemoryStore(), max: 200 });
    expect((await send(small.service, payloadFrom())).status).toBe(413);
  });
  it("missing / malformed / mismatching Idempotency-Key -> 400", async () => {
    expect((await send(service, payloadFrom(), { key: null })).body).toMatchObject({ error_code: "INVALID_IDEMPOTENCY_KEY" });
    expect((await send(service, payloadFrom(), { key: "x" })).status).toBe(400);
    expect((await send(service, payloadFrom(), { key: newId(9) })).body).toMatchObject({ error_code: "INVALID_IDEMPOTENCY_KEY" });
  });
  it("unsupported form version -> 400 UNSUPPORTED_FORM_VERSION", async () => {
    const r = await send(service, tamper(payloadFrom(), (p) => (p.form_version = "consult-2.0.0")));
    expect(r.body).toMatchObject({ error_code: "UNSUPPORTED_FORM_VERSION" });
  });
  it("missing required field and unexpected field -> 400 with issue paths only", async () => {
    const missing = await send(service, tamper(payloadFrom(), (p) => delete p.age));
    expect(missing.body).toMatchObject({ error_code: "INVALID_PAYLOAD", issues: [{ path: "age", code: "REQUIRED" }] });
    const extra = await send(service, tamper(payloadFrom(), (p) => (p.rogue = SECRETISH)));
    expect(extra.status).toBe(400);
    expect(JSON.stringify(extra.body)).not.toContain(SECRETISH);
  });
  it("invalid conditional answer -> 400; outcome mismatch -> 422", async () => {
    expect((await send(service, tamper(payloadFrom({ health_flags: ["severe_food_allergy"], blocker_details: "synthetic" }), (p) => (p.blocker_details = null)))).status).toBe(400);
    const r = await send(service, tamper(payloadFrom({ health_flags: ["liver_cirrhosis_failure"], blocker_details: "synthetic" }), (p) => (p.safety_outcome = "GREEN")));
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error_code: "OUTCOME_MISMATCH" });
  });
  it("error bodies never echo answers, ids or filesystem paths", async () => {
    const payload = tamper(payloadFrom({ ts_01_has_limitation: "yes", ts_02_categories: ["other"], ts_03_clearance: "no", modules: { other: moduleAnswer() } }), (p) => (p.modules.other.diagnosis = SECRETISH.repeat(20)));
    const r = await send(service, payload);
    const text = JSON.stringify(r);
    expect(text).not.toContain("SECRET-DIAGNOSIS");
    expect(text).not.toContain(SUBMISSION_ID);
    expect(text).not.toMatch(/[A-Za-z]:\\|\/home\//);
  });
});

describe("logging", () => {
  it("logs codes and timings only (no ids, answers, tokens)", async () => {
    const logs: any[] = [];
    const { service } = make({ store: new MemoryStore(), logs });
    await send(service, payloadFrom());
    await send(service, payloadFrom());
    await send(service, null, { key: SUBMISSION_ID, raw: "{" });
    const text = JSON.stringify(logs);
    expect(logs.map((l) => l.event)).toEqual(["consult.created", "consult.deduplicated", "consult.rejected.invalid_json"]);
    for (const secret of [SUBMISSION_ID, "Synthetic Tester", "synthetic@example.test", "4165550100", SECRET, "session="]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("fingerprint", () => {
  it("ignores key order and the volatile client timestamp, but not answers", () => {
    const a = JSON.parse(JSON.stringify(payloadFrom()));
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(fingerprint(reordered)).toBe(fingerprint(a));
    expect(fingerprint({ ...a, submitted_at: "2030-01-01T00:00:00.000Z" })).toBe(fingerprint(a));
    expect(fingerprint({ ...a, age: 31 })).not.toBe(fingerprint(a));
  });
});

describe("O1: Consultation issues no Onboarding access", () => {
  it("the service needs no signing secret and no Onboarding URL, and no response ever carries one", async () => {
    const { service } = make({ store: new MemoryStore() });
    for (const [i, services] of [["nutrition"], ["training"], ["nutrition", "training"], ["not_sure"]].entries()) {
      const r = await send(service, payloadFrom({ service_interest: services as never }, newId(i + 10)));
      expect(r.status).toBe(200);
      expect(JSON.stringify(r.body)).not.toMatch(/onboarding|session|token|https?:/i);
    }
  });
  it("service.ts and the staging configuration contain no hand-off signing", () => {
    const src = readFileSync(join(__dirname, "service.ts"), "utf8") + readFileSync(join(__dirname, "..", "staging-handoff.ts"), "utf8");
    expect(src).not.toMatch(/signHandoff|verifyHandoff|createHmac|tokenSecret|onboardingBaseUrl|ONBOARDING_STAGING_BASE_URL|SIX2FIT_STAGING_TOKEN_SECRET/);
  });
  it("the Consultation page has no Onboarding link or button", () => {
    const ui = readFileSync(join(__dirname, "..", "..", "features", "consult", "ConsultForm.tsx"), "utf8");
    expect(ui).not.toMatch(/onboarding_url|onboardingUrl|setOnboardingUrl/);
  });
});
