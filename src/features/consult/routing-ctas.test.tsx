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

describe("sales CTAs and safety outcomes (proposal pending Product)", () => {
  it("only GREEN gets the sales CTAs by default", () => {
    expect([...CTA_ALLOWED_OUTCOMES]).toEqual(["GREEN"]);
    expect(ctasAllowedFor("GREEN")).toBe(true);
    expect(ctasAllowedFor("YELLOW_REVIEW")).toBe(false);
    expect(ctasAllowedFor("RED_SPECIALIST")).toBe(false);
  });
});
