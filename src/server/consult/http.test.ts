import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConsultService } from "./service";
import { dispatchConsultRequest, handleConsultSubmission, matchConsultRoute, readLimitedText } from "./http";
import { FileConsultStore, StoreError, createConsultStore } from "./store";
import { MemoryStore, SUBMISSION_ID, newId, payloadFrom } from "./fixtures";

const HOST = "https://consult-staging.example.test";
const SECRET = "synthetic-test-secret-0123456789abcdef-xyz";

function runtime(store = new MemoryStore(), maxBodyBytes = 128 * 1024) {
  const service = createConsultService({ store, maxBodyBytes });
  const spy = vi.spyOn(service, "submit");
  return { runtime: () => ({ service, maxBodyBytes }), spy, store };
}
const post = (url: string, payload: unknown, headers: Record<string, string> = {}) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": (payload as { submission_id: string }).submission_id, ...headers },
    body: JSON.stringify(payload),
  });

describe("route matching", () => {
  it.each([
    ["POST", `${HOST}/api/consult/submit`, "submit"],
    ["POST", `${HOST}/?six2fit_api=consult`, "submit"],
    ["GET", `${HOST}/api/consult/submit`, "method_not_allowed"],
    ["PUT", `${HOST}/api/consult/submit`, "method_not_allowed"],
    ["DELETE", `${HOST}/api/consult/submit`, "method_not_allowed"],
    ["GET", `${HOST}/?six2fit_api=consult`, null],
    ["GET", `${HOST}/`, null],
    ["POST", `${HOST}/api/other`, null],
    ["POST", `${HOST}/?six2fit_api=other`, null],
  ])("%s %s -> %s", (method, url, expected) => {
    expect(matchConsultRoute(new Request(url, { method }))).toBe(expected);
  });
});

describe("dispatch", () => {
  it("returns null for requests that are not for the consult API", async () => {
    expect(await dispatchConsultRequest(new Request(`${HOST}/`))).toBeNull();
  });

  it("unsupported method -> 405 with Allow: POST (not served by the app)", async () => {
    const res = (await dispatchConsultRequest(new Request(`${HOST}/api/consult/submit`, { method: "GET" })))!;
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(await res.json()).toMatchObject({ ok: false, error_code: "METHOD_NOT_ALLOWED" });
  });

  it("valid submission, then deduplicated retry, with the success contract", async () => {
    const { runtime: rt } = runtime();
    const payload = payloadFrom();
    const first = (await dispatchConsultRequest(post(`${HOST}/api/consult/submit`, payload), { runtime: rt }))!;
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, deduplicated: false, crm_record_id: `staging_${SUBMISSION_ID}` });
    const retry = (await dispatchConsultRequest(post(`${HOST}/?six2fit_api=consult`, payload), { runtime: rt }))!;
    expect(await retry.json()).toMatchObject({ ok: true, deduplicated: true });
  });

  it("the same Request object is executed once even if two entry points dispatch it", async () => {
    const { runtime: rt, spy, store } = runtime();
    const request = post(`${HOST}/api/consult/submit`, payloadFrom());
    const [a, b] = await Promise.all([dispatchConsultRequest(request, { runtime: rt }), dispatchConsultRequest(request, { runtime: rt })]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.creates).toBe(1);
    expect(a!.status).toBe(200);
    expect(b!.status).toBe(200);
  });

  it("staging-only guard (explicitly not authentication) and missing configuration", async () => {
    const { runtime: rt } = runtime();
    expect((await dispatchConsultRequest(post("https://evil.example/api/consult/submit", payloadFrom()), { runtime: rt }))!.status).toBe(403);
    const broken = (await dispatchConsultRequest(post(`${HOST}/api/consult/submit`, payloadFrom()), {
      runtime: () => {
        throw new Error("/secret/path missing");
      },
    }))!;
    expect(broken.status).toBe(503);
    const text = await broken.text();
    expect(text).toContain("STAGING_UNAVAILABLE");
    expect(text).not.toContain("secret/path");
  });

  it("invalid JSON -> 400, unsupported media type -> 415, oversized -> 413", async () => {
    const { runtime: rt } = runtime(new MemoryStore(), 500);
    const bad = new Request(`${HOST}/api/consult/submit`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": SUBMISSION_ID }, body: "{oops" });
    expect((await dispatchConsultRequest(bad, { runtime: rt }))!.status).toBe(400);
    const text = new Request(`${HOST}/api/consult/submit`, { method: "POST", headers: { "content-type": "text/plain", "idempotency-key": SUBMISSION_ID }, body: "{}" });
    expect((await dispatchConsultRequest(text, { runtime: rt }))!.status).toBe(415);
    expect((await dispatchConsultRequest(post(`${HOST}/api/consult/submit`, payloadFrom()), { runtime: rt }))!.status).toBe(413);
  });

  it("legacy export keeps working", async () => {
    const res = await handleConsultSubmission(new Request(`${HOST}/api/consult/submit`, { method: "GET" }));
    expect(res.status).toBe(405);
  });
});

