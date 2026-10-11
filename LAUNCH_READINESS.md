# Six2Fit consult + onboarding launch readiness

## What this project now does

The consultation form no longer pretends to write to CRM. It submits a validated JSON payload to the same-origin server endpoint:

`POST /api/consult/submit`

The browser sends an `Idempotency-Key` equal to `submission_id`. The same id is reused when the user retries a failed network request, so a retry cannot silently create a second consultation. The endpoint must return `{ ok: true, crm_record_id, deduplicated }` or an explicit error. A `409` is treated as an idempotency conflict. No Zoho credentials are present in the client.

The consultation payload now includes an explicit `onboarding_prefill` candidate containing only directly answered, unambiguous values:

| Consult value | Onboarding key |
|---|---|
| full name | `ON-01` |
| sex | `ON-03` |
| WhatsApp country | `ON-06.iso` |
| WhatsApp dial code | `ON-06.cc` |
| normalized WhatsApp number | `ON-06.n` |
| email | `ON-07` |
| height | `ON-08` |
| weight | `ON-09.kg` |
| preferred timezone | `timezone` |

Age is deliberately not mapped to date of birth, and consultation goals/readiness are deliberately not forced into unrelated onboarding fields. The server can apply an approved mapping after reviewing the real field definitions.

## Required backend path

The client still needs a server implementation for `/api/consult/submit`. That server must:

1. validate the payload against the published form version;
2. atomically claim `(tenant/org, submission_id)` before CRM side effects;
3. deduplicate by normalized WhatsApp, then email, with an explicit ambiguity policy;
4. create or update the Consult/Lead according to the approved CRM workflow;
5. persist the canonical consult submission and its outcome/audit trail;
6. return the stable CRM record reference without exposing Zoho tokens.

The browser must never choose a CRM record ID. The server should return an opaque continuation/order reference only if the next workflow requires it.

## Onboarding prefill flow

The onboarding form already expects a separate server bootstrap:

`GET /api/onboarding/bootstrap`

That endpoint must resolve the current authenticated user and trusted order/Consult context, then select exactly one eligible Requests record. It should retrieve the canonical Consult data from the server-side store/CRM, apply the approved mapping above, and return:

```json
{
  "form_session_token": "opaque short-lived token",
  "scope": "Diet | Training | Combo | CIP",
  "entitlements": [],
  "prefill": {},
  "expires_at": "2026-10-11T12:00:00.000Z"
}
```

Zero matches, multiple matches, expired order/consult state, or missing ownership must stop the form. A browser-provided Request/Deal/Contact id must be ignored. The token must bind user/session, tenant, selected Request, allowed prefill fields and expiry.

The onboarding submit endpoint must re-authorize that token, atomically claim its own submission id, write validated answers/files, and attach the result to the same resolved Request. It must not trust the prefill values sent by the browser as authoritative CRM data.

## Launch blockers still requiring access or decisions

- The backend repository/runtime that owns both endpoint implementations is not included in this project.
- The authenticated identity mechanism and the trusted link from Consult → Contact/Deal/Sales Order → Request are not specified here.
- The approved Zoho API field map for Consult and Requests, duplicate policy, and status transition policy are still required.
- Production OAuth secrets, storage credentials, schema manifest, monitoring and rollback configuration are still required.

No Zoho Production change has been made by this checkpoint, and no real customer record was used.
