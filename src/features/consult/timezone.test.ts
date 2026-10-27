import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetGroupForTz, budgetQuestionForTz, detectTzCode, isBudgetValueForTz, tzCodeFromTimeZone } from "./timezone";
import { payloadFrom } from "../../server/consult/fixtures";
import { validateConsultPayload } from "../../server/consult/validate";
import { computeScore, routeAfterSubmission } from "./routing";

afterEach(() => vi.restoreAllMocks());

const withBrowserTimeZone = (timeZone: string | "throws") =>
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => ({
    resolvedOptions: () => {
      if (timeZone === "throws") throw new Error("no Intl");
      return { timeZone };
    },
  })) as never);

describe("one tz source: browser time zone", () => {
  it("Tehran -> tz 1 -> Toman budget", () => {
    withBrowserTimeZone("Asia/Tehran");
    expect(detectTzCode()).toBe("1");
    expect(budgetGroupForTz(detectTzCode())).toBe("IR");
    expect(budgetQuestionForTz("1").currency).toBe("IRT");
  });

  it.each(["Europe/Berlin", "America/Toronto", "Asia/Dubai", "UTC", "Asia/Tehran "])("%s -> tz 2 -> USD budget", (zone) => {
    withBrowserTimeZone(zone);
    expect(detectTzCode()).toBe("2");
    expect(budgetQuestionForTz("2").currency).toBe("USD");
  });

  it("a detection failure falls back to tz 2", () => {
    withBrowserTimeZone("throws");
    expect(detectTzCode()).toBe("2");
    expect(tzCodeFromTimeZone(undefined)).toBe("2");
  });
});

describe("the WhatsApp country code plays no part (independent cases)", () => {
  const ok = (p: unknown) => validateConsultPayload(p).ok;
  const toman = { budget_range: "5_10m" };
  const usd = { budget_range: "70_170" };

  it("Tehran browser + +98 number -> Toman, valid", () => {
    const p = payloadFrom({ whatsapp_country: "IR", whatsapp_dial_code: "+98", whatsapp_phone: "9120000000", ...toman } as never, undefined, "1");
    expect(p).toMatchObject({ budget_tz: "1", budget_currency: "IRT", currency_route_source: "browser_timezone" });
    expect(ok(p)).toBe(true);
  });

  it("Tehran browser + non-Iranian number (+1) -> still Toman, valid", () => {
    const p = payloadFrom({ whatsapp_dial_code: "+1", ...toman } as never, undefined, "1");
    expect(p).toMatchObject({ budget_tz: "1", budget_currency: "IRT" });
    expect(ok(p)).toBe(true);
  });

  it("other browser time zone + +98 number -> USD, valid (the dial code no longer decides)", () => {
    const p = payloadFrom({ whatsapp_country: "IR", whatsapp_dial_code: "+98", whatsapp_phone: "9120000000", ...usd } as never, undefined, "2");
    expect(p).toMatchObject({ budget_tz: "2", budget_currency: "USD" });
    expect(ok(p)).toBe(true);
  });

  it("other browser time zone + non-Iranian number -> USD, valid", () => {
    const p = payloadFrom({ whatsapp_dial_code: "+1", ...usd } as never, undefined, "2");
    expect(p).toMatchObject({ budget_tz: "2", budget_currency: "USD" });
    expect(ok(p)).toBe(true);
  });

  it("a budget answer of the other currency is rejected by the server (stale value after a time-zone change)", () => {
    const staleToman = payloadFrom({ whatsapp_dial_code: "+98", whatsapp_country: "IR", whatsapp_phone: "9120000000", ...toman } as never, undefined, "2");
    expect(validateConsultPayload(staleToman).ok).toBe(false);
    const staleUsd = payloadFrom({ ...usd } as never, undefined, "1");
    expect(validateConsultPayload(staleUsd).ok).toBe(false);
  });

  it("a payload whose currency contradicts budget_tz is rejected", () => {
    const p = { ...payloadFrom({ ...usd } as never, undefined, "2"), budget_currency: "IRT" };
    expect(validateConsultPayload(p).ok).toBe(false);
  });
});

describe("stale budget handling and a single tz for budget and routing", () => {
  it("isBudgetValueForTz drops a value that belongs to the other currency", () => {
    expect(isBudgetValueForTz("1", "5_10m")).toBe(true);
    expect(isBudgetValueForTz("1", "70_170")).toBe(false);
    expect(isBudgetValueForTz("2", "70_170")).toBe(true);
    expect(isBudgetValueForTz("2", "5_10m")).toBe(false);
    expect(isBudgetValueForTz("2", "")).toBe(false);
  });

  it("a Tehran user's Toman budget is scored and routed with the same tz 1", () => {
    const p = payloadFrom({ budget_range: "10_20m", readiness_level: "ready_if_results" } as never, undefined, "1");
    expect(computeScore({ tz: p.budget_tz, budget_range: p.budget_range, readiness_level: p.readiness_level })).toMatchObject({ score: 6 });
    expect(routeAfterSubmission({ submission: { ok: true }, tz: p.budget_tz, budget_range: p.budget_range, readiness_level: p.readiness_level })).toMatchObject({ scenario: "A", score: 6 });
  });
});
