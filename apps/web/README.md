# OpsHub Web

Internal operations platform — frontend shell (Vite + React 19 + Tailwind 4 +
TanStack Router/Query + a typed `openapi-fetch` client).

## Develop

```bash
pnpm install
pnpm dev          # http://localhost:5173 (proxies /v1 and /api/auth → API on :3001)
```

Start the API (`opshub-api`) first. The login page is one "Sign in with Microsoft" button. With no Entra
registration configured locally, sign in as a seeded fixture with `POST /api/auth/test-login {"email":
"admin@opshub.local"}` (needs `IDENTITY_TEST_LOGIN=enabled` in the API's `.env`; never available in production)
and keep the cookie it sets. The API must run on :3001 for the Vite proxy (`PORT=3001`).

## API types

The typed client in `src/shared/api/client.ts` is driven by the OpenAPI document
the API serves at `/api/docs-json`. Regenerate the types once the API is running:

```bash
pnpm codegen      # writes src/shared/api/generated/api.ts
```

## Structure (Feature-Sliced Design)

```
src/
  app/        providers, router, global styles
  pages/      route-level screens (login, dashboard, assets, …)
  widgets/    composite UI blocks (app shell)
  shared/     api client, ui primitives, lib helpers
```
