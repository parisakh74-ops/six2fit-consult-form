// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countries } from "./assessmentConfig";
import { parseWhatsappPhone } from "./outcome";
import { NEUTRAL_PHONE_PLACEHOLDER, phonePlaceholder } from "./phonePlaceholder";

// DEF-05: the placeholder follows the selected country (examples come from libphonenumber-js metadata) and falls
// back to a neutral text. Synthetic/example numbers only.
describe("phone placeholder", () => {
  it("is neutral when no country is selected or the country is unknown", () => {
    expect(phonePlaceholder(undefined)).toBe(NEUTRAL_PHONE_PLACEHOLDER);
    expect(phonePlaceholder("")).toBe(NEUTRAL_PHONE_PLACEHOLDER);
    expect(phonePlaceholder("ZZ")).toBe(NEUTRAL_PHONE_PLACEHOLDER);
    expect(phonePlaceholder("not-a-country")).toBe(NEUTRAL_PHONE_PLACEHOLDER);
    expect(NEUTRAL_PHONE_PLACEHOLDER).toBe("شماره واتساپ");
  });

  it("changes with the selected country", () => {
    const ir = phonePlaceholder("IR");
    const us = phonePlaceholder("US");
    const ae = phonePlaceholder("AE");
    expect(new Set([ir, us, ae]).size).toBe(3);
    expect(ir).not.toBe(NEUTRAL_PHONE_PLACEHOLDER);
    expect(us).not.toBe(NEUTRAL_PHONE_PLACEHOLDER);
  });

  it("every supported country has an example that the phone contract accepts for that country's calling code", () => {
    const rejected = countries
      .map((c) => ({ iso: c.iso, dial: c.dial, example: phonePlaceholder(c.iso) }))
      .filter((c) => c.example !== NEUTRAL_PHONE_PLACEHOLDER)
      .filter((c) => !parseWhatsappPhone(c.dial, c.example).ok);
    expect(rejected).toEqual([]);
  });

  it("falls back to the neutral text only for countries without an example, never an empty string", () => {
    for (const c of countries) expect(phonePlaceholder(c.iso).length).toBeGreaterThan(0);
  });

  // The form starts on an intro screen and this project has no DOM test environment, so the wiring is checked on the
  // source: the placeholder is computed from the selected country on every render and the digits are normalized on input.
  it("the phone field is wired to the selected country and to the digit normalization", () => {
    const source = readFileSync(
      join(process.cwd(), "src/features/consult/ConsultForm.tsx"),
      "utf8",
    );
    expect(source).toContain("placeholder={phonePlaceholder(values.whatsapp_country)}");
    expect(source).toContain('set("whatsapp_phone", toAsciiDigits(e.target.value))');
    expect(source).not.toContain("912 345 6789");
  });
});
