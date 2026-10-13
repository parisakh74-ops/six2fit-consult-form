import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Self-test of the filesystem properties the idempotency ledger relies on (see ledger.ts), for hosts without shell
 * access. It only touches a private scratch directory `<ledgerDir>/_selftest-<random>` that it removes afterwards;
 * it never reads or writes real ledger entries, the CRM, secrets or answers. The result is plain JSON.
 *
 * Checks: (1) `link` creates an exclusive name and refuses a second link (EEXIST); (2) concurrent in-process claims
 * have exactly one winner; (3) several real OS processes claiming the same name have exactly one winner;
 * (4) rename-over replaces a file atomically (a concurrent reader never sees a partial or missing file);
 * (5) the directory is writable and temp files can be removed.
 */

export type SelfTestCheck = { name: string; ok: boolean | null; detail?: string };
export type SelfTestResult = {
  v: 1;
  at: string;
  node: string;
  platform: string;
  pid: number;
  ppid: number;
  dir: string;
  checks: SelfTestCheck[];
  /** true only when every check passed; null checks (could not be tested) make this false. */
  ledgerFilesystemOk: boolean;
};

const errCode = (e: unknown) => (typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "ERR");

const CHILD = `
const fs=require('node:fs');const [t,d,delay]=process.argv.slice(1);
setTimeout(()=>{fs.link(t,d,(e)=>{process.stdout.write(e?('LOST:'+(e.code||'ERR')):'WON');});},Number(delay));
`;

function claimInChild(temp: string, dest: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", CHILD, temp, dest, "120"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve("TIMEOUT");
    }, 15_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve("SPAWN_FAILED");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out || "NO_OUTPUT");
    });
  });
}

export async function runLedgerSelfTest(ledgerDir: string, processes = 4): Promise<SelfTestResult> {
  const checks: SelfTestCheck[] = [];
  const scratch = join(ledgerDir, `_selftest-${randomBytes(6).toString("hex")}`);
  const add = (name: string, ok: boolean | null, detail?: string) => checks.push({ name, ok, ...(detail ? { detail } : {}) });
  try {
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    add("directory writable", true);

    // 1. exclusive link
    try {
      const t = join(scratch, "t1.tmp");
      await writeFile(t, "a", { flag: "wx", mode: 0o600 });
      await link(t, join(scratch, "g1.json"));
      let second = "linked";
      try {
        await link(t, join(scratch, "g1.json"));
      } catch (e) {
        second = errCode(e);
      }
      add("hard link: first link succeeds", true);
      add("hard link: second link to the same name is refused (EEXIST)", second === "EEXIST", `got ${second}`);
    } catch (e) {
      add("hard link: first link succeeds", false, errCode(e));
    }

    // 2. in-process concurrent claims
    try {
      const t = join(scratch, "t2.tmp");
      await writeFile(t, "b", { flag: "wx", mode: 0o600 });
      const dest = join(scratch, "g2.json");
      const results = await Promise.all(Array.from({ length: 16 }, () => link(t, dest).then(() => true, () => false)));
      const winners = results.filter(Boolean).length;
      add("concurrent in-process claims: exactly one winner", winners === 1, `${winners} winners of 16`);
    } catch (e) {
      add("concurrent in-process claims: exactly one winner", false, errCode(e));
    }

    // 3. several OS processes
    try {
      const t = join(scratch, "t3.tmp");
      await writeFile(t, "c", { flag: "wx", mode: 0o600 });
      const dest = join(scratch, "g3.json");
      const out = await Promise.all(Array.from({ length: processes }, () => claimInChild(t, dest)));
      const winners = out.filter((o) => o === "WON").length;
      const lost = out.filter((o) => o === "LOST:EEXIST").length;
      const untestable = out.some((o) => o === "SPAWN_FAILED" || o === "TIMEOUT" || o === "NO_OUTPUT");
      add("concurrent claims from separate OS processes: exactly one winner", untestable ? null : winners === 1 && lost === processes - 1, `${winners} winners, ${lost} EEXIST, of ${processes}${untestable ? " (child processes could not run: untestable)" : ""}`);
    } catch (e) {
      add("concurrent claims from separate OS processes: exactly one winner", null, errCode(e));
    }

    // 4. atomic rename-over under a concurrent reader
    try {
      const target = join(scratch, "g4.json");
      await writeFile(target, JSON.stringify({ n: 0 }));
      let bad = 0;
      let stop = false;
      const reader = (async () => {
        while (!stop) {
          try {
            JSON.parse(await readFile(target, "utf8"));
          } catch {
            bad += 1;
          }
        }
      })();
      for (let i = 1; i <= 150; i += 1) {
        const tmp = join(scratch, `t4-${i}.tmp`);
        await writeFile(tmp, JSON.stringify({ n: i }), { flag: "wx" });
        for (let tries = 0; ; tries += 1) {
          try {
            await rename(tmp, target);
            break;
          } catch (e) {
            if (tries >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(errCode(e))) throw e;
            await new Promise((r) => setTimeout(r, 5));
          }
        }
      }
      stop = true;
      await reader;
      add("rename-over is atomic for a concurrent reader (150 swaps)", bad === 0, `${bad} unreadable reads`);
    } catch (e) {
      add("rename-over is atomic for a concurrent reader (150 swaps)", false, errCode(e));
    }
  } catch (e) {
    add("directory writable", false, errCode(e));
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
      const left = (await readdir(ledgerDir)).filter((n) => n.startsWith("_selftest-")).length;
      add("scratch directory removed", left === 0);
    } catch (e) {
      add("scratch directory removed", false, errCode(e));
    }
  }
  return {
    v: 1,
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    pid: process.pid,
    ppid: process.ppid,
    dir: ledgerDir,
    checks,
    ledgerFilesystemOk: checks.every((c) => c.ok === true),
  };
}

let started = false;

/**
 * Opt-in (`SIX2FIT_LEDGER_SELFTEST=1`), once per process, fire-and-forget: runs the self-test, writes
 * `<ledgerDir>/selftest-result.json` (overwritten) and appends one line per observed process to
 * `<ledgerDir>/worker-observations.jsonl` (pid, ppid, time) so the number of worker processes the host really uses can
 * be seen by sending a few requests. No network, no secrets, never throws into the request path.
 */
export function maybeRunLedgerSelfTest(env: Record<string, string | undefined>, ledgerDir: string): void {
  if (started || env["SIX2FIT_LEDGER_SELFTEST"] !== "1") return;
  started = true;
  void (async () => {
    try {
      await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
      await appendFile(join(ledgerDir, "worker-observations.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ppid: process.ppid, node: process.version })}\n`);
      const result = await runLedgerSelfTest(ledgerDir);
      await writeFile(join(ledgerDir, "selftest-result.json"), JSON.stringify(result, null, 2));
    } catch {
      /* diagnostics only */
    }
  })();
}
