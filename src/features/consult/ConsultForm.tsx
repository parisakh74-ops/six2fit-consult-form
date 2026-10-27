import { useMemo, useRef, useState } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import {
  Card,
  GhostButton,
  Notice,
  PageShell,
  PrimaryButton,
  Spinner,
  StepProgress,
} from "@/components/consult/shell";
import {
  CheckboxCards,
  RadioCards,
  TextAreaField,
  TextField,
} from "@/components/consult/fields";
import {
  adherenceBarrierOptions,
  blockerDetails,
  currencyCountryFromDialCode,
  healthChecklist,
  allHealthFlags,
  countryByIso,
  searchCountries,
  consents,
  consultChannelOptions,
  exerciseScreeningTriggers,
  limits,
  nutritionIntro,
  persianPreferredHelper,
  outcomeCopy,
  primaryGoalOptions,
  readinessQuestion,
  serviceInterestOptions,
  sexQuestion,
  sportModuleByKey,
  sportModules,
  stepTitles,
  submitCta,
  systemCopy,
  timezoneQuestion,
  ts01,
  ts02,
  ts03,
  welcomeCopy,
  type SafetyOutcome,
} from "./assessmentConfig";
import { toAsciiDigits } from "./outcome";
import { RoutingCtas } from "./RoutingCtas";
import { ctasAllowedFor, lovableTzCode, routeAfterSubmission, type RoutingResult } from "./routing";
import { phonePlaceholder } from "./phonePlaceholder";
import { budgetOptionsFor, phoneInputHelper, schemaForStep } from "./schema";
import { buildPayload, createSubmissionId, submitConsultToCRM } from "./crm";
import type { ConsultAnswers } from "./types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";

type FormValues = ConsultAnswers;
type Status = "idle" | "submitting" | "success" | "error";

const toEnglishDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/\D/g, "");

const defaultValues = {
  lead_full_name: "",
  whatsapp_country: "",
  whatsapp_dial_code: "",
  whatsapp_phone: "",
  consult_channel: "",
  email: "",
  primary_goal: [] as string[],
  adherence_barrier: [] as string[],
  sex: "",
  adherence_barrier_other: "",
  service_interest: [] as string[],
  health_flags: [] as string[],
  blocker_details: "",
  ts_01_has_limitation: "",
  ts_02_categories: [] as string[],
  ts_03_clearance: "",
  modules: {},
  budget_range: "",
  readiness_level: "",
  preferred_contact_timezone: "",
  consent_processing: false,
  consent_accuracy: false,
} as unknown as FormValues;

