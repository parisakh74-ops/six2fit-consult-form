# Staging runbook — Six2Fit Consult

This repository is configured for a local `staging` mode. It is intentionally not connected to Zoho Production.

```bash
cp .env.staging.example .env.staging
npm install
npm test -- --run
npm run build:staging
npm run dev:staging
```

For a ShetabanHost Node.js application, use the portable build command (works
from PowerShell and Unix shells), then configure Passenger with:

```bash
npm run build:shetaban
```

- Application root: the staging domain document root
- Startup file: `passenger.cjs`
- Node.js: 22.x on the host (verified 22.23.3 in cPanel, 2026-10-13)
- Application mode: production

The server-only environment variables must be entered in cPanel's Node.js
application environment-variable panel; never commit them or expose them as
`VITE_*` variables.

The browser calls the same-origin `/api/consult/submit` endpoint. A staging backend must provide that route, durable idempotency, synthetic CRM credentials or a CRM Sandbox adapter, and non-production file storage. Never put OAuth client secrets, refresh tokens, signing keys, or Zoho org credentials in `VITE_*` values.

A successful UI build does not mean the server route or Zoho integration exists.
