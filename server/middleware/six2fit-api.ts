import { dispatchConsultRequest } from "../../src/server/consult/http";

/**
 * Nitro middleware entry point for the consult API (Production-mode requests).
 * It only delegates to the shared dispatcher; returning a Response ends the request chain,
 * returning nothing lets the normal application continue. Do not add business logic here.
 */
export default async function six2fitApiMiddleware(event: { req: Request; url: URL }) {
  const response = await dispatchConsultRequest(event.req);
  if (response) return response;
}
