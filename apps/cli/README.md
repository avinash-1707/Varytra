# Varytra CLI

The Varytra CLI is a small command-line client for CI systems and scripts. It starts a comparison using a project-scoped CI API key, then reads the resulting CI run status.

The command outputs JSON so an automation system can consume the response directly.

## Run from the Workspace

Use `tsx` through pnpm while working from this repository:

```bash
pnpm exec tsx apps/cli/src/main.ts <command> <flags>
```

The package declares a `varytra` binary, but it is source-only today. Use the `tsx` command above until a distributable JavaScript build is added.

## Start a Comparison

```bash
pnpm exec tsx apps/cli/src/main.ts start \
  --api-url https://varytra.example.com \
  --api-key "$VARYTRA_API_KEY" \
  --project-id "$VARYTRA_PROJECT_ID" \
  --baseline-agent-version-id "$VARYTRA_BASELINE_AGENT_VERSION_ID" \
  --candidate-agent-version-id "$VARYTRA_CANDIDATE_AGENT_VERSION_ID" \
  --scenario-version-ids "$VARYTRA_SCENARIO_VERSION_IDS" \
  --idempotency-key "$CI_PIPELINE_ID" \
  --repetition-count 3
```

`--scenario-version-ids` accepts comma-separated immutable scenario-version UUIDs. `--repetition-count` defaults to `1`.

## Read CI Run Status

```bash
pnpm exec tsx apps/cli/src/main.ts status \
  --api-url https://varytra.example.com \
  --api-key "$VARYTRA_API_KEY" \
  --ci-run-id "$VARYTRA_CI_RUN_ID"
```

Exit codes for `status`:

| Code | Meaning |
| --- | --- |
| `0` | The CI run has a non-failing terminal status |
| `1` | The CI run failed |
| `2` | The CI run is pending, or the command input/request failed |

## Requirements

- The API URL must point to a running Varytra API.
- The API key must be project-scoped and include the appropriate CI permissions.
- The project, scenario, baseline, and candidate identifiers must belong to the key's authorized project.
- The idempotency key must be stable for a single CI attempt.

Never pass API keys as literal values in repository files or shell history. Use your CI platform's secret store.

## Type Check

```bash
pnpm --filter @varytra/cli typecheck
```
