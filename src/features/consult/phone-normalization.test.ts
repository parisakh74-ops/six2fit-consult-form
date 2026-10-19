import { describe, expect, it } from "vitest";
import { validateConsultPayload } from "../../server/consult/validate";
import { payloadFrom } from "../../server/consult/fixtures";
import { normalizePhone, parseWhatsappPhone, toAsciiDigits, type PhoneRejection } from "./outcome";
import { contactSchema, phoneRejectionMessage } from "./schema";

/**
 * DEF-05 regression suite — phone input contract A (docs/DEF-05_phone_normalization.md).
 *  - `+` or `00` first: explicitly international (digits after it must start with the selected calling code).
 *  - otherwise: a national number for the selected country; leading digits equal to the calling code are kept.
 *  - one leading 0 of a national number is the trunk prefix; invalid or ambiguous input is rejected, never guessed.
 * Synthetic numbers only.
 */

const COUNTRY_OF: Record<string, string> = {
  "+1": "CA",
  "+98": "IR",
  "+91": "IN",
  "+7": "RU",
  "+971": "AE",
  "+39": "IT",
  "+44": "GB",
  "+49": "DE",
};

type Valid = [name: string, dial: string, raw: string, e164: string];

const VALID: Valid[] = [
  // Canada / US (+1, 10 digits)
  ["Canada, national", "+1", "416 555 0100", "+14165550100"],
  ["US, national with punctuation", "+1", "(212) 555-0100", "+12125550100"],
  ["Canada, explicit +", "+1", "+1 416 555 0100", "+14165550100"],
  ["Canada, explicit 00", "+1", "001 416 555 0100", "+14165550100"],
  // Iran (+98)
  ["Iran, trunk zero", "+98", "0912 345 6789", "+989123456789"],
  ["Iran, no trunk zero", "+98", "912 345 6789", "+989123456789"],
  ["Iran, hyphens", "+98", "0912-345-6789", "+989123456789"],
  [
    "Iran, explicit + with the trunk zero kept (libphonenumber accepts it)",
    "+98",
    "+98 0912 345 6789",
    "+989123456789",
  ],
  ["Iran, explicit +", "+98", "+98 912 345 6789", "+989123456789"],
  ["Iran, explicit 00", "+98", "0098 912 345 6789", "+989123456789"],
  ["Iran, national starting with 98 (kept whole)", "+98", "981 234 5678", "+989812345678"],
  // India (+91)
  ["India, national", "+91", "98765 43210", "+919876543210"],
  ["India, national starting with 91 (kept whole)", "+91", "91234 56789", "+919123456789"],
  ["India, explicit +", "+91", "+91 91234 56789", "+919123456789"],
  ["India, explicit 00", "+91", "0091 91234 56789", "+919123456789"],
  // Kazakhstan / Russia (+7, 10 digits; Kazakhstan has no entry of its own in the country list)
  ["Kazakhstan, national starting with 7 (kept whole)", "+7", "701 234 5678", "+77012345678"],
  ["Russia/Kazakhstan, the real trunk prefix 8", "+7", "8 701 234 5678", "+77012345678"],
  ["Kazakhstan, explicit +", "+7", "+7 701 234 5678", "+77012345678"],
  ["Kazakhstan, explicit 00", "+7", "007 701 234 5678", "+77012345678"],
  // United Arab Emirates (+971)
  ["UAE, trunk zero", "+971", "050 123 4567", "+971501234567"],
  ["UAE, no trunk zero", "+971", "50 123 4567", "+971501234567"],
  ["UAE, explicit +", "+971", "+971 50 123 4567", "+971501234567"],
  ["UAE, explicit 00", "+971", "00971 50 123 4567", "+971501234567"],
  // Italy (+39): the leading 0 of a landline is part of the number and is kept; mobile numbers have none
  ["Italy, mobile", "+39", "312 345 6789", "+393123456789"],
  ["Italy, landline, national keeps the 0", "+39", "06 1234 5678", "+390612345678"],
  ["Italy, landline, explicit +", "+39", "+39 06 1234 5678", "+390612345678"],
  ["Italy, landline, explicit 00", "+39", "0039 06 1234 5678", "+390612345678"],
  ["Italy, Milan landline, national", "+39", "02 1234 5678", "+390212345678"],
  // other countries with a trunk 0 (only one leading 0 is removed)
  ["UK, trunk zero", "+44", "020 7946 0958", "+442079460958"],
  ["UK, explicit +", "+44", "+44 20 7946 0958", "+442079460958"],
  ["Germany, trunk zero", "+49", "030 1234 5678", "+493012345678"],
];

