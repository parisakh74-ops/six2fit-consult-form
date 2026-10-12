import { StoreError } from "../errors";
import type { ConsultStore } from "../store";
import { ZohoClient, type ClientDeps } from "./client";
import { loadCrmConfig } from "./config";
import { CrmConsultStore } from "./crm-store";

/**
 * Builds the CRM store from environment variables. Pure configuration (no network): the first request
 * happens lazily on the first `get`/`create`, after the Sandbox verification. Throws `NOT_CONFIGURED`
 * unless CRM mode is explicitly enabled and fully, correctly configured (default: disabled).
 */
export function createCrmConsultStore(
  env: Record<string, string | undefined>,
  overrides: Partial<ClientDeps> & { log?: (event: string, fields: Record<string, string | number | boolean>) => void } = {},
): ConsultStore {
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
