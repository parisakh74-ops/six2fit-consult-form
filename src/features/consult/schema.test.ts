import { describe, expect, it } from "vitest";
import { contactSchema, consentSchema } from "./schema";

const contact = {
  lead_full_name: "سارا احمدی",
  whatsapp_dial_code: "+1",
  whatsapp_phone: "4165551234",
  consult_channel: "whatsapp_text",
  email: "",
};

describe("Consult required fields", () => {
  it("requires an explicitly selected dial code", () => {
    const result = contactSchema.safeParse({ ...contact, whatsapp_dial_code: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["whatsapp_dial_code"]);
    }
    expect(contactSchema.safeParse(contact).success).toBe(true);
  });

  it("still rejects empty required contact answers", () => {
    const result = contactSchema.safeParse({ ...contact, lead_full_name: "", whatsapp_phone: "", consult_channel: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path);
      for (const field of ["lead_full_name", "whatsapp_phone", "consult_channel"]) {
        expect(paths).toContainEqual([field]);
      }
    }
  });

  it("still requires both consents before submission", () => {
    expect(consentSchema.safeParse({ consent_processing: false, consent_accuracy: false }).success).toBe(false);
    expect(consentSchema.safeParse({ consent_processing: true, consent_accuracy: true }).success).toBe(true);
  });
});