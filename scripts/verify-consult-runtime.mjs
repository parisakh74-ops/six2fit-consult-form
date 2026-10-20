#!/usr/bin/env node
/**
 * Runtime verification of POST /api/consult/submit against a BUILT Nitro server or `vite dev`.
 * Local, isolated, synthetic data only: random secret, throw-away storage dir, 127.0.0.1.
 *
 *   CONSULT_FIXTURE_OUT=<dir> npx vitest run src/server/consult/runtime-fixtures.test.ts
 *   node scripts/verify-consult-runtime.mjs prod <repoDir> <fixtureDir> [port]   # .output/server/index.mjs
 *   node scripts/verify-consult-runtime.mjs dev  <repoDir> <fixtureDir> [port]   # vite dev
 *
 * It counts how many times the service tried to persist (temp-file writes) per request and
 * records which bundled file executed it, to prove that exactly one handler ran per request.
 * Never point it at a deployed environment.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const [, , mode, repoDir, fixtureDir, port = "3121"] = process.argv;
if (!["prod", "dev"].includes(mode) || !repoDir || !fixtureDir) {
  console.error("usage: verify-consult-runtime.mjs <prod|dev> <repoDir> <fixtureDir> [port]");
  process.exit(2);
}
const fixtures = JSON.parse(readFileSync(join(fixtureDir, "fixtures.json"), "utf8"));
const work = mkdtempSync(join(tmpdir(), `consult-rt-${mode}-`));
const store = join(work, "store");
const trace = join(work, "trace.jsonl");
const preload = join(work, "trace-preload.mjs");
writeFileSync(
  preload,
  `import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";
const original = fsp.writeFile;
fsp.writeFile = async function (...args) {
  const target = String(args[0]);
  if (target.endsWith(".tmp") && target.includes("consult")) {
    const frames = new Error().stack.split("\\n").filter((l) => /\\.output[\\\\/]server|server[\\\\/]consult|src[\\\\/]server\\.ts|six2fit-api/i.test(l)).map((l) => l.trim()).slice(0, 8);
    appendFileSync(process.env.TRACE_FILE, JSON.stringify({ frames }) + "\\n");
  }
  return original.apply(this, args);
};
syncBuiltinESMExports();
`,
);
const env = {
  ...process.env,
  PORT: port,
  HOST: "127.0.0.1",
  SIX2FIT_STAGING_MODE: "true",
  SIX2FIT_STAGING_STORAGE_DIR: store,
  TRACE_FILE: trace,
  NODE_OPTIONS: `--import=file:///${preload.replace(/\\/g, "/")}`,
};
const args =
  mode === "prod"
    ? [join(repoDir, ".output", "server", "index.mjs")]
    : [join(repoDir, "node_modules", "vite", "bin", "vite.js"), "dev", "--mode", "staging", "--port", port, "--host", "127.0.0.1"];
const child = spawn(process.execPath, args, { cwd: repoDir, env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));

const host = mode === "dev" ? "consult-staging.localhost" : "consult-staging.test";
function request({ method = "POST", path = "/api/consult/submit", hostHeader = host, body, headers = {} }) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { host: hostHeader, ...(data !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => resolve({ status: res.statusCode, ct: (res.headers["content-type"] || "").split(";")[0], allow: res.headers.allow, body: b }));
      },
    );
    req.setTimeout(30000, () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ error: e.code || e.message }));
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function up() {
  for (let i = 0; i < 200; i++) {
    const r = await request({ method: "GET", path: "/robots.txt" });
    if (!r.error) return true;
    await wait(250);
  }
  return false;
}
const key = (p) => ({ "idempotency-key": p.submission_id });
const brief = (r) => ({ status: r.status, ct: r.ct, error_code: safe(r.body)?.error_code, deduplicated: safe(r.body)?.deduplicated, ok: safe(r.body)?.ok, keys: safe(r.body) ? Object.keys(safe(r.body)).sort().join(",") : undefined, allow: r.allow, err: r.error });
function safe(b) {
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
}

const results = { mode, started: await up(), tests: {} };
const T = results.tests;
if (results.started) {
  const f = fixtures;
  T.t01_valid = brief(await request({ body: f.valid, headers: key(f.valid) }));
  T.t02_retry_new_timestamp = brief(await request({ body: { ...f.valid, submitted_at: new Date().toISOString() }, headers: key(f.valid) }));
  T.t03_conflict_same_id = brief(await request({ body: f.conflicting_same_id, headers: key(f.conflicting_same_id) }));
  T.t04_modules_payload = brief(await request({ body: f.with_modules, headers: key(f.with_modules) }));
  const conc = await Promise.all([1, 2, 3, 4, 5].map(() => request({ body: f.concurrent_identical, headers: key(f.concurrent_identical) })));
  T.t05_concurrent_statuses = conc.map((r) => r.status).sort();
  T.t05_concurrent_fresh_count = conc.filter((r) => safe(r.body)?.deduplicated === false).length;
  T.t06_query_fallback = brief(await request({ path: "/?six2fit_api=consult", body: f.query_fallback, headers: key(f.query_fallback) }));
  T.t07_invalid_json = brief(await request({ body: "{oops", headers: key(f.valid) }));
  T.t08_old_version = brief(await request({ body: f.old_version, headers: key(f.old_version) }));
  T.t09_unexpected_key = brief(await request({ body: f.unexpected_key, headers: key(f.unexpected_key) }));
  T.t10_outcome_mismatch = brief(await request({ body: f.outcome_mismatch, headers: key(f.outcome_mismatch) }));
  T.t11_inactive_module = brief(await request({ body: f.inactive_module, headers: key(f.inactive_module) }));
  T.t12_wrong_content_type = brief(await request({ body: JSON.stringify(f.valid), headers: { ...key(f.valid), "content-type": "text/plain" } }));
  T.t13_oversized = brief(await request({ body: JSON.stringify({ pad: "x".repeat(200 * 1024) }), headers: key(f.valid) }));
  T.t14_get_method = brief(await request({ method: "GET" }));
  T.t15_put_method = brief(await request({ method: "PUT", body: "{}" }));
  T.t16_wrong_host = brief(await request({ hostHeader: "evil.example", body: f.valid, headers: key(f.valid) }));
  const home = await request({ method: "GET", path: "/" });
  T.t17_app_home = { status: home.status, ct: home.ct };
  const getQuery = await request({ method: "GET", path: "/?six2fit_api=consult" });
  T.t18_get_query_is_app_page = { status: getQuery.status, ct: getQuery.ct };
}
await wait(300);
child.kill();
await wait(500);
const lines = existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
results.persist_attempts = lines.length; // expected: 1 (t01) + 1 (t04) + 5 (t05) + 1 (t06) = 8 -> one per create attempt, no double execution
results.expected_persist_attempts = 8;
results.dispatcher_files = [...new Set(lines.map((l) => (l.frames.find((x) => /six2fit-api|src[\\/]server\.ts|\.output|routes[\\/]api/i.test(x)) || l.frames[0] || "?").replace(/\(?[A-Za-z]:[^)]*?[\\/](\.output[\\/][^):]+|src[\\/][^):]+|server[\\/][^):]+)[^)]*\)?/, "$1").slice(0, 120)))];
results.files = existsSync(join(store, "consult")) ? readdirSync(join(store, "consult")).filter((n) => n.endsWith(".json")).length : 0;
results.leftover_tmp = existsSync(join(store, "consult")) ? readdirSync(join(store, "consult")).filter((n) => n.endsWith(".tmp")).length : 0;
results.server_log_events = log.split("\n").filter((l) => l.startsWith("{") && l.includes('"event"')).map((l) => safe(l)?.event).filter(Boolean).length;
results.log_contains_sensitive = /Synthetic Tester|synthetic@example\.test|4165550100|session=/.test(log);
rmSync(work, { recursive: true, force: true });
console.log(JSON.stringify(results, null, 1));
