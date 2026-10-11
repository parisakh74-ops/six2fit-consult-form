import { describe, expect, it } from "vitest";
import { scopeFromServices, signHandoff, verifyHandoff } from "./staging-handoff";

const secret = "test-secret-that-is-longer-than-thirty-two-characters";

describe("staging handoff", () => {
  it("signs and verifies a valid handoff", () => {
    const claims = {
      v: 1 as const,
      consult_submission_id: "cns_12345678-1234-1234-1234-123456789012",
      scope: "Combo" as const,
      entitlements: ["cellulite"],
      exp: Math.floor(Date.now() / 1000) + 60,
    };

    expect(verifyHandoff(signHandoff(claims, secret), secret)).toEqual(claims);
  });

  it("rejects a modified or expired handoff", () => {
    const expired = signHandoff({
      v: 1,
      consult_submission_id: "cns_12345678-1234-1234-1234-123456789012",
      scope: "Diet",
      entitlements: [],
      exp: Math.floor(Date.now() / 1000) - 1,
    }, secret);

    expect(() => verifyHandoff(`${expired}x`, secret)).toThrow();
    expect(() => verifyHandoff(expired, secret)).toThrow(/Expired/);
  });

  it("maps consult services to onboarding scope", () => {
    expect(scopeFromServices(["nutrition"])).toBe("Diet");
    expect(scopeFromServices(["training"])).toBe("Training");
    expect(scopeFromServices(["nutrition", "training"])).toBe("Combo");
    expect(scopeFromServices(["not_sure"])).toBe("Combo");
  });
});
