# AGENTS.md

**Varytra** is a regression-intelligence platform for stochastic, tool-using AI agents. It compares baseline and candidate runs, localizes material divergence, and produces evidence-backed release decisions.

**Stack:** Vite + React + TypeScript · Fastify + Node.js · PostgreSQL · Redis + BullMQ · Cloudinary · Better Auth · OpenTelemetry.

## Documentation Availability

`docs/` is intentionally local and private. Autonomous implementation work must run in this configured workspace, where the documentation corpus is available. Do not commit, copy, or reconstruct private planning material in the public repository.

## Read First

1. `docs/planning/progress-tracker.md` - what is actually built and the active milestone.
2. The routing table below.
3. `docs/engineering/architecture.md` and `docs/engineering/data-model-and-security.md` before changing a shared boundary.
4. `docs/design/design.md` before building or styling UI.

## Docs

| Document | Use it for |
| --- | --- |
| `docs/product/project-overview.md` | Product thesis, scope, non-goals, and success measures |
| `docs/product/product-requirements.md` | Functional requirements, acceptance criteria, and priorities |
| `docs/engineering/architecture.md` | Stack, service boundaries, execution path, and API surface |
| `docs/engineering/data-model-and-security.md` | Identity, RLS, redaction, artifacts, and security controls |
| `docs/design/design.md` | Visual direction, tokens, components, accessibility, and motion |
| `docs/product/user-flows.md` | End-to-end account, onboarding, integration, release, and retention journeys |
| `docs/product/ux-flows.md` | Screen-level information architecture, states, and interactions |
| `docs/engineering/evaluation-strategy.md` | Comparison-engine validation methodology and limits |
| `docs/planning/delivery-roadmap.md` | Milestones, sequencing, risks, and definition of done |
| `docs/planning/build-plan.md` | Independent implementation units, dependencies, and definitions of done |
| `docs/engineering/CODING_STANDARDS.md` | Code conventions, trust-boundary rules, testing, and migrations |
| `docs/planning/progress-tracker.md` | Execution status and implementation log |

## Routing

| Task | Read first |
| --- | --- |
| Authentication, account linking, verification, password reset | `docs/engineering/data-model-and-security.md` + `docs/product/product-requirements.md` F1 |
| React screens, colors, typography, motion, responsive behavior | `docs/design/design.md` + `docs/product/ux-flows.md` |
| Onboarding, generic HTTP adapter, CLI, GitHub Action | `docs/product/user-flows.md` + `docs/engineering/architecture.md` |
| Trace contract, alignment, deterministic checks, LLM judge | `docs/engineering/architecture.md` + `docs/engineering/evaluation-strategy.md` |
| Tenant data, raw traces, storage, RLS, audit | `docs/engineering/data-model-and-security.md` |
| CI gate and release status | `docs/product/product-requirements.md` F6 + `docs/product/ux-flows.md` Flow 5 |
| Retention features and regression-scenario loop | `docs/product/product-requirements.md` F7 + `docs/product/user-flows.md` Flow 6 |
| What to build next | `docs/planning/build-plan.md` + `docs/planning/progress-tracker.md` |
| Any code | `docs/engineering/CODING_STANDARDS.md` |

## Non-Negotiables

- TypeScript is strict. Do not introduce Python or a second application runtime without a measured need and documented decision.
- Fastify owns API authorization. The React app never accesses PostgreSQL, Redis, or object storage directly.
- PostgreSQL is authoritative for batch/run status, leases, retries, idempotency, report lineage, and tenant data. Redis/BullMQ delivers jobs only.
- Every tenant-owned database access is authorized in the service layer and constrained by transaction-scoped PostgreSQL RLS.
- Better Auth is self-hosted. Email/password accounts require six-digit verified email OTP before password sign-in; Google account linking is explicit after reauthentication; password reset revokes active sessions.
- Raw traces, prompts, tool payloads, secrets, and customer data never enter source control, normal logs, queue payloads, telemetry attributes, or default report views.
- Deterministic checks run before any LLM judge. A malformed, unavailable, or low-confidence judge result is `inconclusive`, never silently passed.
- V1 supports the controlled reference environment and registered HTTP endpoints only. Do not execute customer-supplied code, containers, or arbitrary URLs in shared workers.
- Each confirmed regression should be convertible into a versioned scenario, strengthening future CI gates.

## When Done

- Update `docs/planning/progress-tracker.md` with the completed milestone work, verification, deviations, and blockers.
- Update the source document when implementation changes a documented contract or a deliberate product decision.
- Run the relevant tests, lint, typecheck, and a security review for changed trust boundaries before dependent work proceeds.
- Use `pnpm` for dependencies and scripts once the workspace is scaffolded. Verify external-library usage against current official documentation before implementation.

<!-- Added: 2026-09-07 -->
## Commit Granularity
Split implementation milestones into independently coherent, buildable commits (for example, reusable foundation plus consuming integration), rather than one commit per milestone. Do not combine an entire build-plan unit into a single commit when it contains separable concerns.

<!-- Added: 2026-09-07 -->
## Artifact Storage
Use Cloudinary rather than S3-compatible object storage for Varytra artifacts. Update the architecture and security contract before replacing the existing S3 implementation.
