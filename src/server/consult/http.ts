import { DEFAULT_MAX_BODY_BYTES, errorResult, type ConsultResult } from "./contract";
import { createConsultService, type ConsultService } from "./service";
import { createConsultStore, StoreError } from "./store";
import { stagingConfig } from "../staging-handoff";

/**
 * Thin HTTP adapter shared by every entry point (Nitro middleware, TanStack server entry,
 * file route). It only matches the route, enforces the body limit, and maps the service
 * result to a Response. All business logic lives in `service.ts`.
 */

export const CONSULT_PATH = "/api/consult/submit";

export type RouteMatch = "submit" | "method_not_allowed" | null;

export function matchConsultRoute(request: Request): RouteMatch {
  const url = new URL(request.url);
  if (url.pathname === CONSULT_PATH) return request.method === "POST" ? "submit" : "method_not_allowed";
  // Passenger root dispatch: POST /?six2fit_api=consult (other methods are normal page loads)
  if (request.method === "POST" && url.searchParams.get("six2fit_api") === "consult") return "submit";
  return null;
}

function toResponse(result: ConsultResult): Response {
  const init: ResponseInit = { status: result.status };
  if (result.headers) init.headers = result.headers;
  return Response.json(result.body, init);
}

/** Reads the body as text and aborts as soon as the limit is exceeded. */
export async function readLimitedText(request: Request, limit: number): Promise<string | "TOO_LARGE"> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return "TOO_LARGE";
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return "TOO_LARGE";
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
}

type Runtime = { service: ConsultService; maxBodyBytes: number };

/** Builds the service from server-only environment variables (never from the browser). */
export function runtimeFromEnv(env: Record<string, string | undefined> = process.env): Runtime {
  const config = stagingConfig();
  const store = createConsultStore(env, config.storageDir);
  const parsedLimit = Number(env["SIX2FIT_CONSULT_MAX_BODY_BYTES"]);
  const maxBodyBytes = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_MAX_BODY_BYTES;
  const service = createConsultService({
    store,
    tokenSecret: config.secret,
    onboardingBaseUrl: config.onboardingBaseUrl,
    maxBodyBytes,
    log: (event, fields) => console.info(JSON.stringify({ event, ...fields })),
  });
  return { service, maxBodyBytes };
}

type Deps = { runtime?: () => Runtime };

// One handler execution per Request object, even if two entry points were ever chained.
const HANDLED_KEY = Symbol.for("six2fit.consult.handled");
type HandledMap = WeakMap<Request, Promise<ConsultResult>>;
const handled: HandledMap = ((globalThis as Record<symbol, unknown>)[HANDLED_KEY] ??= new WeakMap()) as HandledMap;

async function execute(request: Request, match: "submit" | "method_not_allowed", deps: Deps): Promise<ConsultResult> {
  if (match === "method_not_allowed") return errorResult("METHOD_NOT_ALLOWED", { headers: { allow: "POST" } });

  // Explicit staging-only safety guard. This is NOT authentication.
  if (!new URL(request.url).hostname.toLowerCase().includes("consult-staging")) return errorResult("STAGING_ONLY");

  let runtime: Runtime;
  try {
    runtime = (deps.runtime ?? runtimeFromEnv)();
  } catch (error) {
    console.error(JSON.stringify({ event: "consult.config_unavailable", kind: error instanceof StoreError ? error.kind : "CONFIG" }));
    return errorResult("STAGING_UNAVAILABLE");
  }
  const body = await readLimitedText(request, runtime.maxBodyBytes);
  if (body === "TOO_LARGE") return errorResult("PAYLOAD_TOO_LARGE");
  return runtime.service.submit({
    contentType: request.headers.get("content-type"),
    idempotencyKey: request.headers.get("idempotency-key"),
    body,
  });
}

/**
 * Entry-point dispatcher. Returns `null` when the request is not for the consult API so the
 * caller can continue with the normal application; otherwise returns the final Response.
 */
export async function dispatchConsultRequest(request: Request, deps: Deps = {}): Promise<Response | null> {
  const match = matchConsultRoute(request);
  if (!match) return null;
  let pending = handled.get(request);
  if (!pending) {
    pending = execute(request, match, deps);
    handled.set(request, pending);
  }
  return toResponse(await pending);
}

/** Legacy export name used by the route file, `src/server.ts` and the Nitro middleware. */
export async function handleConsultSubmission(request: Request): Promise<Response> {
  return (await dispatchConsultRequest(request)) ?? errorResult404();
}

function errorResult404(): Response {
  return Response.json({ ok: false, error_code: "METHOD_NOT_ALLOWED" }, { status: 405, headers: { allow: "POST" } });
}
