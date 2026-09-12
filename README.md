# Varytra

Varytra helps teams evaluate changes to tool-using AI agents.

Agent behavior can vary between runs. A different path is not always a problem, but it can signal a regression in outcome quality, safety, state integrity, reliability, cost, or latency.

Varytra compares a baseline agent with a candidate across controlled scenarios, identifies meaningful divergence, and provides the evidence needed to make a release decision.

## Local database

Copy `.env.example` to `.env` and start PostgreSQL with `docker compose up -d postgres`.

Load the local URL before database commands:

```bash
set -a; source .env; set +a
pnpm db:migrate
pnpm test -- migrations
pnpm test -- rls-foundation
```

## Launch evidence

Run the local evidence suite after PostgreSQL is available:

```bash
DATABASE_URL=postgres://varytra:varytra@127.0.0.1:5432/varytra pnpm db:migrate
DATABASE_URL=postgres://varytra:varytra@127.0.0.1:5432/varytra pnpm test
pnpm test:a11y
pnpm test:load-cost
```

The reference benchmark demonstrates harmless variation and an unsafe refund regression without customer data. The browser audit checks automatically detectable WCAG A/AA issues on the unauthenticated workspace; manual accessibility review remains required. Provider-backed judge cost/latency, SMTP delivery, and Google OAuth callback validation require configured external credentials and are not claimed by the local suite.
