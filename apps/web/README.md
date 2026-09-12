# Varytra Web

The web application is the Varytra browser interface. It is a Vite-built React single-page application that consumes authorized, redacted API projections only.

It never connects directly to PostgreSQL, Redis, Cloudinary, or provider credentials.

## Responsibilities

- Present the public landing page.
- Display project records for the active organization.
- Let authorized users create projects and inspect immutable scenario and agent versions.
- Show safe batch-progress accounting without trace payloads or artifact links.
- Render redacted comparison reports and accept authorized reviewer decisions.

## Run Locally

From the repository root:

```bash
pnpm --filter @varytra/web dev
```

Vite serves the application at `http://localhost:5173` by default. Start the API separately at `http://localhost:3000` for backend services.

For the full local stack, load the root `.env` file and run `pnpm dev` from the repository root.

## Commands

```bash
pnpm --filter @varytra/web dev
pnpm --filter @varytra/web build
pnpm --filter @varytra/web typecheck
pnpm test:a11y
```

`build` runs TypeScript checking before producing the Vite bundle. `test:a11y` is the repository-level Chromium and Axe accessibility audit.

## API Contract

The application uses same-origin API paths such as `/v1/projects` and `/v1/comparisons/:comparisonId/report`. This repository does not currently include a Vite development proxy, so an authenticated local browser workflow requires a reverse proxy or an explicit Vite proxy configuration.

Protected requests include browser credentials and, when selected, the `x-varytra-organization` header. That header selects context only. The API resolves membership and authorization server-side.

## Data Boundaries

The UI displays safe projections, including project metadata, version identifiers, progress counts, report classifications, redacted findings, and reviewer decisions.

It must not render raw prompts, raw traces, tool arguments or results, adapter secrets, Cloudinary credentials, or unrestricted artifact URLs.

## Main Entry Points

- `src/main.tsx`: React bootstrap
- `src/app.tsx`: Landing, workspace, project, version-selection, and batch-progress surfaces
- `src/report.tsx`: Authorized comparison-report and review interface
- `src/onboarding.tsx`: First-run guidance
- `src/styles.css`: Application styling
