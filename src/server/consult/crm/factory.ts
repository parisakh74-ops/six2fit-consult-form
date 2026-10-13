import { StoreError } from "../errors";
import type { ConsultStore } from "../store";
import { ZohoClient, type ClientDeps } from "./client";
import { loadCrmConfig } from "./config";
import { join } from "node:path";
import { CrmConsultStore } from "./crm-store";
import { IdempotencyLedger, LedgerConsultStore } from "./ledger";

/**
 * Builds the CRM store from environment variables. Pure configuration (no network): the first request
 * happens lazily on the first `get`/`create`, after the Sandbox verification. Throws `NOT_CONFIGURED`
 * unless CRM mode is explicitly enabled and fully, correctly configured (default: disabled).
 */
export function createCrmConsultStore(
  env: Record<string, string | undefined>,
  overrides: Partial<ClientDeps> & { log?: (event: string, fields: Record<string, string | number | boolean>) => void } = {},
): CrmConsultStore {
  const config = loadCrmConfig(env);
  const fetchImpl = overrides.fetch ?? (globalThis.fetch as unknown as ClientDeps["fetch"] | undefined);
  if (!fetchImpl) throw new StoreError("NOT_CONFIGURED", "crm store: fetch unavailable", "CRM_NOT_CONFIGURED");
  const deps: ClientDeps = {
    fetch: fetchImpl,
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
  const client = new ZohoClient(config, deps);
  return new CrmConsultStore({ client, config, now: deps.now, sleep: deps.sleep, ...(overrides.log ? { log: overrides.log } : {}) });
}

/**
 * The production composition: CRM writer behind the persistent idempotency ledger. `ledgerDir` must be a
 * persistent local directory outside any document root (default `<storage dir>/idempotency-ledger`).
 */
export function createLedgerCrmStore(
  env: Record<string, string | undefined>,
  storageDir: string,
  overrides: Parameters<typeof createCrmConsultStore>[1] = {},
): ConsultStore {
  const inner = createCrmConsultStore(env, overrides);
  const dir = (env["SIX2FIT_CONSULT_LEDGER_DIR"] ?? "").trim() || join(storageDir, "idempotency-ledger");
  const num = (k: string): number | undefined => {
    const v = Number(env[k]);
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const leaseMs = num("SIX2FIT_CONSULT_LEDGER_LEASE_MS");
  const quiesceMs = num("SIX2FIT_CONSULT_LEDGER_QUIESCE_MS");
  return new LedgerConsultStore(inner, new IdempotencyLedger(dir), {
    now: overrides.now ?? (() => Date.now()),
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    ...(overrides.log ? { log: overrides.log } : {}),
    ...(leaseMs ? { leaseMs } : {}),
    ...(quiesceMs ? { quiesceMs } : {}),
  });
}
