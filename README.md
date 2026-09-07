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
