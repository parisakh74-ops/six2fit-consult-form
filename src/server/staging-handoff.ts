import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type HandoffScope = "Diet" | "Training" | "Combo" | "CIP";

export type HandoffClaims = {
  v: 1;
  consult_submission_id: string;
  scope: HandoffScope;
  entitlements: string[];
  exp: number;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing staging configuration: ${name}`);
  return value;
}

export function stagingConfig() {
  if (required("SIX2FIT_STAGING_MODE") !== "true") {
    throw new Error("Staging handoff is disabled");
  }
  const secret = required("SIX2FIT_STAGING_TOKEN_SECRET");
  if (secret.length < 32) throw new Error("SIX2FIT_STAGING_TOKEN_SECRET must be at least 32 characters");
  const onboardingBaseUrl = new URL(required("ONBOARDING_STAGING_BASE_URL"));
  if (!onboardingBaseUrl.hostname.toLowerCase().includes("onboarding-staging")) {
    throw new Error("ONBOARDING_STAGING_BASE_URL must point to onboarding staging");
  }
  return {
    storageDir: required("SIX2FIT_STAGING_STORAGE_DIR"),
    secret,
    onboardingBaseUrl,
  };
}

export function payloadHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function scopeFromServices(services: unknown): HandoffScope {
  if (!Array.isArray(services)) return "Combo";
  if (services.includes("nutrition_training") || services.includes("not_sure")) return "Combo";
  const nutrition = services.includes("nutrition");
  const training = services.includes("training");
  if (nutrition && training) return "Combo";
  if (training) return "Training";
  if (nutrition) return "Diet";
  return "Combo";
}

export function signHandoff(claims: HandoffClaims, secret: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyHandoff(token: string, secret: string): HandoffClaims {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) throw new Error("Invalid handoff token");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    throw new Error("Invalid handoff signature");
  }
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as HandoffClaims;
  if (claims.v !== 1 || claims.exp <= Math.floor(Date.now() / 1000) || !claims.consult_submission_id) {
    throw new Error("Expired or invalid handoff token");
  }
  return claims;
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
