import { createFileRoute } from "@tanstack/react-router";
import { handleConsultSubmission } from "@/server/consult/http";

// Third (file-route) entry point kept for compatibility; it only delegates to the shared
// dispatcher. The business logic is src/server/consult/service.ts.
export { handleConsultSubmission };

export const Route = createFileRoute("/api/consult/submit")({
  server: {
    handlers: {
      POST: ({ request }) => handleConsultSubmission(request),
    },
  },
});
