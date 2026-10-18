# DEF-05 — Consultation phone normalization drops valid digits

Status: **documented, not fixed.** No production behaviour was changed. `normalizePhone` and its callers are untouched; the only additions are the documentation and the isolated demonstration tests in `src/features/consult/phone-normalization.defect.test.ts`. The behaviour change below needs Product Manager approval first. Synthetic data only.

## 1. Defect

`normalizePhone(dialCode, raw)` builds the E.164-style value used for CRM deduplication, the WhatsApp number and the Onboarding prefill. It strips every leading zero from the raw digits and then, if the remaining digits **start with the calling-code digits**, removes them (it assumes the person typed the country code in front). A **national** number that legitimately begins with the same digits loses real digits, and the stored value is a different, wrong number.

Confirmed by execution of the real function (2026-10-18):

| Case | Dial code | Raw input | Current result | Correct E.164 | Digits lost |
|---|---|---|---|---|---|
| India, national number starts with 91 | `+91` | `91234 56789` | `+9123456789` | `+919123456789` | 2 of 10 |
| Kazakhstan/Russia, national starts with 7 | `+7` | `701 234 5678` | `+7012345678` | `+77012345678` | 1 of 10 |
| Iran, national starts with 98 | `+98` | `981 234 5678` | `+9812345678` | `+989812345678` | 2 of 10 |

The stored value still looks valid (`^\+\d{7,15}$`) and passes every server check, so nothing flags it.

## 2. Source references (Consultation worktree at `5320246` + fix branch)

| What | Where |
|---|---|
| The function (root cause: lines 166–167 zero-strip and `startsWith(cc)` strip) | `src/features/consult/outcome.ts:163-169` |
| Browser derivation of the stored number | `src/features/consult/crm.ts:71-74` (`whatsapp_phone_normalized`) |
| Same value copied into the Onboarding handoff | `src/features/consult/crm.ts:58` (`onboarding_prefill["ON-06.n"]`) |
| Server shape check of the stored number | `src/server/consult/validate.ts:85` (`^\+\d{7,15}$`) |
| Server prefix check | `src/server/consult/validate.ts:221` (`startsWith(whatsapp_dial_code)`) |
| Server prefill must equal the stored number | `src/server/consult/validate.ts:236-249` (line 241) |
| Server re-applies `normalizePhone` to the stored number | `src/server/consult/validate.ts:331-336` |
| Raw input rules: 6–20 characters, only `[\d\s()+-]` (ASCII digits) | `src/features/consult/schema.ts:32-40` |
| Input field next to the dial-code picker (placeholder `912 345 6789` = national) | `src/features/consult/ConsultForm.tsx:320-331` |
| Existing tests that pin the heuristic | `src/features/consult/outcome.test.ts:179-180` |

Why the server does not catch it: `validate.ts:332` compares `normalizePhone(dial, stored)` with `stored`. For a stored E.164 value the call removes the leading calling code once and adds it back, so a lossy value and a correct one both pass. The loss happens only in the browser derivation from raw national input.

## 3. Impact

- The WhatsApp number used to contact the lead is wrong (digits missing) while looking valid.
- The CRM deduplication key (`whatsapp_phone_normalized`, then e-mail; see the comment at `crm.ts:138`) is wrong; two people could collide or a returning lead could be missed.
- Onboarding receives the same value (`onboarding_prefill["ON-06.n"]`, constrained to equal it by `validate.ts:241`). The Onboarding inverse (`nationalPhoneFromPrefill`, onboarding fix branch) returns the national digits that Consultation kept, so the loss is carried through, not repaired.
- Not repairable afterwards: the dropped digits are not stored anywhere. Records already written with a lossy value cannot be corrected automatically.

Related observation (not part of DEF-05): Persian/Arabic-Indic digits are rejected by the schema regex (`\d` is ASCII-only) rather than normalized, whereas Onboarding normalizes them. A person typing `۰۹۱۲…` gets "شماره واتساپ فقط می‌تواند شامل عدد باشد".

## 4. Proposed input contract (for approval; not implemented)

Principle: the field sits next to a dial-code picker, so it is a **national-number** field. The country code is removed only when the person says so explicitly.

