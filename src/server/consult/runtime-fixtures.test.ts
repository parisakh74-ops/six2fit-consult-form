import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_FLAG, moduleAnswer, newId, payloadFrom, tamper } from "./fixtures";
import { validateConsultPayload } from "./validate";

/**
 * Fixture generator for scripts/verify-consult-runtime.mjs (runtime checks against a built
 * Nitro server or `vite dev`). Skipped unless CONSULT_FIXTURE_OUT is set. SYNTHETIC data only.
 */
const out = process.env["CONSULT_FIXTURE_OUT"];

describe.skipIf(!out)("runtime fixtures", () => {
  it("writes synthetic payload fixtures", () => {
    const plain = (id: number) => JSON.parse(JSON.stringify(payloadFrom({}, newId(id))));
    const modules = JSON.parse(
      JSON.stringify(
        payloadFrom(
          {
            ts_01_has_limitation: "yes",
            ts_02_categories: ["tendon", "oncology"],
            ts_03_clearance: "no",
            modules: { tendon: moduleAnswer([FIRST_FLAG["tendon"] as string]), oncology: moduleAnswer() },
          },
          newId(2),
        ),
      ),
    );
    expect(validateConsultPayload(modules).ok).toBe(true);
    const fixtures = {
      valid: plain(1),
      with_modules: modules,
      conflicting_same_id: tamper(payloadFrom({}, newId(1)), (p) => { p.weight_kg = 71; p.onboarding_prefill["ON-09.kg"] = 71; }),
      concurrent_identical: plain(3),
      query_fallback: plain(4),
      old_version: tamper(payloadFrom({}, newId(5)), (p) => (p.form_version = "consult-2.0.0")),
      unexpected_key: tamper(payloadFrom({}, newId(6)), (p) => (p.rogue = 1)),
      outcome_mismatch: tamper(payloadFrom({ health_flags: ["liver_cirrhosis_failure"], blocker_details: "synthetic" }, newId(7)), (p) => (p.safety_outcome = "GREEN")),
      inactive_module: tamper(payloadFrom({}, newId(8)), (p) => (p.modules = { tendon: { diagnosis: "x" } })),
    };
    mkdirSync(out as string, { recursive: true });
    writeFileSync(join(out as string, "fixtures.json"), JSON.stringify(fixtures));
  });
});
