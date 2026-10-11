# Staging runbook — Six2Fit Consult

This repository is configured for a local `staging` mode. It is intentionally not connected to Zoho Production.

```bash
cp .env.staging.example .env.staging
npm install
npm test -- --run
npm run build:staging
npm run dev:staging
```

The browser calls the same-origin `/api/consult/submit` endpoint. A staging backend must provide that route, durable idempotency, synthetic CRM credentials or a CRM Sandbox adapter, and non-production file storage. Never put OAuth client secrets, refresh tokens, signing keys, or Zoho org credentials in `VITE_*` values.

A successful UI build does not mean the server route or Zoho integration exists.
