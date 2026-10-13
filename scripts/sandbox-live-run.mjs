#!/usr/bin/env node
/**
 * One-shot operator runner for the LIVE CA Dev Sandbox tests (src/server/consult/crm/live/sandbox.live.test.ts).
 * Contains no secrets. Usage:  node scripts/sandbox-live-run.mjs < input.json   (stdin JSON: clientId, clientSecret, code)
 *   - exchanges the grant code in memory (accounts.zoho.com), verifies the Sandbox identity (org zgid + API id + type,
 *     module id) with read-only calls, and only then runs the live tests in a child process whose ENVIRONMENT carries
 *     the credentials (never argv, never files). Nothing is stored; the refresh token dies with the process.
 *   - aborts without running tests if any identity check fails.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EXPECT = { zgid: "850673613", apiId: "6223361000000000684", module: "Consultation_Submissions", moduleId: "6223361000127040089", dc: "com" };
const say = (k, v) => console.log(String(k).padEnd(36), v);
const safeName = (s) => (typeof s === "string" && /^[A-Za-z0-9_.-]{1,48}$/.test(s) ? s : "(unrecognised)");

let input;
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { say("input", "FAIL: stdin must be JSON"); process.exit(2); }
const { clientId, clientSecret, code } = input;
if (!clientId || !clientSecret || !code) { say("input", "FAIL: missing value"); process.exit(2); }

const body = new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, client_secret: clientSecret, code });
let j = null, status = 0;
try {
  const r = await fetch(`https://accounts.zoho.${EXPECT.dc}/oauth/v2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  status = r.status; j = await r.json().catch(() => null);
} catch { say("OAuth exchange", "FAIL network"); process.exit(1); }
if (!j || j.error || !j.access_token || !j.refresh_token) { say("OAuth exchange", `FAIL http=${status} code=${j && j.error ? safeName(j.error) : "(none)"}`); process.exit(1); }
say("OAuth exchange", "Success");
say("Scopes in token response", j.scope || "(not listed)");
let u; try { u = new URL(j.api_domain); } catch { u = null; }
if (!u || u.protocol !== "https:" || !(u.host === `www.zohoapis.${EXPECT.dc}` || u.host === `sandbox.zohoapis.${EXPECT.dc}`)) { say("API domain", "FAIL unexpected"); process.exit(1); }
say("API domain returned", u.host);
const base = `https://sandbox.zohoapis.${EXPECT.dc}`;
const api = async (p) => { const r = await fetch(`${base}/crm/v8${p}`, { headers: { authorization: `Zoho-oauthtoken ${j.access_token}` } }); return { s: r.status, j: await r.json().catch(() => null) }; };
const o = await api("/org");
const org = o.j && Array.isArray(o.j.org) && o.j.org.length === 1 ? o.j.org[0] : null;
if (!org) { say("GET /org", `FAIL http=${o.s}`); process.exit(1); }
const identity = org.type === "sandbox" && String(org.zgid) === EXPECT.zgid && String(org.id) === EXPECT.apiId;
say("Org zgid / type / api id", `${org.zgid} / ${org.type} / ${org.id}`);
say("Identity", identity ? "VERIFIED" : "NOT VERIFIED");
if (!identity) { say("RESULT", "STOPPED before any write"); process.exit(1); }
const ml = await api("/settings/modules");
const hit = ml.j && Array.isArray(ml.j.modules) ? ml.j.modules.filter((x) => x.api_name === EXPECT.module) : [];
if (hit.length !== 1 || String(hit[0].id) !== EXPECT.moduleId) { say("Module", "NOT VERIFIED"); process.exit(1); }
say("Module", "verified");

const env = {
  ...process.env,
  SIX2FIT_LIVE_SANDBOX: "1",
  SIX2FIT_CONSULT_STORE: "crm",
  SIX2FIT_CONSULT_CRM_ENABLED: "true",
  SIX2FIT_ZOHO_ENVIRONMENT: "sandbox",
  SIX2FIT_ZOHO_ORG_ZGID: EXPECT.zgid,
  SIX2FIT_ZOHO_ORG_API_ID: EXPECT.apiId,
  SIX2FIT_ZOHO_API_DOMAIN: base,
  SIX2FIT_ZOHO_ACCOUNTS_DOMAIN: `https://accounts.zoho.${EXPECT.dc}`,
  SIX2FIT_ZOHO_MODULE_ID_PREFIX: "6223361000",
  SIX2FIT_ZOHO_CLIENT_ID: clientId,
  SIX2FIT_ZOHO_CLIENT_SECRET: clientSecret,
  SIX2FIT_ZOHO_REFRESH_TOKEN: j.refresh_token,
  SIX2FIT_ZOHO_TIMEOUT_MS: "20000",
};
say("Live tests", "starting (credentials only in the child environment)");
const res = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["vitest", "run", "src/server/consult/crm/live/sandbox.live.test.ts", "--reporter=verbose"], { env, stdio: "inherit", shell: process.platform === "win32" });
say("Live tests exit code", String(res.status));
process.exit(res.status ?? 1);
