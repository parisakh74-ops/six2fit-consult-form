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
    for (const [scenario, label] of [["A", "درخواست مشاوره مستقیم"], ["B", "ارسال پیام در واتس‌اپ"]] as const) {
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
import { WHATSAPP_CTA_LABEL, resultCopyFor } from "./routing";

describe("result copy follows the Smart Redirector flow instead of promising a call", () => {
  const routed = (scenario: "A" | "B" | "C") => ({ status: "ROUTED", scenario, score: scenario === "B" ? null : 6 }) as const;
  const green = outcomeCopy.GREEN;

  it("GREEN + A: PM wording, title unchanged", () => {
    const c = resultCopyFor("GREEN", routed("A"), green);
    expect(c.text).toBe("برای برقراری ارتباط با کارشناس روی «درخواست مشاوره مستقیم» کلیک کنید.");
    expect(c.title).toBe(green.title);
    expect(c.text).not.toContain("در ارتباط خواهد بود");
  });

  it("GREEN + B: text of the Redirector scenario B", () => {
    const c = resultCopyFor("GREEN", routed("B"), green);
    expect(c.text).toBe("از طریق دکمه زیر می‌توانید با یکی از کارشناسان ارشد تیم ما در ارتباط باشید:");
    expect(c.title).toBe(green.title);
  });

  it("GREEN + C: title and text of the Redirector scenario C, nothing about waiting for a call", () => {
    const c = resultCopyFor("GREEN", routed("C"), green);
    expect(c.title).toBe("ممنون که فرم درخواست رو تکمیل کردی!");
    expect(c.text).toBe(
      "بر اساس اطلاعاتی که وارد کردی، یک ویدیوی راهنما برات آماده کردیم.\nتوی این ویدیو با مسیرهای مختلف 6tofit آشنا می‌شی و می‌تونی راحت‌تر برنامه مناسب خودت رو انتخاب کنی.",
    );
    expect(c.text).not.toContain("در ارتباط");
  });

  it("button labels are the Redirector labels and are used by the buttons", () => {
    expect(WHATSAPP_CTA_LABEL).toEqual({ A: "درخواست مشاوره مستقیم", B: "ارسال پیام در واتس‌اپ" });
    for (const s of ["A", "B"] as const) expect(renderToStaticMarkup(<RoutingCtas scenario={s} />)).toContain(WHATSAPP_CTA_LABEL[s]);
  });

  it("YELLOW, RED and cases without a routing result keep the existing outcome copy", () => {
    expect(resultCopyFor("GREEN", { status: "NOT_SUBMITTED" }, green)).toBe(green);
    expect(resultCopyFor("GREEN", { status: "SCORE_UNAVAILABLE", reason: "INCOMPLETE" }, green)).toBe(green);
    expect(resultCopyFor("YELLOW_REVIEW", routed("C"), outcomeCopy.YELLOW_REVIEW)).toBe(outcomeCopy.YELLOW_REVIEW);
    expect(resultCopyFor("RED_SPECIALIST", routed("A"), outcomeCopy.RED_SPECIALIST)).toBe(outcomeCopy.RED_SPECIALIST);
  });
});
