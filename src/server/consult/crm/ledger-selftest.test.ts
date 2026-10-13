import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConsultStore } from "../store";
import { maybeRunLedgerSelfTest, runLedgerSelfTest } from "./ledger-selftest";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "s2f-selftest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ledger filesystem self-test", () => {
  it("passes on a normal local filesystem, covers separate OS processes and leaves nothing behind", async () => {
    const r = await runLedgerSelfTest(dir);
    expect(r.checks.filter((c) => c.ok !== true)).toEqual([]);
    expect(r.ledgerFilesystemOk).toBe(true);
    expect(r.checks.some((c) => /separate OS processes/.test(c.name) && c.ok === true)).toBe(true);
    expect((await readdir(dir)).filter((n) => n.startsWith("_selftest-"))).toEqual([]);
  }, 60_000);

  it("reports failure (never a pass) when the directory is not usable", async () => {
    const r = await runLedgerSelfTest(join(dir, "file-not-dir", "x").replace(/x$/, "\0bad"));
    expect(r.ledgerFilesystemOk).toBe(false);
  });

  it("is opt-in: without the flag nothing is created; with it a result file and a worker line are written once", async () => {
    maybeRunLedgerSelfTest({}, join(dir, "off"));
    await new Promise((r) => setTimeout(r, 50));
    await expect(readdir(join(dir, "off"))).rejects.toThrow();
    createConsultStore({ SIX2FIT_LEDGER_SELFTEST: "1", SIX2FIT_CONSULT_LEDGER_DIR: join(dir, "on") }, dir);
    for (let i = 0; i < 100; i += 1) {
      if ((await readdir(join(dir, "on")).catch(() => [] as string[])).includes("selftest-result.json")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const result = JSON.parse(await readFile(join(dir, "on", "selftest-result.json"), "utf8"));
    expect(result.ledgerFilesystemOk).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|token|password/i);
    const lines = (await readFile(join(dir, "on", "worker-observations.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ pid: process.pid });
  }, 60_000);
});
