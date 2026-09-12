# Varytra

Varytra is a regression-intelligence platform for tool-using AI agents. It compares a trusted baseline with a candidate agent across controlled scenarios, identifies material behavior changes, and produces evidence for release decisions.

Agent runs are stochastic. A different sequence of tool calls is not automatically a regression. Varytra distinguishes harmless variation from changes that affect final state, policy compliance, safety, reliability, latency, or cost.

## What It Does

1. Stores versioned scenarios, policies, and agent configurations.
2. Runs baseline and candidate agents in paired, controlled executions.
3. Captures raw, redacted, and normalized trace artifacts separately.
4. Aligns executions and runs deterministic checks before semantic evaluation.
5. Produces an immutable, redacted comparison report and CI gate result.
6. Lets authorized reviewers record release decisions and turn confirmed regressions into future scenarios.

## Current Scope

The repository includes a working vertical slice for tenant-aware projects, versioned comparison inputs, controlled reference runs, artifact lineage, report review, CI submission, and retention cleanup.

Current worker execution supports the controlled reference environment. Registered HTTP agent versions can be recorded, but their worker executor is not implemented yet. Varytra does not execute customer-supplied code, containers, or arbitrary URLs in shared workers.

## Architecture

```text
Browser / CLI / GitHub Action
              |
              v
        Fastify API <------> PostgreSQL
              |
              v
      Redis and BullMQ delivery
              |
              v
       Node.js comparison worker
        |             |             |
        v             v             v
 Reference env   Cloudinary     Judge provider
```

PostgreSQL is the authoritative record for tenant data, comparison lifecycle, leases, retries, idempotency, reports, and audit events. Redis and BullMQ only deliver work. Cloudinary stores private artifacts. The browser communicates only with the API.

## Repository Layout

```text
apps/
  api/        Fastify API, authentication, authorization, and CI endpoints
  cli/        Command-line client for CI submission and status checks
  web/        Vite and React browser application
  worker/     BullMQ consumer, run execution, artifact handling, and cleanup
packages/
  alignment/              Execution alignment and divergence localization
  evaluation/             Deterministic checks, verdict aggregation, judge boundary
  infrastructure/         PostgreSQL, Cloudinary, queue, scheduling, and migrations
  normalization/          Versioned trace normalization and redaction rules
  reference-environment/  Resettable support-ticket reference environment
  runtime/                Validated runtime configuration and safe logging
  schemas/                Shared Zod contracts and inferred TypeScript types
tests/                    Unit, integration, benchmark, and accessibility coverage
```

Each application has a focused README:

- [`apps/web`](apps/web/README.md)
- [`apps/api`](apps/api/README.md)
- [`apps/worker`](apps/worker/README.md)
- [`apps/cli`](apps/cli/README.md)

## Prerequisites

- Node.js 22 or later
- pnpm 11.20.0
- Docker Compose for local PostgreSQL and Redis
- A configured SMTP server for API startup

Cloudinary credentials are required to persist run artifacts. Google OAuth and an LLM judge provider are optional integrations and require their own credentials.

## Local Setup

Install dependencies:

```bash
pnpm install
```

Create a local environment file and replace placeholder secrets with safe local values:

```bash
cp .env.example .env
```

Start PostgreSQL and Redis:

```bash
docker compose up -d
```

Load the environment into the current shell, then apply migrations:

```bash
set -a
source .env
set +a
pnpm db:migrate
```

Start the web app, API, and worker together:

```bash
pnpm dev
```

`pnpm dev` does not load `.env` automatically. Run it in the shell where the environment was loaded. The web application starts on `http://localhost:5173`; the API defaults to `http://localhost:3000`.

The web app uses same-origin `/v1` requests and this repository does not yet configure a Vite development proxy. For an authenticated local browser workflow, place the web app and API behind a local reverse proxy or add an explicit development proxy configuration.

## Environment Variables

`.env.example` contains the local configuration shape. Do not commit real values.

| Variable | Used by | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | API, worker, migrations | PostgreSQL connection string |
| `APP_URL` | API | Browser application origin trusted by authentication |
| `BETTER_AUTH_URL` | API | Public API and Better Auth origin |
| `BETTER_AUTH_SECRET` | API | Better Auth secret, at least 32 characters |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | API, worker | OTP and review-notification email delivery |
| `REDIS_URL` | API, worker | Redis and BullMQ connection string |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Worker | Private artifact storage |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | API | Optional Google sign-in, configured as a pair |
| `VARYTRA_WORKER_ORGANIZATION_IDS` | Worker | Optional comma-separated organization IDs for reconciliation |
| `HOST`, `PORT`, `LOG_LEVEL` | API, worker | Optional runtime overrides |

The API needs a complete SMTP configuration at startup. The worker can start without Cloudinary, but comparison runs will fail safely because required artifacts cannot be persisted.

## Verification

Run the standard checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @varytra/web build
pnpm test:a11y
```

For database-backed tests, PostgreSQL must be running and `DATABASE_URL` must be exported:

```bash
pnpm db:migrate
pnpm test
```

Run the local benchmark and load-cost checks separately:

```bash
pnpm test -- benchmark
pnpm test:load-cost
```

## CI Integration

The repository includes a local GitHub Action at [`.github/actions/varytra-gate`](.github/actions/varytra-gate/action.yml). It starts a comparison through the CI API and returns opaque CI-run and batch IDs.

```yaml
- name: Start Varytra comparison
  uses: ./path/to/varytra/.github/actions/varytra-gate
  with:
    api-url: ${{ vars.VARYTRA_API_URL }}
    api-key: ${{ secrets.VARYTRA_API_KEY }}
    project-id: ${{ vars.VARYTRA_PROJECT_ID }}
    baseline-agent-version-id: ${{ vars.VARYTRA_BASELINE_AGENT_VERSION_ID }}
    candidate-agent-version-id: ${{ vars.VARYTRA_CANDIDATE_AGENT_VERSION_ID }}
    scenario-version-ids: ${{ vars.VARYTRA_SCENARIO_VERSION_IDS }}
    idempotency-key: ${{ github.run_id }}-${{ github.run_attempt }}
```

Create a project-scoped API key with CI permissions through the API before using the action. Never place the key in workflow source.

## Security Model

- Fastify authorizes every protected request.
- PostgreSQL row-level security constrains tenant-owned data inside transaction-scoped organization context.
- Raw traces, prompts, tool payloads, and secrets are excluded from logs, queue messages, telemetry, and default report views.
- Cloudinary artifacts use authenticated delivery and short-lived authorized URLs.
- Deterministic checks run before the optional semantic judge.
- Malformed, unavailable, or low-confidence semantic results are inconclusive, never passes.

## External Validation Still Required

The local suite does not validate external provider behavior. Before production use, configure and exercise:

- Cloudinary artifact upload, private delivery, and deletion
- SMTP delivery for verification, recovery, and review notifications
- Google OAuth callback and explicit account linking, if enabled
- A provider-specific semantic judge, including real cost and latency measurement

## License

No license has been declared for this repository. Do not assume permission to reuse, distribute, or modify it until a license is added.
