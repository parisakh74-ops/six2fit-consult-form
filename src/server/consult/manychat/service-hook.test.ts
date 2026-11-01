import { describe, expect, it, vi } from "vitest";
import { createConsultService } from "../service";
import { MemoryStore, newId, payloadFrom } from "../fixtures";

const JSON_CT = "application/json; charset=utf-8";
const withManychat = (id: string, manychat_id: string | null) => ({
  ...payloadFrom({}, id),
  manychat_id,
});
const send = (
  service: ReturnType<typeof createConsultService>,
  payload: { submission_id: string },
) =>
  service.submit({
    contentType: JSON_CT,
    idempotencyKey: payload.submission_id,
    body: JSON.stringify(payload),
  });

describe("onAccepted hook", () => {
  it("fires once for a new submission with the manychat id", async () => {
    const onAccepted = vi.fn();
    const service = createConsultService({ store: new MemoryStore(), onAccepted });
    const r = await send(service, withManychat(newId(1), "123456"));
    expect(r.status).toBe(200);
    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onAccepted).toHaveBeenCalledWith({ submission_id: newId(1), manychat_id: "123456" });
  });
  it("does not fire for a replay (idempotent, non-duplicate only)", async () => {
    const onAccepted = vi.fn();
    const service = createConsultService({ store: new MemoryStore(), onAccepted });
    const payload = withManychat(newId(2), "123456");
    await send(service, payload);
    const replay = await send(service, payload);
    expect(replay.body).toMatchObject({ ok: true, deduplicated: true });
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });
  it("does not fire for a rejected submission", async () => {
    const onAccepted = vi.fn();
    const service = createConsultService({ store: new MemoryStore(), onAccepted });
    const r = await service.submit({
      contentType: JSON_CT,
      idempotencyKey: newId(3),
      body: "{not json",
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(onAccepted).not.toHaveBeenCalled();
  });
  it("passes null when the submission has no manychat id", async () => {
    const onAccepted = vi.fn();
    const service = createConsultService({ store: new MemoryStore(), onAccepted });
    await send(service, withManychat(newId(4), null));
    expect(onAccepted).toHaveBeenCalledWith({ submission_id: newId(4), manychat_id: null });
  });
  it("a throwing or rejecting hook never changes the response", async () => {
    const throwing = createConsultService({
      store: new MemoryStore(),
      onAccepted: () => {
        throw new Error("boom");
      },
    });
    const rejecting = createConsultService({
      store: new MemoryStore(),
      onAccepted: () => Promise.reject(new Error("boom")),
    });
    expect((await send(throwing, withManychat(newId(5), "1"))).body).toMatchObject({
      ok: true,
      deduplicated: false,
    });
    expect((await send(rejecting, withManychat(newId(6), "1"))).body).toMatchObject({
      ok: true,
      deduplicated: false,
    });
  });
  it("does not wait for a hanging hook", async () => {
    const service = createConsultService({
      store: new MemoryStore(),
      onAccepted: () => new Promise<void>(() => undefined),
    });
    const r = await send(service, withManychat(newId(7), "1"));
    expect(r.body).toMatchObject({ ok: true });
  });
});
