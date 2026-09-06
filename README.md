# Varytra

Varytra is a regression-intelligence platform for stochastic, tool-using AI agents. It compares baseline and candidate runs to distinguish acceptable trajectory variation from meaningful regressions in outcomes, safety, state integrity, reliability, or efficiency.

The MVP uses a Next.js/TypeScript frontend, a Python/FastAPI comparison service, PostgreSQL for product and job state, Redis/Dramatiq workers, and S3-compatible storage for immutable trace artifacts.
