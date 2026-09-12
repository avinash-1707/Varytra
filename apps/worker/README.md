# Varytra Worker

The worker executes queued comparison runs and performs durable background maintenance. It consumes BullMQ deliveries but treats PostgreSQL as the authoritative source for run state, leases, retries, and idempotency.

## Responsibilities

- Claim eligible runs with a lease token.
- Execute the controlled reference environment for supported reference agents. Registered HTTP execution is not implemented yet.
- Normalize captured traces.
- Persist raw, redacted, and normalized artifacts to Cloudinary.
- Record run outcomes and artifact lineage in PostgreSQL.
- Recover expired run leases and reconcile pending dispatches.
- Delete expired artifacts after durable retention tombstones are recorded.
- Deliver review notifications from the PostgreSQL outbox.

## Run Locally

Start PostgreSQL and Redis, load the root environment, apply migrations, then run the worker:

```bash
docker compose up -d postgres redis
set -a
source .env
set +a
pnpm db:migrate
pnpm --filter @varytra/worker dev
```

The development command sets `NODE_ENV=development` and `SERVICE_NAME=varytra-worker`.

## Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection for leases, outcomes, artifacts, and notifications |
| `REDIS_URL` | BullMQ queue connection |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Authenticated artifact storage |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` | Review-notification delivery |
| `VARYTRA_WORKER_ORGANIZATION_IDS` | Optional comma-separated organization IDs to reconcile at startup |

If `DATABASE_URL` or `REDIS_URL` is absent, the process runs a no-op startup path and exits. If Cloudinary is not configured, the worker starts but marks executed runs as infrastructure failures because it cannot persist required artifacts.

## Reliability Rules

- Queue messages contain opaque dispatch and organization identifiers, not traces or secrets.
- A run is successful only after all required artifact records and content hashes persist.
- Duplicate queue delivery is safe because the worker claims leased work from PostgreSQL.
- SMTP failures remain in the durable outbox for later retry.
- Artifact retention tombstones are persisted before remote deletion so cleanup can be retried safely.

## Commands

```bash
pnpm --filter @varytra/worker dev
pnpm --filter @varytra/worker typecheck
```
