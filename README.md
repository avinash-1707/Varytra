# Varytra

Varytra is a regression-intelligence platform for stochastic, tool-using AI agents. It compares baseline and candidate runs to distinguish acceptable trajectory variation from meaningful regressions in outcomes, safety, state integrity, reliability, or efficiency.

The MVP is full TypeScript: Vite + React for the web app, Fastify for the API, Node.js workers for comparisons, PostgreSQL for product and job state, Redis/BullMQ for job delivery, and S3-compatible storage for immutable trace artifacts.
