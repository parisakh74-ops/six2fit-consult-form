// @vitest-environment node
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RoutingCtas } from "./RoutingCtas";
import { GUIDE_VIDEO_URL, PLANS_URL, WHATSAPP_URL, routeAfterSubmission } from "./routing";

// Static render (no DOM library in this project). Destinations copied from the Smart Redirector ThankYou.tsx.
describe("scenario CTAs match the Smart Redirector", () => {
  it("scenario C has the guide-video link and the plans link, both new-tab, and no embedded video", () => {
    const html = renderToStaticMarkup(<RoutingCtas scenario="C" />);
    expect(GUIDE_VIDEO_URL).toBe("https://six2fit.com/pln/");
    expect(PLANS_URL).toBe("https://six2fit.com/price/");
    expect(html).toContain(`href="${GUIDE_VIDEO_URL}"`);
    expect(html).toContain(`href="${PLANS_URL}"`);
    expect(html).toContain("مشاهده ویدیوی راهنما");
    expect(html).toContain("مشاهده پلن‌ها");
    expect(html.match(/target="_blank"/g)).toHaveLength(2);
    expect(html.match(/rel="noopener noreferrer"/g)).toHaveLength(2);
    expect(html).not.toMatch(/<video|<iframe/i);
  });

  it("scenarios A and B show only the WhatsApp button", () => {
    for (const [scenario, label] of [["A", "درخواست مشاوره مستقیم"], ["B", "ارسال پیام در واتساپ"]] as const) {
      const html = renderToStaticMarkup(<RoutingCtas scenario={scenario} />);
      expect(html).toContain(`href="${WHATSAPP_URL}"`);
      expect(html).toContain(label);
      expect(html).not.toContain(GUIDE_VIDEO_URL);
    }
  });

  it("a failed submission yields no scenario, so no CTA is rendered", () => {
    expect(routeAfterSubmission({ tz: "1", budget_range: "lt_5m", readiness_level: "exploring", submission: { ok: false } })).toEqual({ status: "NOT_SUBMITTED" });
  });
});

import { CTA_ALLOWED_OUTCOMES, ctasAllowedFor } from "./routing";

describe("sales CTAs and safety outcomes (restriction is an open Product decision)", () => {
  it("by default every outcome gets the sales CTAs, as in the Smart Redirector", () => {
    expect([...CTA_ALLOWED_OUTCOMES]).toEqual(["GREEN", "YELLOW_REVIEW", "RED_SPECIALIST"]);
    expect(ctasAllowedFor("GREEN")).toBe(true);
    expect(ctasAllowedFor("YELLOW_REVIEW")).toBe(true);
    expect(ctasAllowedFor("RED_SPECIALIST")).toBe(true);
  });
});

import { outcomeCopy } from "./assessmentConfig";
import { WHATSAPP_CTA_LABEL, resultTextFor } from "./routing";

describe("result sentence names the WhatsApp button instead of promising a call", () => {
  const routed = (scenario: "A" | "B" | "C") => ({ status: "ROUTED", scenario, score: scenario === "B" ? null : 6 }) as const;
  const base = outcomeCopy.GREEN.text;

  it("GREEN + scenario A: tells the user to click the direct-consultation button", () => {
    const text = resultTextFor("GREEN", routed("A"), base);
    expect(text).toBe("برای برقراری ارتباط با کارشناس روی «درخواست مشاوره مستقیم» کلیک کنید.");
    expect(text).not.toContain("در ارتباط خواهد بود");
  });

  it("GREEN + scenario B: names the WhatsApp message button", () => {
    expect(resultTextFor("GREEN", routed("B"), base)).toBe("برای برقراری ارتباط با کارشناس روی «ارسال پیام در واتساپ» کلیک کنید.");
  });

  it("the sentence uses the exact label rendered on the button", () => {
    for (const s of ["A", "B"] as const) {
      expect(renderToStaticMarkup(<RoutingCtas scenario={s} />)).toContain(WHATSAPP_CTA_LABEL[s]);
      expect(resultTextFor("GREEN", routed(s), base)).toContain(`«${WHATSAPP_CTA_LABEL[s]}»`);
    }
  });

  it("every other case keeps the existing outcome text", () => {
    expect(resultTextFor("GREEN", routed("C"), base)).toBe(base);
    expect(resultTextFor("GREEN", { status: "NOT_SUBMITTED" }, base)).toBe(base);
    expect(resultTextFor("GREEN", { status: "SCORE_UNAVAILABLE", reason: "INCOMPLETE" }, base)).toBe(base);
    expect(resultTextFor("YELLOW_REVIEW", routed("A"), outcomeCopy.YELLOW_REVIEW.text)).toBe(outcomeCopy.YELLOW_REVIEW.text);
    expect(resultTextFor("RED_SPECIALIST", routed("B"), outcomeCopy.RED_SPECIALIST.text)).toBe(outcomeCopy.RED_SPECIALIST.text);
  });
});
