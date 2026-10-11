import { createFileRoute } from "@tanstack/react-router";

import { ConsultForm } from "@/features/consult/ConsultForm";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "6toFit Consult — مشاوره تخصصی Six2Fit" },
      {
        name: "description",
        content:
          "فرم کوتاه مشاوره Six2Fit برای تعیین مسیر تغذیه و تمرین مناسب و بررسی ایمنی پیش از شروع برنامه.",
      },
      { property: "og:title", content: "6toFit Consult — مشاوره تخصصی Six2Fit" },
      {
        property: "og:description",
        content:
          "با چند سؤال کوتاه، مناسب‌ترین مسیر مشاوره تغذیه و تمرین برای شما مشخص می‌شود.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: ConsultPage,
});

function ConsultPage() {
  return <ConsultForm />;
}
