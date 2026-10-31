import { GUIDE_VIDEO_URL, PLANS_URL, WHATSAPP_CTA_LABEL, WHATSAPP_URL, type Scenario } from "./routing";

const primary =
  "inline-flex w-full items-center justify-center rounded-xl bg-brand px-5 py-3 text-[15px] font-semibold text-white";
const outline =
  "inline-flex w-full items-center justify-center rounded-xl border border-border px-5 py-3 text-[15px] font-semibold text-foreground";

/** Result-page calls to action per scenario, same destinations and labels as the Smart Redirector Thank You page. */
export function RoutingCtas({ scenario }: { scenario: Scenario }) {
  if (scenario === "C") {
    return (
      <div className="flex flex-col gap-3" data-testid="routing-cta" data-scenario="C">
        <a href={GUIDE_VIDEO_URL} target="_blank" rel="noopener noreferrer" className={primary}>
          مشاهده ویدیوی راهنما
        </a>
        <a href={PLANS_URL} target="_blank" rel="noopener noreferrer" className={outline}>
          مشاهده پلن‌ها
        </a>
      </div>
    );
  }
  return (
    <div data-testid="routing-cta" data-scenario={scenario}>
      <a href={WHATSAPP_URL} target="_blank" rel="noopener noreferrer" className={primary}>
        {WHATSAPP_CTA_LABEL[scenario]}
      </a>
    </div>
  );
}