const REJECTED: [name: string, dial: string, raw: string, reason: PhoneRejection][] = [
  // invalid country-code combinations
  ["explicit +7 while +98 is selected", "+98", "+7 701 234 5678", "COUNTRY_CODE_MISMATCH"],
  ["explicit +44 while +1 is selected", "+1", "+44 20 7946 0958", "COUNTRY_CODE_MISMATCH"],
  ["explicit 00 with another code", "+91", "0098 912 345 6789", "COUNTRY_CODE_MISMATCH"],
  // calling code typed in front of a national number without + or 00: never silently removed
  ["NANP number typed with a leading 1", "+1", "1 416 555 0100", "LEADING_CALLING_CODE"],
  ["Iran code typed without +", "+98", "989123456789", "LEADING_CALLING_CODE"],
  ["India code typed without +", "+91", "91 98765 43210", "LEADING_CALLING_CODE"],
  // not a valid number for the country (libphonenumber metadata)
  ["NANP number one digit short", "+1", "416 555 010", "INVALID_NUMBER"],
  ["trunk zero is not used in +1", "+1", "0416 555 0100", "INVALID_NUMBER"],
  ["trunk zero is not used in +7", "+7", "0701 234 5678", "INVALID_NUMBER"],
  ["UAE number with an impossible pattern", "+971", "971 234 567", "INVALID_NUMBER"],
  // malformed
  ["empty", "+98", "", "EMPTY"],
  ["blank", "+98", "   ", "EMPTY"],
  ["letters", "+98", "abc", "INVALID_CHARACTERS"],
  ["plus in the middle", "+98", "98+912 345 6789", "INVALID_CHARACTERS"],
  ["double plus", "+98", "++98 912 345 6789", "INVALID_CHARACTERS"],
  ["marker only", "+98", "+", "INVALID_CHARACTERS"],
  ["00 only", "+98", "00", "INVALID_CHARACTERS"],
  ["letters among Persian digits", "+98", "۰۹۱۲abc۶۷۸۹", "INVALID_CHARACTERS"],
  [
    "Arabic decimal separator is not a phone character",
    "+98",
    "۰۹۱۲٫۳۴۵۶۷۸۹",
    "INVALID_CHARACTERS",
  ],
  ["too short", "+98", "912 345", "INVALID_NUMBER"],
  ["too long", "+98", "91234567890123", "INVALID_NUMBER"],
  ["no dial code selected", "", "912 345 6789", "MISSING_DIAL_CODE"],
  ["dial code without digits", "+", "912 345 6789", "MISSING_DIAL_CODE"],
];

describe("DEF-05 normalizePhone: valid input becomes E.164", () => {
  it.each(VALID)("%s", (_name, dial, raw, e164) => {
    expect(normalizePhone(dial, raw)).toBe(e164);
    const parsed = parseWhatsappPhone(dial, raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.e164).toBe(`+${dial.replace(/\D/g, "")}${parsed.national}`);
  });

  it("is idempotent: a normalized value normalizes to itself (the server re-applies it to the stored value)", () => {
    for (const [, dial, , e164] of VALID) expect(normalizePhone(dial, e164)).toBe(e164);
  });
});

describe("DEF-05 normalizePhone: invalid or ambiguous input is rejected, never guessed", () => {
  it.each(REJECTED)("%s", (_name, dial, raw, reason) => {
    const parsed = parseWhatsappPhone(dial, raw);
    expect(parsed).toEqual({ ok: false, reason });
    expect(normalizePhone(dial, raw)).toBe("");
  });
});

