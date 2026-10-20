# DEF-05 — Consultation phone normalization drops valid digits

Status: **implemented locally on `fix/consult-ui-batch1` (2026-10-18, PM-approved Contract A), not committed.** Sections 1-7 are the original analysis and are kept as written; section 8 records what was implemented and what remains open.

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

## 8. Implementation (amendment, 2026-10-18) — Contract A

Approved by the PM: input starting with `+` or `00` is explicitly international; no marker means a national number for the selected country; leading digits that equal the dial code are never removed; valid input becomes E.164; invalid or ambiguous input is rejected, not guessed.

**Code:** `parseWhatsappPhone` / `normalizePhone` in `src/features/consult/outcome.ts` (`normalizePhone` returns "" for rejected input); `contactSchema.superRefine` in `schema.ts` shows a Persian message per rejection reason on the phone field; helper text under the field in `ConsultForm.tsx` (copy needs PM approval). The server re-check (`validate.ts`) is unchanged and now applies the same rules to the stored value.

**Rules:** separators ` ()-` ignored; one leading 0 of a national number is the trunk prefix; after an explicit marker the digits must start with the selected dial code (else COUNTRY_CODE_MISMATCH) and a 0 right after the code is rejected; national part 7-13 digits (the range Onboarding accepts), at most 15 digits in total. **Two country-specific guards go beyond the previous contract and need PM confirmation:** (1) +1 and +7 national numbers must be exactly 10 digits (rejects "1 416..." and "8 701..." typed with a trunk prefix); (2) +39 and +379: a national input starting with 0 is ambiguous and rejected (the 0 is part of Italian numbers; it is accepted after an explicit +39). They exist only to fail closed.

**Intended behaviour change:** a calling code typed without + or 00 is now part of the national number (before, "989123456789" with +98 became +989123456789; now +98989123456789). The old Iranian assertion in `outcome.test.ts` was updated to the explicit `+98 912 345 6789` form.

**Tests:** `phone-normalization.test.ts` replaces `phone-normalization.defect.test.ts`; the three former `it.fails` demonstrations (India 91…, Kazakhstan/Russia 7…, Iran 98…) are now plain passing tests. Coverage: Canada/US, Iran, India, Kazakhstan, UAE, explicit + and 00, national numbers starting with their own dial code, mismatched country codes, malformed input, schema messages, and Consultation payload → server validation → `onboarding_prefill["ON-06.n"]` equality. Onboarding side: a golden E.164 table in `src/server/onboarding/consult-handoff-phone.test.ts` (fix/onboarding-ui-batch1) checks that `nationalPhoneFromPrefill` returns 7-13 digits and dial code + national reproduces the stored value.

**Unresolved edges (fail closed or unknown):** Italian/Vatican landline national input without + is rejected (must be typed with +39); other countries where a leading 0 is significant, or with trunk prefixes other than 0 (for example Russia/Kazakhstan 8 outside the 10-digit guard), are not modelled; Kazakhstan has no country entry and relies on +7; Persian/Arabic digits are still rejected by the existing field regex; records already stored with a dropped digit cannot be repaired automatically; the server re-check now rejects a stored E.164 whose national part is under 7 or over 13 digits, and the CRM deduplication key changes for inputs that previously lost digits.

## 9. Final contract review (amendment, 2026-10-18)

The parser is an MVP input contract, **not** a general international phone validator; it uses no numbering-plan metadata.

**Country-specific rules after the review (all other countries use the generic rules):**
- `+1` and `+7` — KEPT: the national number must be exactly 10 digits (NANP; Russia and Kazakhstan share +7 with 10-digit numbers). Source: ITU-T E.164 numbering plans. It cannot reject a legitimate number; it only rejects "1 416…" or "8 701…" typed with a prefix. NARROWED: no trunk 0 is stripped for these codes (a leading 0 now yields WRONG_LENGTH instead of being silently removed).
- `+39` — CHANGED: the previous rule rejected national input starting with 0, which refused legitimate Italian landlines. Italy has no trunk prefix and the 0 is part of the number, so it is now kept: "06 1234 5678" → +390612345678.
- `+379` — REMOVED: not in the country list and not used in practice (Vatican numbers use +39 06 698…).
- `ZERO_AMBIGUOUS` rejection reason and its message were removed (no longer reachable).

**Final rules:** `+`/`00` first = international (digits must start with the selected dial code, no 0 right after it except Italy); otherwise national; digits equal to the dial code are never removed; one leading 0 is removed as a trunk prefix (not for +1, +7, +39); national part 7-13 digits, at most 15 in total; separators ` ()-` ignored; anything else is rejected.

**Limitations (documented, not invented):** countries where the leading 0 is significant other than Italy are not modelled — for example Côte d'Ivoire (+225) and Benin (+229) now include a leading 0 in their numbers; none is in the current country list, but adding them needs metadata or an explicit PM rule; other fixed-length or prefix rules are not validated; the 7-digit minimum follows Onboarding and would reject territories with shorter numbers; Persian digits stay rejected by the field regex.

**Persian copy:** helper "شمارهٔ ملی را بدون کد کشور بنویسید. برای شمارهٔ بین‌المللی، آن را با + یا 00 و کد کشور شروع کنید." and one message per rejection reason in `schema.ts` (`phoneRejectionMessage`).

