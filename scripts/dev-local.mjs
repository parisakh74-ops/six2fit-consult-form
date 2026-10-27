// Local development server for the consultation form WITHOUT any CRM: `npm run dev:local`.
//
// The consult API only answers allow-listed hosts (SIX2FIT_CONSULT_ALLOWED_HOSTS) and needs the staging switch plus a storage directory.
// Without them every submit is refused with 403 STAGING_ONLY and the form shows the generic "ثبت درخواست انجام نشد" message.
// This script sets exactly those variables for localhost, forces the local FILE store (records go to a temp folder, never to Zoho) and
// clears every CRM variable, so a local submission can never reach Zoho Sandbox or Production.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = process.env.PORT || "8080";
const storageDir = process.env.SIX2FIT_STAGING_STORAGE_DIR || join(tmpdir(), "six2fit-consult-local");
mkdirSync(storageDir, { recursive: true });

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("SIX2FIT_ZOHO_") || key.startsWith("SIX2FIT_CONSULT_CRM_")) delete env[key];
}
Object.assign(env, {
  SIX2FIT_STAGING_MODE: "true",
  SIX2FIT_STAGING_STORAGE_DIR: storageDir,
  SIX2FIT_CONSULT_STORE: "file",
  SIX2FIT_CONSULT_ALLOWED_HOSTS: "localhost,127.0.0.1",
  VITE_CONSULT_SUBMIT_PATH: "/api/consult/submit",
});

console.log(`consult dev (file store, no CRM): http://localhost:${port}/  storage: ${storageDir}`);
const child = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "dev", "--host", "localhost", "--port", port, "--strictPort"], {
  stdio: "inherit",
  env,
});
child.on("exit", (code) => process.exit(code ?? 0));