describe("DEF-05 demonstrations converted to regression tests (previously it.fails)", () => {
  it("India: a national number starting with 91 is kept whole", () => {
    expect(normalizePhone("+91", "91234 56789")).toBe("+919123456789");
  });
  it("Kazakhstan/Russia: a national number starting with 7 is kept whole", () => {
    expect(normalizePhone("+7", "701 234 5678")).toBe("+77012345678");
  });
  it("Iran: a national number starting with 98 is kept whole", () => {
    expect(normalizePhone("+98", "981 234 5678")).toBe("+989812345678");
  });
});

describe("DEF-05 behaviour changes that are intended (contract A)", () => {
  it("a calling code typed WITHOUT + or 00 is never silently removed: the input is rejected", () => {
    // before: "989123456789" with +98 became +989123456789 (the leading 98 was dropped)
    expect(normalizePhone("+98", "989123456789")).toBe("");
    expect(normalizePhone("+98", "+98 912 345 6789")).toBe("+989123456789"); // the explicit form still works
  });
});

describe("DEF-05 leading-zero edge cases", () => {
  it("removes exactly one trunk zero, never more", () => {
    expect(normalizePhone("+98", "0912 345 6789")).toBe("+989123456789");
    expect(normalizePhone("+98", "00912 345 6789")).toBe(""); // 00 is the international marker: 912… is not +98
    expect(normalizePhone("+971", "0 50 123 4567")).toBe("+971501234567"); // separators are ignored first
  });
  it("Italy: the leading zero is significant and is never stripped", () => {
    expect(normalizePhone("+39", "06 1234 5678")).toBe("+390612345678");
    expect(normalizePhone("+39", "+39 06 1234 5678")).toBe(normalizePhone("+39", "06 1234 5678"));
    expect(normalizePhone("+39", "0612345678")).toBe("+390612345678");
  });
  it("+1 and +7 have no trunk zero: a leading 0 is rejected, not stripped", () => {
    expect(parseWhatsappPhone("+1", "0416 555 0100")).toEqual({
      ok: false,
      reason: "INVALID_NUMBER",
    });
    expect(parseWhatsappPhone("+7", "0701 234 5678")).toEqual({
      ok: false,
      reason: "INVALID_NUMBER",
    });
  });
  it("Russia/Kazakhstan: 8 is the real national trunk prefix and is accepted", () => {
    expect(normalizePhone("+7", "8 701 234 5678")).toBe("+77012345678");
  });
});

describe("DEF-05 form validation (contactSchema)", () => {
  const contact = {
    lead_full_name: "Synthetic Tester",
    whatsapp_dial_code: "+98",
    whatsapp_phone: "0912 345 6789",
    consult_channel: "whatsapp_chat",
  };
  const messagesFor = (over: Record<string, string>) => {
    const result = contactSchema.safeParse({ ...contact, ...over });
    return result.success
      ? []
      : result.error.issues.filter((i) => i.path[0] === "whatsapp_phone").map((i) => i.message);
  };

  it("accepts the supported inputs", () => {
    for (const [, dial, raw] of VALID)
      expect(messagesFor({ whatsapp_dial_code: dial, whatsapp_phone: raw })).toEqual([]);
  });

  it("explains a country-code mismatch, a typed calling code and an invalid number", () => {
    expect(messagesFor({ whatsapp_phone: "+7 701 234 5678" })).toEqual([
      phoneRejectionMessage.COUNTRY_CODE_MISMATCH,
    ]);
    expect(messagesFor({ whatsapp_phone: "+98 0912 345 6789" })).toEqual([]);
    expect(messagesFor({ whatsapp_phone: "912 345 678" })).toEqual([
      phoneRejectionMessage.INVALID_NUMBER,
    ]);
    expect(messagesFor({ whatsapp_dial_code: "+39", whatsapp_phone: "06 1234 5678" })).toEqual([]); // Italy keeps its 0
    expect(messagesFor({ whatsapp_dial_code: "+1", whatsapp_phone: "1 416 555 0100" })).toEqual([
      phoneRejectionMessage.LEADING_CALLING_CODE,
    ]);
  });

  it("keeps the existing field rules (required, 6–20 characters, digits and separators only)", () => {
    expect(messagesFor({ whatsapp_phone: "" }).length).toBeGreaterThan(0);
    expect(messagesFor({ whatsapp_phone: "12345" })).toContain("شماره واتساپ معتبر نیست");
    expect(messagesFor({ whatsapp_phone: "0912abc6789" })).toContain(
      "شماره واتساپ فقط می‌تواند شامل عدد باشد",
    );
    expect(contactSchema.safeParse({ ...contact, whatsapp_dial_code: "" }).success).toBe(false);
  });
});

