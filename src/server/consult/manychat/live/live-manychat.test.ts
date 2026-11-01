import { describe, expect, it } from "vitest";
import { createManychatMarker, DEFAULT_FORM_SUBMITTED_FIELD_ID } from "../marker";

/**
 * LIVE check against ManyChat with ONE authorized TEST subscriber. Skipped unless explicitly enabled.
 * Run only by the PM (the token is typed into a secure prompt, never stored in a file or sent to chat):
 *   S2F_LIVE_MANYCHAT_TEST=1, S2F_MC_TEST_TOKEN, S2F_MC_TEST_SUBSCRIBER_ID (the test contact's Contact Id)
 * Steps: set form_submitted = false (what the Consult flow does first) -> read it back -> run the real marker -> read it back.
 * It touches only the test subscriber and only the field form_submitted. Nothing is printed except PASS/FAIL.
 */
const enabled = process.env["S2F_LIVE_MANYCHAT_TEST"] === "1";
const token = process.env["S2F_MC_TEST_TOKEN"] ?? "";
const subscriber = process.env["S2F_MC_TEST_SUBSCRIBER_ID"] ?? "";
const API = "https://api.manychat.com/fb/subscriber";

async function readField(): Promise<unknown> {
  const res = await fetch(`${API}/getInfo?subscriber_id=${encodeURIComponent(subscriber)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.ok).toBe(true);
  const json = (await res.json()) as {
    data?: { custom_fields?: Array<{ id: number; value: unknown }> };
  };
  return json.data?.custom_fields?.find((f) => f.id === DEFAULT_FORM_SUBMITTED_FIELD_ID)?.value;
}

describe.skipIf(!enabled || token === "" || subscriber === "")(
  "live ManyChat form_submitted (test subscriber only)",
  () => {
    it("false -> marker -> true, read back from ManyChat", async () => {
      const reset = await fetch(`${API}/setCustomField`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          subscriber_id: Number(subscriber),
          field_id: DEFAULT_FORM_SUBMITTED_FIELD_ID,
          field_value: false,
        }),
      });
      expect(reset.ok).toBe(true);
      expect(await readField()).toBe(false);

      const marker = createManychatMarker({
        enabled: true,
        token,
        fieldId: DEFAULT_FORM_SUBMITTED_FIELD_ID,
        maxAttempts: 3,
        timeoutMs: 5000,
        retryBaseMs: 500,
      });
      expect(await marker.markFormSubmitted(subscriber)).toBe("marked");
      expect(await readField()).toBe(true);

      // idempotent: a second call leaves it true
      expect(await marker.markFormSubmitted(subscriber)).toBe("marked");
      expect(await readField()).toBe(true);
    });

    it("a wrong token is rejected and never throws", async () => {
      const marker = createManychatMarker({
        enabled: true,
        token: "invalid-token-for-negative-test",
        fieldId: DEFAULT_FORM_SUBMITTED_FIELD_ID,
        maxAttempts: 2,
        timeoutMs: 5000,
        retryBaseMs: 100,
      });
      expect(["rejected", "failed"]).toContain(await marker.markFormSubmitted(subscriber));
    });
  },
);
