import { handleConsultSubmission } from "../../src/routes/api/consult/submit";

export default async function six2fitApiMiddleware(event: {
  req: Request;
  url: URL;
}) {
  const action = event.url.searchParams.get("six2fit_api");
  const isSubmission = event.req.method === "POST" && (
    event.url.pathname === "/api/consult/submit" || action === "consult"
  );

  if (!isSubmission) return;
  return handleConsultSubmission(event.req);
}
