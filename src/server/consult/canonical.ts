import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted recursively, arrays keep their order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * Fields excluded from the idempotency fingerprint. The browser rebuilds the payload on
 * every attempt and `submitted_at` is the client clock, so a technical retry carries the
 * same answers with a different timestamp. The first accepted value is kept in the record.
 */
const VOLATILE_KEYS = ["submitted_at"] as const;

export function fingerprint(payload: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...payload };
  for (const key of VOLATILE_KEYS) delete copy[key];
  return createHash("sha256").update(canonicalJson(copy)).digest("hex");
}

/** Hash used by the legacy file route (key-order dependent, includes submitted_at). */
export function legacyPayloadHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