1. **National by default.** Without a leading `+` or `00`, the digits are the national number. Separators `()- ` are ignored. A single trunk `0` is removed (current behaviour strips all leading zeros; Italian landlines, where the `0` is part of the number, remain a documented limitation unless country metadata is added).
2. **Explicit international marker.** If the raw text starts with `+` or `00`, the digits after the marker must start with the selected calling code; remove it, the rest is national. If the code differs from the selected one: validation error ("کد کشور با کد انتخاب‌شده یکی نیست"), or switch the picker — a product decision.
3. **Never** remove leading digits equal to the calling code without a marker.
4. Output stays `+<cc><national>` (shape and `^\+\d{7,15}$` unchanged), so the payload schema, CRM mapping and the Onboarding handoff keep their current shape.
5. The server re-check can stay as is (it accepts any correct E.164) or become a strict "starts with the dial code" comparison.

Options for the one real trade-off — people who type the code **without** a marker (e.g. `98 912 345 6789` with `+98`):

| Option | Behaviour | Cost / risk |
|---|---|---|
| A. Explicit marker only (rules 1–3) | `98 912…` is read as national → `+9898912…` | no new dependency; changes today's behaviour and existing tests `outcome.test.ts:180`; mitigate with helper text and a visible preview of the resulting number before submit |
| B. Country metadata (e.g. libphonenumber-js) | uses per-country length rules to decide whether a leading code is a prefix or part of the number; also fixes trunk-zero cases | new dependency (needs approval, bundle size), more behaviour to test |
| C. Keep the heuristic, add exceptions | no change for most inputs | cannot be correct in general; not recommended |

Recommendation: **B** if a dependency is acceptable, otherwise **A** with the preview. Decision needed from the PM.

## 5. Regression test plan (to implement together with the fix)

1. Convert the three `it.fails` demonstrations in `phone-normalization.defect.test.ts` to plain `it` and remove the "current behaviour" block.
2. Table test, per calling-code length (1–4 digits) and per country family: national number starting with the code (the three cases above plus `+44`, `+33`, `+1`), without code, with trunk zero, with `+<cc>` and `00<cc>` markers, with other separators (`()-`, spaces).
3. Marker mismatch (`+44…` while `+98` is selected): error or picker switch per the decision.
4. Idempotence: `normalize(normalize(x)) === normalize(x)` and the server re-check `validate.ts:332` accepts every output.
5. Payload test (`payload-v2.test.ts`): `whatsapp_phone_normalized` equals `onboarding_prefill["ON-06.n"]` for the new cases.
6. Cross-app contract test: Consultation E.164 output → Onboarding `nationalPhoneFromPrefill` → Onboarding validation, for the same table.
7. Keep the passing guard "server re-check accepts a correct E.164 value".
8. UI test (when a DOM test library is available or via static render): helper text and the marker/mismatch messages.

## 6. Compatibility implications of the behaviour change

- **Stored records:** old lossy values stay wrong; they cannot be recomputed. A re-check of existing records is only possible by contacting the person; the affected population (numbers whose national part starts with the calling code) is unknown without reading customer data, which must not be copied into tests or documents.
- **Deduplication:** the corrected value differs from the old lossy value for the same person, so a returning lead could be seen as new by phone (e-mail is the second key). Decide whether to add a migration note for the CRM owner.
- **Consultation → Onboarding:** no Onboarding change is needed. The payload shape and the equality rule `ON-06.n === whatsapp_phone_normalized` stay. Handoff links already issued (24 h) keep the old value.
- **Option A only:** the existing test `outcome.test.ts:180` (`normalizePhone("+98","989123456789")`) changes meaning and must be updated.
- **Versioning:** if the PM treats this as a contract change, bump or annotate `FORM_VERSION` (currently `consult-2.1.0`); the payload shape itself does not change.

## 7. Decisions required

1. Approve the contract (A or B) and the wording of the helper text / mismatch message.
2. Approve a dependency (B) or the preview UX (A).
3. Decide how to treat existing records and CRM deduplication.
4. Decide whether the Persian-digit rejection is handled in the same change.