export function ConsultForm() {
  const stepRef = useRef(0);
  const [step, setStep] = useState(0);
  const [status, setStatus] = useState<Status>("idle");
  const [outcome, setOutcome] = useState<SafetyOutcome>("GREEN");
  const [routing, setRouting] = useState<RoutingResult>({ status: "NOT_SUBMITTED" });
  const pendingRef = useRef(false);
  const [noNutritionConditions, setNoNutritionConditions] = useState(false);
  const [nutritionSelectionError, setNutritionSelectionError] = useState(false);
  // Keep one id for the whole submit attempt so a network retry replays the
  // same idempotency key instead of creating a second CRM submission.
  const submissionIdRef = useRef<string | null>(null);

  const resolver: Resolver<FormValues> = (values, context, options) =>
    (zodResolver(schemaForStep(stepRef.current)) as Resolver<FormValues>)(
      values,
      context,
      options,
    );

  const {
    watch,
    setValue,
    getValues,
    trigger,

    formState: { errors },
  } = useForm<FormValues>({ defaultValues, resolver, mode: "onSubmit" });

  const values = watch();

  const set = (name: string, value: unknown) =>
    setValue(name as never, value as never, { shouldValidate: true });

  const err = (path: string): string | undefined => {
    const parts = path.split(".");
    let node: unknown = errors;
    for (const p of parts) {
      if (!node || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[p];
    }
    const message = (node as { message?: unknown } | undefined)?.message;
    return typeof message === "string" ? message : undefined;
  };

  // Currency follows the WhatsApp dial code; the timezone is never used for it.
  const countryCode = currencyCountryFromDialCode(values.whatsapp_dial_code);
  const selectedServices = values.service_interest ?? [];
  // Before the user picks services, assume the exercise step applies so the
  // progress indicator does not jump backwards later.
  const exerciseIncluded =
    selectedServices.length === 0 ||
    selectedServices.some((s) => exerciseScreeningTriggers.includes(s));

  const visibleSteps = useMemo(
    () => (exerciseIncluded ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 5, 6]),
    [exerciseIncluded],
  );

  const goTo = (nextStep: number) => {
    stepRef.current = nextStep;
    setStep(nextStep);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const next = async () => {
    stepRef.current = step;
    if (step === 3 && !noNutritionConditions && !(getValues().health_flags ?? []).length) {
      setNutritionSelectionError(true);
      return;
    }
    const valid = await trigger();
    if (!valid) return;
    const idx = visibleSteps.indexOf(step);
    const target = visibleSteps[idx + 1];
    if (target !== undefined) goTo(target);
  };

  const back = () => {
    const idx = visibleSteps.indexOf(step);
    const target = visibleSteps[idx - 1];
    if (target !== undefined) goTo(target);
  };

  const submit = async () => {
    // Guard against duplicate submits while a request is pending.
    if (pendingRef.current) return;
    stepRef.current = step;
    const valid = await trigger();
    if (!valid) return;
    pendingRef.current = true;
    setStatus("submitting");
    try {
      const payload = buildPayload({
        // Step resolvers only parse their own slice, so read the full form state.
        answers: getValues(),
        countryCode: currencyCountryFromDialCode(getValues().whatsapp_dial_code),
        submissionId: submissionIdRef.current ?? (submissionIdRef.current = createSubmissionId()),
      });
      const result = await submitConsultToCRM(payload);
      if (!result.ok) {
        setStatus("error");
        return;
      }
      setOutcome(payload.safety_outcome);
      // Routing is decided only here, after the API confirmed the submission. tz follows the Smart Redirector rule (browser time zone);
      // how the new form should derive tz is an open Product decision, see evidence/CRM-IDENTITY-DQ/CONSULT-SCORE-ROUTING-MAPPING-20261027.md.
      let browserTz: string | undefined;
      try {
        browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      } catch {
        browserTz = undefined;
      }
      setRouting(
        routeAfterSubmission({
          submission: result,
          tz: lovableTzCode(browserTz),
          budget_range: payload.budget_range,
          readiness_level: payload.readiness_level,
        }),
      );
      setStatus("success");
      submissionIdRef.current = null;
      if (typeof window !== "undefined") window.scrollTo({ top: 0 });
    } catch (error) {
      // Never log answers — only the failure itself, and only in development.
      if (import.meta.env.DEV) console.error("[consult] submit failed", error);
      setStatus("error");
    } finally {
      pendingRef.current = false;
    }
  };

  /* ---------------- result screen ---------------- */
  if (status === "success") {
    const copy = outcomeCopy[outcome];
    return (
      <PageShell>
        <Card className="text-center">
          <div className="mx-auto mb-5 grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
              <path
                d="m5 13 4 4L19 7"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-foreground sm:text-2xl">{copy.title}</h1>
          <p className="mx-auto mt-3 max-w-[520px] text-[15px] leading-8 text-muted-foreground">
            {copy.text}
          </p>
          {routing.status === "ROUTED" && ctasAllowedFor(outcome) ? (
            <div className="mt-6">
              <RoutingCtas scenario={routing.scenario} />
            </div>
          ) : null}
        </Card>
        {import.meta.env.DEV ? (
          <DevPayloadPreview
            values={getValues()}
            countryCode={currencyCountryFromDialCode(getValues().whatsapp_dial_code)}
          />
        ) : null}
      </PageShell>
    );
  }

  const budget = budgetOptionsFor(countryCode);
  const selectedFlags = values.health_flags ?? [];
  const needsBlockerDetails = selectedFlags.length > 0;
  const activeCategories =
    values.ts_01_has_limitation && values.ts_01_has_limitation !== "no"
      ? (values.ts_02_categories ?? [])
      : [];
  const isLastStep = step === 6;
  const stepIndex = visibleSteps.indexOf(step);

  return (
    <PageShell>
      {step > 0 ? (
        <StepProgress
          current={stepIndex}
          total={visibleSteps.length - 1}
          title={stepTitles[step] ?? ""}
        />
      ) : null}

      <Card>
        {/* ---------------- step 0: welcome ---------------- */}
        {step === 0 ? (
          <div className="space-y-6">
            <div className="space-y-3">
              <h1 className="text-[24px] font-medium leading-8 text-foreground sm:text-[28px] sm:leading-10">
                {welcomeCopy.title}
              </h1>
              <p className="text-[16px] leading-7 text-muted-foreground">
                {welcomeCopy.description}
              </p>
            </div>
            <ul className="space-y-2.5">
              {welcomeCopy.bullets.map((b) => (
                <li
                  key={b}
                  className="flex items-start gap-2.5 text-[14px] leading-7 text-foreground"
                >
                  <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" />
                  {b}
                </li>
              ))}
            </ul>
            <PrimaryButton type="button" className="w-full" onClick={() => goTo(1)}>
              {welcomeCopy.cta}
            </PrimaryButton>
          </div>
        ) : null}

        {/* ---------------- step 1: contact ---------------- */}
        {step === 1 ? (
          <div className="space-y-7">
            <TextField
              label="نام و نام خانوادگی"
              helper={persianPreferredHelper}
              required
              autoComplete="name"
              inputMode="text"
              value={values.lead_full_name ?? ""}
              onChange={(e) => set("lead_full_name", e.target.value)}
              error={err("lead_full_name")}
            />
            <div className="grid gap-3 sm:grid-cols-[170px_minmax(0,1fr)]">
              <CountryPicker
                value={values.whatsapp_country ?? ""}
                onChange={(iso) => {
                  const country = countryByIso[iso];
                  if (!country) return;
                  set("whatsapp_country", iso);
                  set("whatsapp_dial_code", country.dial);
                }}
                error={err("whatsapp_dial_code")}
              />
              <TextField
                label="شماره واتساپ"
                required
                type="tel"
                inputMode="tel"
                dir="ltr"
                autoComplete="tel"
                placeholder={phonePlaceholder(values.whatsapp_country)}
                value={values.whatsapp_phone ?? ""}
                onChange={(e) => set("whatsapp_phone", toAsciiDigits(e.target.value))}
                error={err("whatsapp_phone")}
              />
            </div>
            <p className="-mt-4 text-[13px] text-muted-foreground">{phoneInputHelper}</p>
            <RadioCards
              name="consult_channel"
              legend="ترجیح می‌دهید مشاوره اولیه چگونه انجام شود؟"
              required
              options={consultChannelOptions}
              value={values.consult_channel}
              onChange={(v) => set("consult_channel", v)}
              error={err("consult_channel")}
            />
            <TextField
              label="ایمیل"
              type="email"
              inputMode="email"
              dir="ltr"
              autoComplete="email"
              helper="فقط برای پیگیری مشاوره استفاده می‌شود."
              value={values.email ?? ""}
              onChange={(e) => set("email", e.target.value)}
              error={err("email")}
            />
          </div>
        ) : null}

        {/* ---------------- step 2: goal ---------------- */}
        {step === 2 ? (
          <div className="space-y-7">
            <CheckboxCards
              legend="هدف اصلی شما از شروع برنامه چیست؟"
              helper="هر تعداد هدف مرتبط را انتخاب کنید."
              required
              columns={2}
              options={primaryGoalOptions}
              value={values.primary_goal ?? []}
              onChange={(v) => set("primary_goal", v)}
              error={err("primary_goal")}
            />
            <CheckboxCards
              legend="بزرگ‌ترین مانع شما برای پایبندی به برنامه چیست؟"
              helper="می‌توانید بیش از یک مورد را انتخاب کنید."
              options={adherenceBarrierOptions}
              value={values.adherence_barrier ?? []}
              onChange={(v) => set("adherence_barrier", v)}
              error={err("adherence_barrier")}
            />
            {(values.adherence_barrier ?? []).includes("other") ? (
              <TextField
                helper={persianPreferredHelper}
                label="مانع خود را کوتاه توضیح دهید"
                required
                value={values.adherence_barrier_other ?? ""}
                onChange={(e) => set("adherence_barrier_other", e.target.value)}
                error={err("adherence_barrier_other")}
              />
            ) : null}
            <RadioCards
              name={sexQuestion.key}
              legend={sexQuestion.question}
              required
              columns={2}
              options={sexQuestion.options}
              value={values.sex}
              onChange={(v) => set("sex", v)}
              error={err("sex")}
            />
            <div className="grid gap-5 sm:grid-cols-3">
              <NumberField
                label="سن"
                suffix="سال"
                value={values.age}
                onChange={(v) => set("age", v)}
                error={err("age")}
                min={limits.age.min}
                max={limits.age.max}
              />
              <NumberField
                label="قد"
                suffix="سانتی‌متر"
                value={values.height_cm}
                onChange={(v) => set("height_cm", v)}
                error={err("height_cm")}
                min={limits.height_cm.min}
                max={limits.height_cm.max}
              />
              <NumberField
                label="وزن فعلی"
                suffix="کیلوگرم"
                value={values.weight_kg}
                onChange={(v) => set("weight_kg", v)}
                error={err("weight_kg")}
                min={limits.weight_kg.min}
                max={limits.weight_kg.max}
              />
            </div>
            <CheckboxCards
              legend="برای کدام حوزه به مشاوره نیاز دارید؟"
              required
              columns={2}
              options={serviceInterestOptions}
              value={values.service_interest ?? []}
              onChange={(v) => set("service_interest", v)}
              error={err("service_interest")}
            />
          </div>
        ) : null}

        {/* ---------------- step 3: nutrition screening ---------------- */}
        {step === 3 ? (
          <div className="space-y-7">
            <Notice>{nutritionIntro}</Notice>
            <HealthChecklist
              selected={selectedFlags}
              none={noNutritionConditions}
              error={nutritionSelectionError ? "موارد مرتبط یا گزینهٔ «هیچ‌کدام» را انتخاب کنید." : undefined}
              onChange={(flags, none) => {
                setNoNutritionConditions(none);
                setNutritionSelectionError(false);
                set("health_flags", flags);
                if (flags.length === 0) set("blocker_details", "");
              }}
            />
            {needsBlockerDetails ? (
              <TextAreaField
                label={blockerDetails.question}
                helper={persianPreferredHelper}
                required
                value={values.blocker_details ?? ""}
                onChange={(e) => set("blocker_details", e.target.value)}
                error={err("blocker_details")}
              />
            ) : null}
          </div>
        ) : null}

        {/* ---------------- step 4: exercise safety ---------------- */}
        {step === 4 ? (
          <div className="space-y-7">
            <RadioCards
              name={ts01.key}
              legend={ts01.question}
              required
              options={ts01.options}
              value={values.ts_01_has_limitation}
              onChange={(v) => {
                set("ts_01_has_limitation", v);
                // TS-03 is only asked while TS-01 is active; drop a stale answer.
                if (v === "no") set("ts_03_clearance", "");
              }}
              error={err("ts_01_has_limitation")}
            />
            {values.ts_01_has_limitation && values.ts_01_has_limitation !== "no" ? (
              <>
                <CheckboxCards
                  legend={ts02.question}
                  required
                  columns={2}
                  options={sportModules.map((m) => ({ value: m.key, label: m.label }))}
                  value={values.ts_02_categories ?? []}
                  onChange={(v) => set("ts_02_categories", v)}
                  error={err("ts_02_categories")}
                />
                <RadioCards
                  name={ts03.key}
                  legend={ts03.question}
                  required
                  options={ts03.options}
                  value={values.ts_03_clearance}
                  onChange={(v) => set("ts_03_clearance", v)}
                  error={err("ts_03_clearance")}
                />
                {activeCategories.map((key) => {
                  const mod = sportModuleByKey[key];
                  if (!mod) return null;
                  const answer = values.modules?.[key] ?? {};
                  return (
                    <details
                      key={key}
                      open
                      className="rounded-2xl border border-border bg-surface/60 p-4 sm:p-5"
                    >
                      <summary className="cursor-pointer list-none text-[15px] font-bold text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                        {mod.label}
                      </summary>
                      <div className="mt-5 space-y-6">
                        {mod.fields.map((field) => {
                          const path = `modules.${key}.${field.key}`;
                          const current = (answer as Record<string, unknown>)[field.key] as
                            | string
                            | undefined;
                          if (field.type === "radio") {
                            return (
                              <RadioCards
                                key={field.key}
                                name={path}
                                legend={field.label}
                                required={field.required}
                                columns={2}
                                options={field.options ?? []}
                                value={current}
                                onChange={(v) => set(path, v)}
                                error={err(path)}
                              />
                            );
                          }
                          if (field.type === "textarea") {
                            return (
                              <TextAreaField
                                key={field.key}
                                label={field.label}
                                rows={3}
                                value={current ?? ""}
                                onChange={(e) => set(path, e.target.value)}
                                error={err(path)}
                              />
                            );
                          }
                          return (
                            <TextField
                              key={field.key}
                              label={field.label}
                              required={field.required}
                              value={current ?? ""}
                              onChange={(e) => set(path, e.target.value)}
                              error={err(path)}
                            />
                          );
                        })}
                        <CheckboxCards
                          legend="کدام‌یک از موارد زیر را دارید؟"
                          helper="اگر هیچ‌کدام را ندارید، خالی بگذارید."
                          options={mod.hardRedFlags}
                          value={answer.red_flags ?? []}
                          onChange={(v) => set(`modules.${key}.red_flags`, v)}
                        />
                      </div>
                    </details>
                  );
                })}
              </>
            ) : null}
          </div>
        ) : null}

        {/* ---------------- step 5: budget & readiness ---------------- */}
        {step === 5 ? (
          <div className="space-y-7">
            <RadioCards
              name="budget_range"
              legend={budget.question}
              required
              options={budget.options}
              value={values.budget_range}
              onChange={(v) => set("budget_range", v)}
              error={err("budget_range")}
            />
            <RadioCards
              name="readiness_level"
              legend={readinessQuestion.question}
              required
              options={readinessQuestion.options}
              value={values.readiness_level}
              onChange={(v) => set("readiness_level", v)}
              error={err("readiness_level")}
            />
          </div>
        ) : null}

        {/* ---------------- step 6: consent ---------------- */}
        {step === 6 ? (
          <div className="space-y-6">
            <TimezoneField
              value={values.preferred_contact_timezone ?? ""}
              onChange={(v) => set("preferred_contact_timezone", v)}
            />
            <ConsentRow
              label={consents.processing.label}
              checked={Boolean(values.consent_processing)}
              onChange={(v) => set("consent_processing", v)}
              error={err("consent_processing")}
            />
            <ConsentRow
              label={consents.accuracy.label}
              checked={Boolean(values.consent_accuracy)}
              onChange={(v) => set("consent_accuracy", v)}
              error={err("consent_accuracy")}
            />
            {status === "error" ? (
              <Notice tone="error">{systemCopy.genericError}</Notice>
            ) : null}
          </div>
        ) : null}

        {/* ---------------- navigation ---------------- */}
        {step > 0 ? (
          <div className="mt-10 border-t border-border pt-6">
            <div className="flex flex-col gap-2.5 sm:flex-row-reverse sm:items-center">
              {isLastStep ? (
                <PrimaryButton
                  type="button"
                  className="sm:flex-1"
                  onClick={() => void submit()}
                  disabled={status === "submitting"}
                >
                  {status === "submitting" ? (
                    <>
                      <Spinner />
                      {systemCopy.submitting}
                    </>
                  ) : (
                    submitCta
                  )}
                </PrimaryButton>
              ) : (
                <PrimaryButton
                  type="button"
                  className="sm:flex-1"
                  onClick={() => void next()}
                >
                  {systemCopy.next}
                </PrimaryButton>
              )}
              <GhostButton onClick={back} disabled={status === "submitting"}>
                {systemCopy.back}
              </GhostButton>
            </div>
          </div>
        ) : null}
      </Card>

      {import.meta.env.DEV && step > 0 ? (
        <DevPayloadPreview values={values} countryCode={countryCode} />
      ) : null}
    </PageShell>
  );
}

function ConsentRow({
  label,
  checked,
  onChange,
  error,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  error?: string | undefined;
}) {
  return (
    <div className="space-y-2">
      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card p-4 text-[14px] leading-7 transition-colors hover:border-foreground/25 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="sr-only"
        />
        <span
          aria-hidden
          className={`mt-1 grid size-5 shrink-0 place-items-center rounded-md border ${
            checked ? "border-brand bg-brand" : "border-border bg-background"
          }`}
        >
          {checked ? (
            <svg viewBox="0 0 24 24" className="size-3.5 text-brand-foreground" fill="none">
              <path
                d="m5 13 4 4L19 7"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : null}
        </span>
        <span className="text-foreground">{label}</span>
      </label>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HealthChecklist({
  selected,
  none,
  error,
  onChange,
}: {
  selected: string[];
  none: boolean;
  error?: string | undefined;
  onChange: (flags: string[], none: boolean) => void;
}) {
  const options = [
    ...allHealthFlags.map((f) => ({ value: f.code, label: f.label })),
    { value: healthChecklist.noneValue, label: healthChecklist.noneLabel },
  ];
  return (
    <CheckboxCards
      legend={healthChecklist.question}
      helper={healthChecklist.helper}
      required
      options={options}
      value={none ? [healthChecklist.noneValue] : selected}
      onChange={(next) => {
        // «هیچ‌کدام» is exclusive: picking it clears flags, picking a flag clears it.
        const pickedNone = next.includes(healthChecklist.noneValue) && !none;
        if (pickedNone) return onChange([], true);
        onChange(next.filter((v) => v !== healthChecklist.noneValue), false);
      }}
      error={error}
    />
  );
}

export function CountryPicker({
  value,
  onChange,
  error,
}: {
  value: string;
  onChange: (iso: string) => void;
  error?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const current = countryByIso[value];
  const results = searchCountries(query);
  return (
    <div className="space-y-2.5">
      <span className="block text-[15px] font-semibold leading-7 text-foreground">
        کد کشور
      </span>
      <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery(""); }}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            type="button"
            aria-label="انتخاب کد کشور"
            aria-invalid={Boolean(error)}
            className="flex h-auto w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[15px] font-normal text-foreground shadow-none outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25"
          >
            {current ? <>
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden>{current.flag}</span>
              <span className="truncate">{current.fa}</span>
            </span>
            <span dir="ltr" className="tabular-nums text-muted-foreground">{current.dial}</span>
            </> : <span className="text-muted-foreground">انتخاب کنید</span>}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[300px] p-0" dir="rtl">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="نام کشور یا کد تماس…"
            />
            <CommandList>
              <CommandEmpty>کشوری پیدا نشد.</CommandEmpty>
              {results.map((c) => (
                <CommandItem
                  key={c.iso}
                  value={c.iso}
                  onSelect={() => {
                    onChange(c.iso);
                    setOpen(false);
                    setQuery("");
                  }}
                  className="flex items-center gap-2"
                >
                  <span aria-hidden>{c.flag}</span>
                  <span className="flex-1 truncate">{c.fa}</span>
                  <span dir="ltr" className="tabular-nums text-muted-foreground">{c.dial}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p>
      ) : null}
    </div>
  );
}

function formatOffset(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
      .formatToParts(new Date())
      .find((p) => p.type === "timeZoneName")?.value;
    if (!part || part === "GMT") return "UTC+0";
    return part.replace("GMT", "UTC").replace(/([+-])0(\d)/, "$1$2").replace(":00", "");
  } catch {
    return "UTC";
  }
}

function TimezoneField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const zones = useMemo(() => {
    const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
    const list = intl.supportedValuesOf?.("timeZone") ?? ["Asia/Tehran", "Asia/Dubai", "Europe/Istanbul", "Europe/London", "America/New_York"];
    return list.map((zone) => ({ zone, label: `${zone} (${formatOffset(zone)})` }));
  }, []);
  const q = query.trim().toLowerCase();
  const filtered = (q ? zones.filter((z) => z.label.toLowerCase().includes(q)) : zones).slice(0, 60);
  const selectedLabel = zones.find((z) => z.zone === value)?.label;

  return (
    <div className="space-y-2.5">
      <label htmlFor="tz-search" className="block text-[15px] font-semibold leading-7 text-foreground">
        {timezoneQuestion.question}
      </label>
      <p className="text-[13px] text-muted-foreground">{timezoneQuestion.helper}</p>
      <div className="relative">
        <input
          id="tz-search"
          role="combobox"
          aria-expanded={open}
          aria-controls="tz-list"
          aria-autocomplete="list"
          dir="ltr"
          autoComplete="off"
          placeholder={timezoneQuestion.placeholder}
          value={open ? query : (selectedLabel ?? "")}
          onFocus={() => {
            setQuery("");
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-xl border border-border bg-card px-4 py-3 text-left text-[15px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25"
        />
        {open ? (
          <ul
            id="tz-list"
            role="listbox"
            dir="ltr"
            className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card py-1 text-left text-[14px]"
          >
            {filtered.length === 0 ? (
              <li className="px-4 py-2 text-muted-foreground">—</li>
            ) : (
              filtered.map((z) => (
                <li
                  key={z.zone}
                  role="option"
                  aria-selected={z.zone === value}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onChange(z.zone);
                    setOpen(false);
                  }}
                  className={`cursor-pointer px-4 py-2 hover:bg-surface ${z.zone === value ? "bg-brand-soft" : ""}`}
                >
                  {z.label}
                </li>
              ))
            )}
          </ul>
        ) : null}
      </div>
      {value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          className="text-[13px] text-muted-foreground underline-offset-4 hover:underline"
        >
          پاک کردن انتخاب
        </button>
      ) : null}
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  onChange,
  error,
  min,
  max,
}: {
  label: string;
  suffix: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  error?: string | undefined;
  min: number;
  max: number;
}) {
  return (
    <TextField
      label={label}
      required
      type="text"
      inputMode="numeric"
      dir="ltr"
      pattern="[0-9]*"
      className="text-center tabular-nums"
      min={min}
      max={max}
      maxLength={String(max).length}
      suffix={suffix}
      value={value === undefined || Number.isNaN(value) ? "" : String(value)}
      onChange={(e) => {
        const raw = toEnglishDigits(e.target.value);
        onChange(raw === "" ? undefined : Number(raw));
      }}
      error={error}
    />
  );
}

function DevPayloadPreview({
  values,
  countryCode,
}: {
  values: FormValues;
  countryCode: string;
}) {
  let json = "";
  try {
    json = JSON.stringify(
      buildPayload({
        answers: values,
        countryCode,
        submissionId: "cns_preview",
      }),
      null,
      2,
    );
  } catch {
    json = "// payload not computable yet";
  }
  return (
    <details className="mt-5 rounded-2xl border border-dashed border-border bg-card p-4">
      <summary className="cursor-pointer font-display text-[13px] font-semibold text-muted-foreground">
        DEV · CRM payload preview
      </summary>
      <pre
        dir="ltr"
        className="mt-3 max-h-80 overflow-auto rounded-xl bg-surface p-3 text-left font-display text-[11px] leading-5 text-foreground"
      >
        {json}
      </pre>
    </details>
  );
}