## 10. Decision: use libphonenumber (amendment, 2026-10-18) — supersedes the hand-written country rules of sections 8 and 9

The PM asked for the standard that Google uses instead of hand-written country rules. The parser now uses **libphonenumber-js 1.13.15** (`libphonenumber-js/min`, the JavaScript port of Google's libphonenumber; exact version pinned in `package.json`). Valid lengths and patterns, trunk prefixes and significant leading zeros come from its metadata; the hand-written `+1`/`+7` 10-digit rule, the Italy zero rule and the generic trunk-zero rule were removed.

**Contract (unchanged from the PM-approved MVP):** `+` or `00` = explicitly international (digits must start with the selected calling code, else COUNTRY_CODE_MISMATCH); otherwise a national number for the selected calling code (trunk prefixes handled by the library: Iran 0, UK 0, Russia/Kazakhstan 8, Italy keeps 0); accepted numbers are normalized to E.164; the national part must be 7-13 digits (Onboarding range). **One rule kept on top of the library:** if parsing a national input would drop leading digits equal to the calling code ("1 416…", "91 98765…", "989123456789" with +98), the input is rejected (LEADING_CALLING_CODE) instead of guessed.

**Rejection reasons:** EMPTY, MISSING_DIAL_CODE, INVALID_CHARACTERS, COUNTRY_CODE_MISMATCH, LEADING_CALLING_CODE, INVALID_NUMBER (not a valid number for that calling code), TOO_SHORT/TOO_LONG (Onboarding range only). `WRONG_LENGTH`, `ZERO_AFTER_COUNTRY_CODE` and `ZERO_AMBIGUOUS` no longer exist.

**Behaviour to note:** the check is stricter than before because it validates the number pattern (invented numbers such as "912 345 678" for Iran or UAE "971 234 567" are rejected); "+98 0912…" (zero after the code) is accepted and normalized the way libphonenumber does; "8 701…" for +7 is accepted because 8 is the real Russian/Kazakh trunk prefix.

**Limits:** libphonenumber validates the pattern, not that the number exists or has WhatsApp; the "min" metadata does not distinguish number types; +1 and +7 are shared by several countries, so validity is checked per calling code (the library picks the country); metadata ages and needs periodic library updates; the dependency adds bundle size to the browser form (to be measured in a real build, not run). Persian digits are still rejected by the existing field regex. Records stored earlier with dropped digits are not repaired.

**Repository note:** `package.json` and `package-lock.json` changed (`bun.lock` was not regenerated). The worktree's `node_modules` was a junction to the original repository; it was replaced by a worktree-local `npm ci` so that the original repository's `node_modules` stays untouched. The Onboarding golden table (`consult-handoff-phone.test.ts`) only tests the round trip and includes UAE `+971971234567`, which libphonenumber considers invalid; it is harmless but unrealistic.

## 11. Digit scripts, placeholder, final copy (amendment, 2026-10-19)

**Correction to section 10:** `libphonenumber-js/min` validates length and the general national-number pattern only. It is not exhaustive validation: it accepts some unassigned numbers that the "max" metadata rejects (for example +981234567890) and does not detect number types. "Pattern validation" in section 10 and in earlier comments overstated this; code comments were corrected. "max" is stricter but can also reject new valid ranges when its metadata lags.

**Digit normalization (PM-approved):** `toAsciiDigits` (`outcome.ts`) converts Persian (U+06F0-06F9) and Arabic-Indic (U+0660-0669) digits to ASCII; no other character is touched. It runs (1) on input in `ConsultForm` so the field shows ASCII digits, (2) in `contactSchema` (preprocess) before the character check, and (3) first in `parseWhatsappPhone`, so `normalizePhone` and `buildPayload` always produce ASCII E.164. The server receives only the E.164 value (`whatsapp_phone_normalized`); `validate.ts` requires `^+d{7,15}$` (ASCII), so a direct API submission with Persian or Arabic-Indic digits in that field is rejected, not converted. Letters, other punctuation and Arabic separators are still rejected (INVALID_CHARACTERS).

**Placeholder:** `phonePlaceholder(iso)` (`phonePlaceholder.ts`) returns the national-format example mobile number of the selected country from `libphonenumber-js/examples.mobile.json` (about 4 KB, already part of the installed package; no new dependency, no handwritten table) and falls back to «شماره واتساپ». It only sets the placeholder attribute; the value and the selected country are unchanged. A test checks that every example is accepted by the phone contract for its calling code.

**Final copy:** helper and the four messages INVALID_NUMBER, COUNTRY_CODE_MISMATCH, LEADING_CALLING_CODE and INVALID_CHARACTERS use the PM-approved wording in `schema.ts`. The existing field messages («شماره واتساپ معتبر نیست», «…فقط می‌تواند شامل عدد باشد» for letters) and TOO_SHORT/TOO_LONG were kept.

**Limitations:** no DOM test environment exists in this project, so the live placeholder update and the on-input conversion are covered by function tests plus a source-wiring test, not by a rendered-component test; replacing a typed character may move the caret to the end when editing in the middle of the number; the Persian fallback placeholder sits left-aligned in the LTR input.
