/* eslint-disable @typescript-eslint/no-explicit-any -- negative-test helper mutates arbitrary JSON */
/** Test helpers: SYNTHETIC data only. Payloads are produced by the real frontend builder. */
import { sportModules } from "../../features/consult/assessmentConfig";
import { buildPayload } from "../../features/consult/crm";
import type { ConsultAnswers, ConsultPayload, ModuleAnswer } from "../../features/consult/types";
import type { ConsultStore, CreateResult, StoredConsult } from "./store";

export const MODULE_KEYS = sportModules.map((m) => m.key);
export const FIRST_FLAG: Record<string, string> = Object.fromEntries(
  sportModules.map((m) => [m.key, m.hardRedFlags[0]?.value ?? ""]),
);

export const answers = (over: Partial<ConsultAnswers> = {}): ConsultAnswers =>
  ({
    lead_full_name: "Synthetic Tester",
    whatsapp_country: "CA",
    whatsapp_dial_code: "+1",
    whatsapp_phone: "4165550100",
    consult_channel: "whatsapp_chat",
    email: "synthetic@example.test",
    primary_goal: ["fat_loss"],
    adherence_barrier: [],
    age: 30,
    height_cm: 170,
    weight_kg: 70,
    sex: "female",
    service_interest: ["training"],
    health_flags: [],
    ts_01_has_limitation: "no",
    ts_02_categories: [],
    ts_03_clearance: "",
    modules: {},
    budget_range: "70_170",
    readiness_level: "committed",
    preferred_contact_timezone: "",
    consent_processing: true,
    consent_accuracy: true,
    ...over,
  }) as unknown as ConsultAnswers;

export const moduleAnswer = (flags: string[] = []): ModuleAnswer => ({
  diagnosis: "synthetic diagnosis",
  onset: "6w_6m",
  recovery: "improving",
  pain: "mild",
  reaction: "fine",
  clearance: "cleared",
  notes: "synthetic note",
  red_flags: flags,
});

export const SUBMISSION_ID = "cns_00000000-0000-4000-8000-000000000001";

export const payloadFrom = (over: Partial<ConsultAnswers> = {}, id = SUBMISSION_ID): ConsultPayload =>
  buildPayload({ answers: answers(over), countryCode: over.whatsapp_dial_code === "+98" ? "IR" : "CA", submissionId: id });

/** Deep-cloned payload with a mutation applied (for negative tests). */
export function tamper(payload: ConsultPayload, mutate: (p: any) => void): Record<string, unknown> {
  const copy: any = JSON.parse(JSON.stringify(payload));
  mutate(copy);
  return copy;
}

export const newId = (n: number) => `cns_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** In-memory store with the same atomic create-only contract. */
export class MemoryStore implements ConsultStore {
  readonly records = new Map<string, StoredConsult>();
  creates = 0;
  failNext: "create" | "get" | null = null;

  async get(id: string) {
    if (this.failNext === "get") {
      this.failNext = null;
      throw new Error("injected");
    }
    return this.records.get(id) ?? null;
  }

  async create(id: string, record: StoredConsult): Promise<CreateResult> {
    if (this.failNext === "create") {
      this.failNext = null;
      throw new Error("injected");
    }
    await Promise.resolve();
    const existing = this.records.get(id);
    if (existing) return { status: "exists", record: existing };
    this.records.set(id, record);
    this.creates += 1;
    return { status: "created", record };
  }
}
