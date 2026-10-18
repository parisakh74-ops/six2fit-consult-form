import { describe, expect, it } from "vitest";
import { normalizePhone } from "./outcome";

/**
 * DEF-05 — documented regression demonstration. See docs/DEF-05_phone_normalization.md.
 *
 * `normalizePhone(dial, raw)` (outcome.ts) treats a raw number whose digits START WITH the calling-code digits as "the
 * person already typed the country code" and removes them. For a NATIONAL number that legitimately begins with the
 * same digits (India +91 / 91…, Kazakhstan +7 / 7…, Iran +98 / 98…) real digits are lost and the stored E.164 value
 * is wrong. The affected value is `whatsapp_phone_normalized` and `onboarding_prefill["ON-06.n"]`.
 *
 * Part 1 pins today's behaviour (passes). Part 2 states the desired behaviour with `it.fails`: while the defect exists
 * those tests are expected to fail, so the suite stays green. When normalizePhone is fixed they will start to
 * "pass unexpectedly" and `it.fails` turns that into a failure — convert them to plain `it` and delete Part 1.
 * Synthetic numbers only.
 */
const DEMO = [
  {
    name: "India: national number starts with 91",
    dial: "+91",
    raw: "91234 56789",
    current: "+9123456789",
    desired: "+919123456789",
  },
  {
    name: "Kazakhstan/Russia: national number starts with 7",
    dial: "+7",
    raw: "701 234 5678",
    current: "+7012345678",
    desired: "+77012345678",
  },
  {
    name: "Iran: national number starts with 98",
    dial: "+98",
    raw: "981 234 5678",
    current: "+9812345678",
    desired: "+989812345678",
  },
] as const;

describe("DEF-05 current behaviour (documented defect, pinned)", () => {
  for (const c of DEMO) {
    it(`${c.name}: leading digits equal to the calling code are dropped`, () => {
      expect(normalizePhone(c.dial, c.raw)).toBe(c.current);
      expect(normalizePhone(c.dial, c.raw)).not.toBe(c.desired);
    });
  }
});

describe("DEF-05 desired behaviour (expected to fail until the contract change is approved and implemented)", () => {
  for (const c of DEMO) {
    it.fails(`${c.name}: a national number is kept whole`, () => {
      expect(normalizePhone(c.dial, c.raw)).toBe(c.desired);
    });
  }
});

describe("behaviour that must survive any fix (passing today)", () => {
  it("handles the trunk zero and the country code typed in front, as the existing tests expect", () => {
    expect(normalizePhone("+98", "0912 345 6789")).toBe("+989123456789");
    expect(normalizePhone("+98", "+98 912 345 6789")).toBe("+989123456789");
    expect(normalizePhone("+98", "0098 912 345 6789")).toBe("+989123456789");
    expect(normalizePhone("+1", "(416) 555-0100")).toBe("+14165550100");
  });

  it("the server re-check accepts a correct E.164 value, so fixing the browser derivation needs no server change", () => {
    // validate.ts compares normalizePhone(dial, whatsapp_phone_normalized) with whatsapp_phone_normalized.
    for (const correct of ["+919123456789", "+77012345678", "+989812345678", "+14165550100"]) {
      const dial = correct.startsWith("+91")
        ? "+91"
        : correct.startsWith("+7")
          ? "+7"
          : correct.startsWith("+98")
            ? "+98"
            : "+1";
      expect(normalizePhone(dial, correct)).toBe(correct);
    }
  });
});
