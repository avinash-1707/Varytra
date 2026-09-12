# Varytra API

The API is the Varytra control plane. It is a Fastify service that owns authentication, request validation, authorization, tenant context, lifecycle commands, and safe response projections.

## Responsibilities

- Serve Better Auth routes at `/api/auth/*`.
- Authenticate users and CI API keys.
- Resolve organization membership and role permissions.
- Create organizations, projects, versioned scenarios, policies, and agent versions.
- Create, read, and monitor comparison batches.
- Return redacted reports and accept authorized review decisions.
- Create and query CI runs.
- Publish validated run dispatches to BullMQ when Redis is configured.

The API does not execute agent runs or perform comparison evaluation. Those responsibilities belong to the worker and shared packages.

## Run Locally

The API requires PostgreSQL, valid Better Auth configuration, and SMTP configuration at startup.

```bash
set -a
source .env
set +a
pnpm --filter @varytra/api dev
```

The development command sets `NODE_ENV=development` and `SERVICE_NAME=varytra-api`. The service listens on port `3000` by default. Set `PORT` to override it.

Check the process with:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{ "status": "ok" }
```

## Required Configuration

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection URL |
| `APP_URL` | Valid browser application URL |
| `BETTER_AUTH_URL` | Valid API public URL |
| `BETTER_AUTH_SECRET` | At least 32 characters |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Valid SMTP transport configuration |

Optional configuration:

| Variable | Purpose |
| --- | --- |
| `REDIS_URL` | Enables immediate BullMQ dispatch publishing |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables Google sign-in; both must be set together |
| `HOST`, `PORT`, `LOG_LEVEL` | Runtime overrides |

## Authentication and Authorization

Email/password sign-in requires verified email OTP. Password resets revoke active sessions. Google linking is explicit, requires a recent session, and cannot remove the final usable sign-in method.

For tenant-owned routes, the API resolves the authenticated user's organization membership, checks the required capability, then runs database access in a transaction-scoped organization context. Browser-supplied organization IDs are never accepted as authorization.

## Route Groups

| Route group | Purpose |
| --- | --- |
| `/api/auth/*` | Better Auth authentication and account management |
| `/v1/organizations` | Organization and membership administration |
| `/v1/projects` | Project lifecycle and audit projections |
| `/v1/projects/:projectId/*` | Versioned inputs, trends, and scoped API keys |
| `/v1/comparison-batches/*` | Batch creation, status, and safe progress |
| `/v1/comparisons/:comparisonId/*` | Redacted reports, review, and regression-scenario creation |
| `/v1/ci-runs/*` | CI comparison submission and status |

Use the CLI or repository-local GitHub Action for CI integration. Do not treat this README as a complete OpenAPI contract.

## Commands

```bash
pnpm --filter @varytra/api dev
pnpm --filter @varytra/api typecheck
```
