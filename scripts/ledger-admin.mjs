#!/usr/bin/env node
/**
 * Operator tool for the idempotency ledger (no CRM access, no secrets, no answers: ids, states, timestamps only).
 *   node --experimental-transform-types --no-warnings scripts/ledger-admin.mjs list    <ledgerDir>
 *   node ... show    <ledgerDir> <submissionId>
 *   node ... resolve <ledgerDir> <submissionId> created  <crmRecordId> "<evidence note>"
 *   node ... resolve <ledgerDir> <submissionId> released "<evidence note>" --i-verified-absence-in-crm
 * `resolve` only settles entries that automation must not settle (unknown / needs_review / dead writer after a POST
 * may have started). `released` allows a fresh write: use it only after verifying in the CRM, by an authoritative view
 * and well after the index lag, that no record exists, and accept that a late commit of the first request is possible.
 */
import { readdir } from "node:fs/promises";
import { register } from "node:module";
register("../src/server/consult/crm/testing/ts-hooks.mjs", import.meta.url);
const { IdempotencyLedger, resolveManually } = await import("../src/server/consult/crm/ledger.ts");

const [cmd, dir, id, decision, a, b] = process.argv.slice(2);
const flag = process.argv.includes("--i-verified-absence-in-crm");
const show = (e) => console.log(JSON.stringify({ id: e.id, gen: e.gen, state: e.state, phase: e.phase, attempts: e.attempts, updated: new Date(e.updated).toISOString(), crm_id: e.crm_id, code: e.code, manual: e.manual, note: e.note }));
if (!dir) { console.error("usage: see header"); process.exit(2); }
const ledger = new IdempotencyLedger(dir);
try {
  if (cmd === "list") {
    for (const name of await readdir(dir)) {
      const e = await ledger.current(name).catch(() => null);
      if (e && (e.state === "unknown" || e.state === "needs_review" || e.state === "integrity" || e.state === "in_progress")) show(e);
    }
  } else if (cmd === "show" && id) {
    const e = await ledger.current(id);
    if (e) show(e); else console.log("no entry");
  } else if (cmd === "resolve" && id && decision === "created" && a && b) {
    show(await resolveManually(ledger, id, { decision: "created", crmRecordId: a, note: b }, Date.now()));
  } else if (cmd === "resolve" && id && decision === "released" && a) {
    if (!flag) { console.error("refused: pass --i-verified-absence-in-crm"); process.exit(2); }
    show(await resolveManually(ledger, id, { decision: "released", note: a }, Date.now()));
  } else { console.error("usage: see header"); process.exit(2); }
} catch (e) {
  console.error("failed:", e && e.code ? e.code : "error", e && e.message ? e.message : "");
  process.exit(1);
}
