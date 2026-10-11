import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";
import {
  claimOnce,
  ensureStorage,
  payloadHash,
  readJson,
  scopeFromServices,
  signHandoff,
  stagingConfig,
  writeJsonAtomic,
} from "@/server/staging-handoff";

type StoredConsult = {
  payload_hash: string;
  payload: Record<string, unknown>;
  crm_record_id: string;
  onboarding_url: string;
  created_at: string;
};

const ID = /^cns_[0-9a-f-]{20,80}$/i;

export const Route = createFileRoute("/api/consult/submit")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (!new URL(request.url).hostname.toLowerCase().includes("consult-staging")) {
            return Response.json({ error_code: "STAGING_ONLY" }, { status: 403 });
          }
          const config = stagingConfig();
          const payload = await request.json() as Record<string, unknown>;
          const submissionId = typeof payload["submission_id"] === "string" ? payload["submission_id"] : "";
          const idempotencyKey = request.headers.get("idempotency-key") ?? "";
          if (!ID.test(submissionId) || idempotencyKey !== submissionId || typeof payload["whatsapp_phone_normalized"] !== "string") {
            return Response.json({ error_code: "INVALID_PAYLOAD" }, { status: 400 });
          }

          await ensureStorage(config.storageDir);
          const hash = payloadHash(payload);
          const recordPath = join(config.storageDir, "consult", `${submissionId}.json`);
          const claimPath = join(config.storageDir, "claims", `consult-${submissionId}`);
          const existing = await readJson<StoredConsult>(recordPath);
          if (existing) {
            if (existing.payload_hash !== hash) return Response.json({ error_code: "SUBMISSION_CONFLICT" }, { status: 409 });
            return Response.json({ ok: true, crm_record_id: existing.crm_record_id, deduplicated: true, onboarding_url: existing.onboarding_url });
          }
          if (!await claimOnce(claimPath, { hash, created_at: new Date().toISOString() })) {
            return Response.json({ error_code: "SUBMISSION_IN_PROGRESS" }, { status: 409 });
          }

          const scope = scopeFromServices(payload["service_interest"]);
          const claims = {
            v: 1 as const,
            consult_submission_id: submissionId,
            scope,
            entitlements: [] as string[],
            exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
          };
          const token = signHandoff(claims, config.secret);
          const onboardingUrl = new URL(config.onboardingBaseUrl);
          onboardingUrl.searchParams.set("session", token);
          const crmRecordId = `staging_${submissionId}`;
          const record: StoredConsult = {
            payload_hash: hash,
            payload,
            crm_record_id: crmRecordId,
            onboarding_url: onboardingUrl.toString(),
            created_at: new Date().toISOString(),
          };
          await writeJsonAtomic(recordPath, record);
          return Response.json({ ok: true, crm_record_id: crmRecordId, deduplicated: false, onboarding_url: record.onboarding_url });
        } catch (error) {
          console.error("Consult staging submission failed", error instanceof Error ? error.message : "Unknown error");
          return Response.json({ error_code: "STAGING_UNAVAILABLE" }, { status: 503 });
        }
      },
    },
  },
});
