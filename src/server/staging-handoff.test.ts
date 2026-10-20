import { describe, expect, it } from "vitest";
import * as handoff from "./staging-handoff";

describe("O1: Consultation staging configuration", () => {
  it("requires only the staging switch and the storage directory (no secret, no Onboarding URL)", () => {
    const keep = { ...process.env };
    try {
      process.env["SIX2FIT_STAGING_MODE"] = "true";
      process.env["SIX2FIT_STAGING_STORAGE_DIR"] = "/tmp/synthetic";
      delete process.env["SIX2FIT_STAGING_TOKEN_SECRET"];
      delete process.env["ONBOARDING_STAGING_BASE_URL"];
      expect(handoff.stagingConfig()).toEqual({ storageDir: "/tmp/synthetic" });
      process.env["SIX2FIT_STAGING_MODE"] = "false";
      expect(() => handoff.stagingConfig()).toThrow();
    } finally {
      process.env = keep;
    }
  });

  it("exports no token signing or verification", () => {
    expect(Object.keys(handoff).sort()).toEqual(["claimOnce", "ensureStorage", "payloadHash", "readJson", "stagingConfig", "writeJsonAtomic"]);
  });
});