describe("DEF-05 Consultation → Onboarding handoff compatibility", () => {
  it.each(VALID)("%s: stored number, prefill and server checks agree", (_name, dial, raw, e164) => {
    const payload = payloadFrom({
      whatsapp_country: COUNTRY_OF[dial],
      whatsapp_dial_code: dial,
      whatsapp_phone: raw,
    } as never);
    expect(payload.whatsapp_phone_normalized).toBe(e164);
    expect(payload.onboarding_prefill["ON-06.n"]).toBe(e164); // the equality the server enforces (validate.ts)
    expect(payload.onboarding_prefill["ON-06.cc"]).toBe(dial);
    expect(payload.onboarding_prefill["ON-06.iso"]).toBe(COUNTRY_OF[dial]);
    const result = validateConsultPayload(payload);
    const phoneIssues = result.ok
      ? []
      : result.issues
          .filter((i) => /whatsapp_|onboarding_prefill/.test(i.path))
          .map((i) => `${i.path}:${i.code}`);
    expect(phoneIssues).toEqual([]); // shape, dial-code prefix, country/dial consistency and the normalizePhone re-check
  });

  it("the stored value is what Onboarding turns back into the national number (calling code + national part)", () => {
    // Onboarding removes "+<cc>" from onboarding_prefill["ON-06.n"] and validates 7–13 national digits.
    for (const [, dial, , e164] of VALID) {
      const parsed = parseWhatsappPhone(dial, e164);
      expect(parsed.ok && parsed.national.length >= 7 && parsed.national.length <= 13).toBe(true);
      expect(e164.startsWith(dial)).toBe(true);
    }
  });

  it("the server still rejects a stored number that no longer matches the dial code or the contract", () => {
    const base = payloadFrom();
    const phoneIssues = (mutate: (x: Record<string, unknown>) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(copy);
      const r = validateConsultPayload(copy);
      return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
    };
    expect(phoneIssues((x) => (x["whatsapp_dial_code"] = "+98"))).toContain(
      "whatsapp_phone_normalized:INCONSISTENT",
    );
    expect(
      phoneIssues((x) => {
        x["whatsapp_phone_normalized"] = "+1416555010"; // 9 national digits: not a valid +1 number
        (x["onboarding_prefill"] as Record<string, unknown>)["ON-06.n"] = "+1416555010";
      }),
    ).toContain("whatsapp_phone_normalized:INCONSISTENT");
  });
});

// Digit scripts: Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669) digits are converted to ASCII first.
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const toScript = (value: string, digits: string) =>
  value.replace(/[0-9]/g, (d) => digits[Number(d)] ?? d);
const toMixed = (value: string) =>
  value.replace(
    /[0-9]/g,
    (d, i: number) =>
      (i % 3 === 0 ? PERSIAN : i % 3 === 1 ? ARABIC_INDIC : "0123456789")[Number(d)] ?? d,
  );

