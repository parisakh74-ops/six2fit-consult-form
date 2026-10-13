// Test support: a separate OS process that tries to claim generation 1 of a ledger entry. Prints "WON" or "LOST".
import { register } from "node:module";
register("./ts-hooks.mjs", import.meta.url);
const { IdempotencyLedger } = await import("../ledger.ts");
const [dir, id, delayMs] = process.argv.slice(2);
const ledger = new IdempotencyLedger(dir);
await new Promise((r) => setTimeout(r, Number(delayMs)));
const now = Date.now();
const won = await ledger.claim({ v: 1, id, gen: 1, fp: "f".repeat(64), state: "in_progress", attempts: 1, started: now, updated: now });
console.log(won ? "WON" : "LOST");
