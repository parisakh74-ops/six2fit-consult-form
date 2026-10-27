import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Signed Lead reference for the NEW Consultation link (`?lr=<token>`), minted by a CRM function for ONE existing Lead.
 *
 *   v1.<base64url(JSON claims)>.<base64url HMAC-SHA256 over "v1." + base64url(JSON claims), no padding>
 *
 * The signature is base64url because the Zoho Deluge helper `zoho.encryption.hmacsha256` returns BASE64 (verified in the Sandbox,
 * 2026-10-24); a CRM function converts it with three string replacements, no crypto of its own.
 *
 * Claims: `{ p: "consult-lead", lead: "<digits>", exp: <unix seconds>, jti: "<8-64 chars>" }`.
 *
 * Why: a plain Lead id in a public link would let anyone attach a submission to any Lead. The reference is verified with a
 * secret that is separate from every other secret (`SIX2FIT_CONSULT_LEAD_REF_SECRET`), expires, is bound to the purpose
 * `consult-lead`, and carries no personal data. The customer never sees or edits it; the server NEVER trusts a Lead id from
 * the request body. An invalid or expired reference never blocks the customer's submission: it only means "no Lead link".
 */
export type LeadRefResult =
  | { state: "valid"; leadId: string; jti: string; exp: number }
  | { state: "expired" }
  | { state: "invalid" };

const LEAD_ID = /^\d{6,25}$/;
const TOKEN = /^v1\.([A-Za-z0-9_-]{10,2000})\.([A-Za-z0-9_-]{43})$/;
export const MIN_LEAD_REF_SECRET_CHARS = 32;

const b64u = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const mac = (secret: string, signed: string): string => createHmac("sha256", secret).update(signed).digest("base64url");

export function signLeadRef(input: { leadId: string; secret: string; nowSeconds: number; ttlSeconds: number; jti: string }): string {
  if (input.secret.length < MIN_LEAD_REF_SECRET_CHARS) throw new Error("LEAD_REF_SECRET_TOO_SHORT");
  if (!LEAD_ID.test(input.leadId)) throw new Error("LEAD_ID_INVALID");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(input.jti)) throw new Error("JTI_INVALID");
  const claims = { p: "consult-lead", lead: input.leadId, exp: input.nowSeconds + input.ttlSeconds, jti: input.jti };
  const signed = `v1.${b64u(JSON.stringify(claims))}`;
  return `${signed}.${mac(input.secret, signed)}`;
}

export function verifyLeadRef(token: string, secret: string, nowMs: number): LeadRefResult {
  if (secret.length < MIN_LEAD_REF_SECRET_CHARS) return { state: "invalid" };
  const m = TOKEN.exec(token);
  if (!m) return { state: "invalid" };
  const signed = `v1.${m[1]}`;
  const expected = Buffer.from(mac(secret, signed), "utf8");
  const received = Buffer.from(m[2] as string, "utf8");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return { state: "invalid" };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(m[1] as string, "base64url").toString("utf8"));
  } catch {
    return { state: "invalid" };
  }
  if (typeof claims !== "object" || claims === null) return { state: "invalid" };
  const c = claims as Record<string, unknown>;
  if (c["p"] !== "consult-lead" || typeof c["lead"] !== "string" || !LEAD_ID.test(c["lead"]) || typeof c["exp"] !== "number" || !Number.isFinite(c["exp"]) || typeof c["jti"] !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(c["jti"])) {
    return { state: "invalid" };
  }
  if (c["exp"] * 1000 <= nowMs) return { state: "expired" };
  return { state: "valid", leadId: c["lead"], jti: c["jti"], exp: c["exp"] };
}