describe("DEF-05 digit normalization (Persian and Arabic-Indic digits)", () => {
  it("toAsciiDigits converts both scripts and leaves everything else unchanged", () => {
    expect(toAsciiDigits(PERSIAN)).toBe("0123456789");
    expect(toAsciiDigits(ARABIC_INDIC)).toBe("0123456789");
    expect(toAsciiDigits("0123456789")).toBe("0123456789");
    expect(toAsciiDigits("+۹۸ (۹۱۲) ٣٤٥-6789 abc")).toBe("+98 (912) 345-6789 abc");
    expect(toAsciiDigits("")).toBe("");
    expect(toAsciiDigits("٫٬،")).toBe("٫٬،"); // separators and punctuation are not touched
  });

  it("is idempotent", () => {
    const once = toAsciiDigits("۰۹۱۲ ٣٤٥ 6789");
    expect(toAsciiDigits(once)).toBe(once);
  });

  describe.each([
    ["Persian", (v: string) => toScript(v, PERSIAN)],
    ["Arabic-Indic", (v: string) => toScript(v, ARABIC_INDIC)],
    ["mixed scripts", toMixed],
  ])("%s digits give the same result as ASCII", (_script, convert) => {
    it.each(VALID)("%s", (_name, dial, raw, e164) => {
      expect(normalizePhone(dial, convert(raw))).toBe(e164);
      expect(parseWhatsappPhone(dial, convert(raw))).toEqual(parseWhatsappPhone(dial, raw));
    });
    it.each(REJECTED.filter(([, , raw]) => raw !== "" && raw.trim() !== ""))(
      "%s",
      (_name, dial, raw, reason) => {
        expect(parseWhatsappPhone(dial, convert(raw))).toEqual({ ok: false, reason });
      },
    );
  });

  it("explicit + and 00 keep their meaning with non-ASCII digits", () => {
    expect(normalizePhone("+98", "+۹۸ ۹۱۲ ۳۴۵ ۶۷۸۹")).toBe("+989123456789");
    expect(normalizePhone("+98", "۰۰۹۸ ۹۱۲ ۳۴۵ ۶۷۸۹")).toBe("+989123456789");
    expect(normalizePhone("+98", "+٧ ٧٠١ ٢٣٤ ٥٦٧٨")).toBe(""); // still a country-code mismatch
    expect(normalizePhone("+98", "٩٨٩١٢٣٤٥٦٧٨٩")).toBe(""); // calling code typed without a marker is still rejected
  });

  it("does not silently remove unrelated characters", () => {
    expect(parseWhatsappPhone("+98", "۰۹۱۲ ۳۴۵ x۶۷۸۹")).toEqual({
      ok: false,
      reason: "INVALID_CHARACTERS",
    });
    expect(parseWhatsappPhone("+98", "۰۹۱۲.۳۴۵.۶۷۸۹")).toEqual({
      ok: false,
      reason: "INVALID_CHARACTERS",
    });
  });

  it("the form schema accepts Persian and Arabic-Indic digits and gives the same verdicts as ASCII", () => {
    const base = {
      lead_full_name: "Synthetic Tester",
      whatsapp_dial_code: "+98",
      consult_channel: "whatsapp_chat",
    };
    const ok = (phone: string, dial = "+98") =>
      contactSchema.safeParse({ ...base, whatsapp_dial_code: dial, whatsapp_phone: phone }).success;
    expect(ok("۰۹۱۲ ۳۴۵ ۶۷۸۹")).toBe(true);
    expect(ok("٩١٢ ٣٤٥ ٦٧٨٩")).toBe(true);
    expect(ok("+٧ ٧٠١ ٢٣٤ ٥٦٧٨")).toBe(false);
    expect(ok("(۲۱۲) ۵۵۵-۰۱۰۰", "+1")).toBe(true);
  });

  it("client and server agree: the submitted number is ASCII E.164 whichever digits were typed", () => {
    for (const [, dial, raw, e164] of VALID.slice(0, 12)) {
      const payload = payloadFrom({
        whatsapp_country: COUNTRY_OF[dial],
        whatsapp_dial_code: dial,
        whatsapp_phone: toScript(raw, PERSIAN),
      } as never);
      expect(payload.whatsapp_phone_normalized).toBe(e164);
      expect(payload.onboarding_prefill["ON-06.n"]).toBe(e164);
      const r = validateConsultPayload(payload);
      // other fields (e.g. the country-dependent budget range) are outside this test's scope
      expect(
        r.ok ? [] : r.issues.filter((i) => /whatsapp_|onboarding_prefill/.test(i.path)),
      ).toEqual([]);
    }
  });

  it("direct API submissions cannot bypass the rules: a non-ASCII stored number is rejected, not converted", () => {
    const payload = JSON.parse(JSON.stringify(payloadFrom())) as Record<string, unknown>;
    const fakePrefill = payload["onboarding_prefill"] as Record<string, unknown>;
    const forged = toScript(String(payload["whatsapp_phone_normalized"]), PERSIAN);
    payload["whatsapp_phone_normalized"] = forged;
    fakePrefill["ON-06.n"] = forged;
    expect(validateConsultPayload(payload).ok).toBe(false);
  });
});
