import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORM_SUBMITTED_FIELD_ID,
  createManychatMarker,
  manychatConfigFromEnv,
  parseSubscriberId,
  type ManychatMarkerConfig,
} from "./marker";

const cfg = (over: Partial<ManychatMarkerConfig> = {}): ManychatMarkerConfig => ({
  enabled: true,
  token: "synthetic-token-not-real",
  fieldId: DEFAULT_FORM_SUBMITTED_FIELD_ID,
  maxAttempts: 3,
  timeoutMs: 1000,
  retryBaseMs: 1,
  ...over,
});
const noSleep = () => Promise.resolve();
const respond = (status: number) => new Response("{}", { status });

describe("parseSubscriberId", () => {
  it("accepts only positive safe integers written as digits", () => {
    expect(parseSubscriberId("123456789")).toBe(123456789);
    expect(parseSubscriberId(" 42 ")).toBe(42);
    for (const bad of [
      "",
      "unknown",
      "12a",
      "-5",
      "0",
      "1.5",
      "99999999999999999",
      null,
      undefined,
    ]) {
      expect(parseSubscriberId(bad as string | null)).toBeNull();
    }
  });
});

describe("config", () => {
  it("is off by default and needs the exact flag value", () => {
    expect(manychatConfigFromEnv({}).enabled).toBe(false);
    expect(manychatConfigFromEnv({ SIX2FIT_CONSULT_MANYCHAT_MARK: "1" }).enabled).toBe(false);
    expect(manychatConfigFromEnv({ SIX2FIT_CONSULT_MANYCHAT_MARK: "true" }).enabled).toBe(true);
  });
  it("defaults the field id to the verified form_submitted field", () => {
    expect(manychatConfigFromEnv({}).fieldId).toBe(14310220);
    expect(manychatConfigFromEnv({ SIX2FIT_MANYCHAT_FORM_SUBMITTED_FIELD_ID: "77" }).fieldId).toBe(
      77,
    );
  });
});

describe("markFormSubmitted", () => {
  it("does nothing and makes no request when disabled", async () => {
    const fetchImpl = vi.fn();
    const m = createManychatMarker(cfg({ enabled: false }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await m.markFormSubmitted("123")).toBe("disabled");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("skips missing, invalid and unknown ids and a missing token without any request", async () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: noSleep };
    const m = createManychatMarker(cfg(), deps);
    expect(await m.markFormSubmitted(null)).toBe("skipped_no_id");
    expect(await m.markFormSubmitted("unknown")).toBe("skipped_invalid_id");
    expect(await createManychatMarker(cfg({ token: "" }), deps).markFormSubmitted("123")).toBe(
      "skipped_no_token",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("sets field_value true on the verified field with a Bearer token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(200));
    const m = createManychatMarker(cfg(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await m.markFormSubmitted("555")).toBe("marked");
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.manychat.com/fb/subscriber/setCustomField");
    expect(JSON.parse(init.body as string)).toEqual({
      subscriber_id: 555,
      field_id: 14310220,
      field_value: true,
    });
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      "Bearer synthetic-token-not-real",
    );
  });
  it("retries on network error, 429 and 5xx, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("net"))
      .mockResolvedValueOnce(respond(503))
      .mockResolvedValueOnce(respond(200));
    const m = createManychatMarker(cfg(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await m.markFormSubmitted("555")).toBe("marked");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("gives up after the attempt budget and reports failed without throwing", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(500));
    const m = createManychatMarker(cfg({ maxAttempts: 2 }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await m.markFormSubmitted("555")).toBe("failed");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("does not retry client errors (bad id, bad token, missing field)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(respond(400));
    const m = createManychatMarker(cfg(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await m.markFormSubmitted("555")).toBe("rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("never logs the subscriber id or the token", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(respond(200));
    const m = createManychatMarker(cfg(), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      log: (e, f) => logs.push(JSON.stringify({ e, f })),
    });
    await m.markFormSubmitted("987654321");
    const all = logs.join("");
    expect(all).not.toContain("987654321");
    expect(all).not.toContain("synthetic-token");
  });
  it("aborts a hanging request after the timeout and still resolves", async () => {
    const fetchImpl = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init.signal?.addEventListener("abort", () => rej(new Error("aborted"))),
        ),
    );
    const m = createManychatMarker(cfg({ timeoutMs: 5, maxAttempts: 1 }), {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    expect(await m.markFormSubmitted("555")).toBe("failed");
  });
});
