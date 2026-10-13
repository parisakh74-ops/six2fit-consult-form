import { z } from "zod";
import {
  EMAIL_MAX_LENGTH,
  budgetQuestions,
  limits,
  sportModuleByKey,
  systemCopy,
} from "./assessmentConfig";

const req = systemCopy.required;

const num = (min: number, max: number, unit: string) =>
  z.preprocess(
    (v) => (v === "" || v === null || v === undefined || Number.isNaN(v) ? undefined : v),
    z
      .number({ required_error: req, invalid_type_error: "یک عدد معتبر وارد کنید" })
      .min(min, `مقدار باید بین ${min} تا ${max} ${unit} باشد`)
      .max(max, `مقدار باید بین ${min} تا ${max} ${unit} باشد`),
  );

const optionalText = z.string().trim().max(500).optional().or(z.literal(""));

export const contactSchema = z.object({
  lead_full_name: z
    .string({ required_error: req })
    .trim()
    .min(1, req)
    .min(3, "نام و نام خانوادگی را کامل وارد کنید")
    .max(80, "نام واردشده طولانی است")
    .regex(/^[\p{L}\p{M}\u200C\s'.-]+$/u, "نام فقط می‌تواند شامل حروف باشد"),
  whatsapp_dial_code: z.string().min(2, req),
  whatsapp_phone: z
    .string({ required_error: req })
    .trim()
    .min(1, req)
    .min(6, "شماره واتساپ معتبر نیست")
    .max(20, "شماره واتساپ معتبر نیست")
    .regex(/^[\d\s()+-]+$/, "شماره واتساپ فقط می‌تواند شامل عدد باشد"),
  consult_channel: z.string({ required_error: req }).min(1, req),
  email: z
    .string()
    .trim()
    .max(EMAIL_MAX_LENGTH, "ایمیل نباید بیشتر از ۱۰۰ کاراکتر باشد")
    .email("ایمیل معتبر نیست")
    .optional()
    .or(z.literal("")),
});

export const goalSchema = z
  .object({
    primary_goal: z.array(z.string()).min(1, "حداقل یک هدف را انتخاب کنید"),
    adherence_barrier: z.array(z.string()).default([]),
    sex: z.string({ required_error: req }).min(1, req),
    adherence_barrier_other: optionalText,
    age: num(limits.age.min, limits.age.max, "سال"),
    height_cm: num(limits.height_cm.min, limits.height_cm.max, "سانتی‌متر"),
    weight_kg: num(limits.weight_kg.min, limits.weight_kg.max, "کیلوگرم"),
    service_interest: z.array(z.string()).min(1, "حداقل یک گزینه را انتخاب کنید"),
  })
  .superRefine((data, ctx) => {
    if (data.adherence_barrier?.includes("other") && !data.adherence_barrier_other?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adherence_barrier_other"],
        message: req,
      });
    }
  });

export const nutritionSchema = z
  .object({ health_flags: z.array(z.string()).default([]), blocker_details: optionalText })
  .superRefine((data, ctx) => {
    if (data.health_flags.length > 0 && !String(data.blocker_details ?? "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["blocker_details"],
        message: req,
      });
    }
  });

const moduleAnswerSchema = z.object({
  diagnosis: z.string().trim().max(200).optional(),
  onset: z.string().optional(),
  recovery: z.string().optional(),
  pain: z.string().optional(),
  reaction: z.string().optional(),
  clearance: z.string().optional(),
  notes: z.string().trim().max(1000).optional(),
  red_flags: z.array(z.string()).optional(),
});

export const exerciseSchema = z
  .object({
    ts_01_has_limitation: z.string({ required_error: req }).min(1, req),
    ts_02_categories: z.array(z.string()).default([]),
    ts_03_clearance: z.string().optional().or(z.literal("")),
    modules: z.record(moduleAnswerSchema).default({}),
  })
  .superRefine((data, ctx) => {
    if (data.ts_01_has_limitation === "no") return;

    if (!data.ts_02_categories?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ts_02_categories"],
        message: "حداقل یک حوزه را انتخاب کنید",
      });
    }
    if (!data.ts_03_clearance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ts_03_clearance"],
        message: req,
      });
    }
    for (const key of data.ts_02_categories ?? []) {
      const mod = sportModuleByKey[key];
      if (!mod) continue;
      const answer = (data.modules ?? {})[key] ?? {};
      for (const field of mod.fields) {
        if (!field.required) continue;
        const value = (answer as Record<string, unknown>)[field.key];
        if (!value || String(value).trim() === "") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modules", key, field.key],
            message: req,
          });
        }
      }
    }
  });

export const budgetSchema = z.object({
  budget_range: z.string({ required_error: req }).min(1, req),
  readiness_level: z.string({ required_error: req }).min(1, req),
});

export const consentSchema = z.object({
  preferred_contact_timezone: z.string().trim().max(80).optional().or(z.literal("")),
  consent_processing: z.literal(true, {
    errorMap: () => ({ message: "برای ادامه، این مورد را تأیید کنید" }),
  }),
  consent_accuracy: z.literal(true, {
    errorMap: () => ({ message: "برای ادامه، این مورد را تأیید کنید" }),
  }),
});

export const emptySchema = z.object({});

export function budgetOptionsFor(countryCode: string) {
  return countryCode === "IR" ? budgetQuestions.IR : budgetQuestions.INTL;
}

export function schemaForStep(step: number): z.ZodTypeAny {
  switch (step) {
    case 1:
      return contactSchema;
    case 2:
      return goalSchema;
    case 3:
      return nutritionSchema;
    case 4:
      return exerciseSchema;
    case 5:
      return budgetSchema;
    case 6:
      return consentSchema;
    default:
      return emptySchema;
  }
}