describe("bounded body reader", () => {
  const streamOf = (chunks: string[]) =>
    new Request(`${HOST}/x`, {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
          controller.close();
        },
      }),
    } as RequestInit);
  it("reads within the limit and stops early above it (also without Content-Length)", async () => {
    expect(await readLimitedText(streamOf(["ab", "cd"]), 10)).toBe("abcd");
    expect(await readLimitedText(streamOf(["abcde", "fghij", "k"]), 10)).toBe("TOO_LARGE");
  });
  it("honours a declared Content-Length above the limit", async () => {
    const r = new Request(`${HOST}/x`, { method: "POST", headers: { "content-length": "999999" }, body: "x" });
    expect(await readLimitedText(r, 100)).toBe("TOO_LARGE");
  });
});

describe("FileConsultStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "consult-store-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const rec = (n: number) => ({ version: 2 as const, payload_hash: `h${n}`, payload: { n }, created_at: "2026-10-12T00:00:00.000Z" });

  it("create-only: 30 parallel creates for one id yield exactly one `created`", async () => {
    const store = new FileConsultStore(dir);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => store.create(SUBMISSION_ID, rec(i))));
    expect(results.filter((r) => r.status === "created")).toHaveLength(1);
    const winner = results.find((r) => r.status === "created")!.record;
    for (const r of results) expect(r.record.payload_hash).toBe(winner.payload_hash);
    expect(readdirSync(join(dir, "consult")).filter((n) => !n.endsWith(".json"))).toEqual([]); // temp files cleaned up
  });

  it("never overwrites an existing record", async () => {
    const store = new FileConsultStore(dir);
    await store.create(SUBMISSION_ID, rec(1));
    const again = await store.create(SUBMISSION_ID, rec(2));
    expect(again.status).toBe("exists");
    expect((await store.get(SUBMISSION_ID))?.payload_hash).toBe("h1");
  });

  it("rejects unsafe ids (no path traversal) and reports unreadable records as CORRUPT", async () => {
    const store = new FileConsultStore(dir);
    await expect(store.get("../../etc/passwd")).rejects.toBeInstanceOf(StoreError);
    mkdirSync(join(dir, "consult"), { recursive: true });
    writeFileSync(join(dir, "consult", `${newId(5)}.json`), "garbage");
    await expect(store.get(newId(5))).rejects.toMatchObject({ kind: "CORRUPT" });
  });

  it("sweepStaleTemps removes only old temp files", async () => {
    const store = new FileConsultStore(dir);
    await store.create(SUBMISSION_ID, rec(1));
    const oldTmp = join(dir, "consult", "x.json.1.aa.tmp");
    const freshTmp = join(dir, "consult", "y.json.1.bb.tmp");
    writeFileSync(oldTmp, "1");
    writeFileSync(freshTmp, "1");
    const past = new Date(Date.now() - 3 * 3600 * 1000);
    utimesSync(oldTmp, past, past);
    expect(await store.sweepStaleTemps(3600 * 1000)).toBe(1);
    expect(readdirSync(join(dir, "consult")).sort()).toEqual(["y.json.1.bb.tmp", `${SUBMISSION_ID}.json`].sort());
  });

  it("store selection by server configuration: file by default, crm not implemented yet", () => {
    expect(createConsultStore({}, dir)).toBeInstanceOf(FileConsultStore);
    expect(createConsultStore({ SIX2FIT_CONSULT_STORE: "file" }, dir)).toBeInstanceOf(FileConsultStore);
    expect(() => createConsultStore({ SIX2FIT_CONSULT_STORE: "crm" }, dir)).toThrow(StoreError);
    expect(() => createConsultStore({ SIX2FIT_CONSULT_STORE: "other" }, dir)).toThrow(StoreError);
  });
});
