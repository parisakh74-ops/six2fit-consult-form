import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Option } from "@/features/consult/assessmentConfig";

export function FieldShell({
  label,
  helper,
  error,
  htmlFor,
  children,
}: {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  htmlFor?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <label
        htmlFor={htmlFor}
        className="block text-[15px] font-semibold leading-7 text-foreground"
      >
        {label}
      </label>
      {helper ? <p className="text-[13px] text-muted-foreground">{helper}</p> : null}
      {children}
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const cardBase =
  "relative flex w-full cursor-pointer items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3.5 text-start text-[15px] leading-6 transition-colors hover:border-foreground/25 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand";

const cardSelected = "border-brand bg-brand-soft";

function Indicator({ checked, round }: { checked: boolean; round: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 grid size-5 shrink-0 place-items-center border transition-colors",
        round ? "rounded-full" : "rounded-md",
        checked ? "border-brand bg-brand" : "border-border bg-background",
      )}
    >
      {checked ? (
        <span
          className={cn("bg-brand-foreground", round ? "size-2 rounded-full" : "size-2 rounded-[2px]")}
        />
      ) : null}
    </span>
  );
}

export function RadioCards({
  name,
  options,
  value,
  onChange,
  legend,
  helper,
  error,
  columns = 1,
}: {
  name: string;
  options: Option[];
  value?: string | undefined;
  onChange: (value: string) => void;
  legend: string;
  helper?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  columns?: 1 | 2 | undefined;
}) {
  return (
    <fieldset className="space-y-2.5">
      <legend className="mb-2.5 block text-[15px] font-semibold leading-7 text-foreground">
        {legend}
      </legend>
      {helper ? (
        <p className="-mt-1 mb-1 text-[13px] text-muted-foreground">{helper}</p>
      ) : null}
      <div className={cn("grid gap-2.5", columns === 2 && "sm:grid-cols-2")}>
        {options.map((option) => {
          const checked = value === option.value;
          return (
            <label
              key={option.value}
              className={cn(cardBase, checked && cardSelected)}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="sr-only"
              />
              <Indicator checked={checked} round />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">{option.label}</span>
                {option.description ? (
                  <span className="mt-0.5 block text-[13px] text-muted-foreground">
                    {option.description}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function CheckboxCards({
  options,
  value = [],
  onChange,
  legend,
  helper,
  error,
  columns = 1,
}: {
  options: Option[];
  value?: string[] | undefined;
  onChange: (value: string[]) => void;
  legend: string;
  helper?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  columns?: 1 | 2 | undefined;
}) {
  const toggle = (v: string) =>
    onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);

  return (
    <fieldset className="space-y-2.5">
      <legend className="mb-2.5 block text-[15px] font-semibold leading-7 text-foreground">
        {legend}
      </legend>
      {helper ? (
        <p className="-mt-1 mb-1 text-[13px] text-muted-foreground">{helper}</p>
      ) : null}
      <div className={cn("grid gap-2.5", columns === 2 && "sm:grid-cols-2")}>
        {options.map((option) => {
          const checked = value.includes(option.value);
          return (
            <label
              key={option.value}
              className={cn(cardBase, checked && cardSelected)}
            >
              <input
                type="checkbox"
                value={option.value}
                checked={checked}
                onChange={() => toggle(option.value)}
                className="sr-only"
              />
              <Indicator checked={checked} round={false} />
              <span className="min-w-0 font-medium text-foreground">{option.label}</span>
            </label>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="text-[13px] font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

const inputBase =
  "w-full rounded-xl border border-border bg-card px-4 py-3 text-[15px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/25 aria-[invalid=true]:border-destructive";

export function TextField({
  label,
  helper,
  error,
  required,
  type = "text",
  inputMode,
  suffix,
  className,
  ...rest
}: {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
  type?: string | undefined;
  inputMode?: "text" | "numeric" | "tel" | "email" | undefined;
  suffix?: string | undefined;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <FieldShell
      label={label}
      helper={helper}
      error={error}
      required={required}
      htmlFor={id}
    >
      <div className="relative" dir={rest.dir}>
        <input
          id={id}
          type={type}
          inputMode={inputMode}
          aria-invalid={Boolean(error)}
          className={cn(inputBase, suffix && "pe-24", className)}
          {...rest}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 end-4 flex items-center text-[13px] text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
    </FieldShell>
  );
}

export function TextAreaField({
  label,
  helper,
  error,
  required,
  ...rest
}: {
  label: string;
  helper?: string | undefined;
  error?: string | undefined;
  required?: boolean | undefined;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <FieldShell
      label={label}
      helper={helper}
      error={error}
      required={required}
      htmlFor={id}
    >
      <textarea
        id={id}
        rows={4}
        aria-invalid={Boolean(error)}
        className={cn(inputBase, "resize-y leading-7")}
        {...rest}
      />
    </FieldShell>
  );
}

export function SelectField({
  label,
  error,
  required,
  options,
  ...rest
}: {
  label: string;
  error?: string | undefined;
  required?: boolean | undefined;
  options: { value: string; label: string }[];
} & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} required={required} htmlFor={id}>
      <select id={id} className={cn(inputBase, "appearance-none")} {...rest}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
