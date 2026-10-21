// @vitest-environment node
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { loadPrivateEnv } = createRequire(import.meta.url)("../../load-private-env.cjs") as {
  loadPrivateEnv: (o: { env: Record<string, string | undefined>; log: (m: string) => void; appDir: string; home?: string }) => boolean;
};

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "s2f-penv-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });
const SECRET = "synthetic-secret-value-123";
const body = `SIX2FIT_ZOHO_CLIENT_ID=cid\nSIX2FIT_ZOHO_CLIENT_SECRET=${SECRET}\nSIX2FIT_ZOHO_REFRESH_TOKEN=rt\nSIX2FIT_ZOHO_ENVIRONMENT=production\nOTHER=x\n`;
function setup(content = body) {
  const app = tmp(), priv = tmp();
  const file = join(priv, "consult.env");
  writeFileSync(file, content);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  const logs: string[] = [];
  return { app, file, logs, log: (m: string) => logs.push(m) };
}

describe("private env loader", () => {
  it("loads only the three OAuth variables, never logs a value, and ignores every other key", () => {
    const s = setup();
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file, SIX2FIT_ZOHO_ENVIRONMENT: "sandbox" };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(true);
    expect(env["SIX2FIT_ZOHO_CLIENT_SECRET"]).toBe(SECRET);
    expect(env["SIX2FIT_ZOHO_ENVIRONMENT"]).toBe("sandbox"); // not overridable from the file
    expect(env["OTHER"]).toBeUndefined();
    expect(s.logs.join("\n")).not.toContain(SECRET);
  });
  it("never overrides a variable that is already set", () => {
    const s = setup();
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file, SIX2FIT_ZOHO_CLIENT_ID: "existing" };
    loadPrivateEnv({ env, log: s.log, appDir: s.app });
    expect(env["SIX2FIT_ZOHO_CLIENT_ID"]).toBe("existing");
  });
  it("a missing file is not fatal and loads nothing", () => {
    const s = setup();
    const env: Record<string, string | undefined> = {};
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app, home: s.app })).toBe(false);
    expect(env["SIX2FIT_ZOHO_REFRESH_TOKEN"]).toBeUndefined();
  });
  it("refuses a relative path and a file inside the application directory", () => {
    const s = setup();
    expect(loadPrivateEnv({ env: { S2F_PRIVATE_ENV_FILE: "relative.env" }, log: s.log, appDir: s.app })).toBe(false);
    const inside = join(s.app, "secret.env");
    writeFileSync(inside, body);
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: inside };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(false);
    expect(env["SIX2FIT_ZOHO_CLIENT_SECRET"]).toBeUndefined();
  });
  it.skipIf(process.platform === "win32")("refuses a file readable by group or others", () => {
    const s = setup();
    chmodSync(s.file, 0o644);
    const env: Record<string, string | undefined> = { S2F_PRIVATE_ENV_FILE: s.file };
    expect(loadPrivateEnv({ env, log: s.log, appDir: s.app })).toBe(false);
    expect(env["SIX2FIT_ZOHO_CLIENT_SECRET"]).toBeUndefined();
  });
});
