import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing staging configuration: ${name}`);
  return value;
}

/**
 * O1: the Consultation backend has NO connection to Onboarding any more: it holds no signing secret, no Onboarding URL and
 * mints no token. Configuration is only the staging switch and the local storage directory (development only).
 */
export function stagingConfig() {
  if (required("SIX2FIT_STAGING_MODE") !== "true") {
    throw new Error("Staging handoff is disabled");
  }
  return { storageDir: required("SIX2FIT_STAGING_STORAGE_DIR") };
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function ensureStorage(storageDir: string) {
  await mkdir(join(storageDir, "consult"), { recursive: true });
  await mkdir(join(storageDir, "claims"), { recursive: true });
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function claimOnce(path: string, value: unknown): Promise<boolean> {
  try {
    const handle = await open(path, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}
