# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS

---

## 6toFit Consult (Six2Fit)

Persian, fully RTL pre-purchase consultation and qualification form. It collects
only what is needed for consultation routing, eligibility, safety review and CRM
handoff — it is not the onboarding form.

### Where things live

| Path | Purpose |
| --- | --- |
| `src/features/consult/assessmentConfig.ts` | **All** questions, options, point mappings, hard-red-flag lists, outcome copy, CRM statuses, form/consent versions |
| `src/features/consult/schema.ts` | Zod schema per step (`schemaForStep`) + `budgetOptionsFor` currency routing |
| `src/features/consult/outcome.ts` | Isolated module scoring, hard-red-flag collection, outcome priority, phone normalization |
| `src/features/consult/crm.ts` | Typed payload builder + `submitConsultToCRM(payload)` (mock) |
| `src/features/consult/ConsultForm.tsx` | Multi-step form UI |
| `src/components/consult/` | Reusable field and layout primitives |
| `src/features/consult/outcome.test.ts` | Unit tests for outcome priority and currency routing |

### Outcome priority

1. Any hard red flag, any nutrition red blocker, age < 18, or a module score ≥ 11 → `RED_SPECIALIST`
   (`general_plan_eligible = false`, CRM status `Consult – Red Specialist`).
2. Otherwise any yellow blocker or a module score of 4–10 → `YELLOW_REVIEW`
   (`review_required = true`, CRM status `Consult – Yellow Review`).
3. Otherwise → `GREEN` (CRM status `Consult – Green`).

Each sport module keeps its own score (`module_score_*`) and its own hard-red-flag
state; scores are never merged. Commercial readiness is scored separately and never
feeds the safety outcome. A red outcome does not block payment in this app — it blocks
automatic activation of the general plan and requires specialist review.

### Currency routing

The user answers «ساکن ایران هستید؟» near the beginning of the form. A “yes” answer
routes to the Toman question and “no” routes to the USD question. The payload records
the derived country code and `currency_route_source: "self_declared"`; IP geolocation
is not used.

### Going live with Zoho

Replace only the body of `submitConsultToCRM` with a call to a server function or
server route that holds the Zoho credentials. Server-side responsibilities:
deduplicate by `whatsapp_phone_normalized` first and `email` second, map
`safety_outcome` to `crm_status`, and append an audit-log entry with `form_version`
and any outcome change. No credentials belong in browser-side modules.

### Privacy

Answers are never logged, never put in URLs or analytics, and never included in error
messages. The form does not save drafts locally. The CRM payload preview panel renders
only in development (`import.meta.env.DEV`).

### Tests

```bash
bunx vitest run
```
