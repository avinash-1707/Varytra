import type { Pool } from 'pg';
import { createComparisonBatch, type ComparisonBatch } from '@varytra/infrastructure/scheduling';
import { withOrganizationTransaction } from '@varytra/infrastructure';
import type { CiPrincipal } from './authorization.js';

export type CiGateStatus = 'pass' | 'warn' | 'fail' | 'pending';

export interface CreateCiRunInput {
  readonly baselineAgentVersionId: string;
  readonly candidateAgentVersionId: string;
  readonly idempotencyKey: string;
  readonly repetitionCount: number;
  readonly scenarioVersionIds: readonly string[];
}

export interface CiRun {
  readonly batch: ComparisonBatch;
  readonly id: string;
}

export function toCiGateStatus(batchStatus: string, reportGateStatus: string | null): CiGateStatus {
  if (reportGateStatus === 'pass') return 'pass';
  if (reportGateStatus === 'block') return 'fail';
  if (reportGateStatus === 'warn' || reportGateStatus === 'review') return 'warn';
  return batchStatus === 'completed' ? 'warn' : 'pending';
}

export async function createCiRun(pool: Pool, principal: CiPrincipal, input: CreateCiRunInput): Promise<CiRun> {
  const batch = await createComparisonBatch(pool, {
    organizationId: principal.organizationId,
    projectId: principal.projectId,
    userId: principal.apiKeyId,
    baselineAgentVersionId: input.baselineAgentVersionId,
    candidateAgentVersionId: input.candidateAgentVersionId,
    scenarioVersionIds: input.scenarioVersionIds,
    repetitionCount: input.repetitionCount,
    idempotencyKey: input.idempotencyKey,
  });
  return withOrganizationTransaction(pool, principal.organizationId, async (client) => {
    const inserted = await client.query<Readonly<{ id: string }>>(
      `INSERT INTO ci_runs (organization_id, project_id, api_key_id, batch_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (organization_id, project_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING id`,
      [principal.organizationId, principal.projectId, principal.apiKeyId, batch.id, input.idempotencyKey],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('CI run insert did not return an ID');
    return { id: row.id, batch };
  });
}

export async function readCiRun(pool: Pool, principal: CiPrincipal, ciRunId: string): Promise<Readonly<{
  readonly batchId: string;
  readonly classification: string | null;
  readonly confidence: string | null;
  readonly gateStatus: CiGateStatus;
  readonly id: string;
  readonly reportId: string | null;
  readonly severity: string | null;
}>> {
  return withOrganizationTransaction(pool, principal.organizationId, async (client) => {
    const result = await client.query<Readonly<{
      batchId: string;
      classification: string | null;
      confidence: string | null;
      id: string;
      reportId: string | null;
      severity: string | null;
      status: string;
      reportGateStatus: string | null;
    }>>(
      `SELECT ci.id, ci.batch_id AS "batchId", batch.status,
              report.id AS "reportId", report.classification, report.severity, report.confidence,
              COALESCE(decision.resulting_gate_status, report.gate_status) AS "reportGateStatus"
       FROM ci_runs ci
       JOIN comparison_batches batch ON batch.id = ci.batch_id
       LEFT JOIN comparisons report ON report.batch_id = batch.id
       LEFT JOIN LATERAL (
         SELECT resulting_gate_status FROM review_decisions
         WHERE comparison_id = report.id
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) decision ON true
       WHERE ci.id = $1 AND ci.project_id = $2
       ORDER BY CASE COALESCE(decision.resulting_gate_status, report.gate_status)
         WHEN 'block' THEN 1 WHEN 'review' THEN 2 WHEN 'warn' THEN 3 WHEN 'pass' THEN 4 ELSE 5 END,
         report.created_at ASC NULLS LAST LIMIT 1`,
      [ciRunId, principal.projectId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('CI run not found');
    const gateStatus = toCiGateStatus(row.status, row.reportGateStatus);
    return { id: row.id, batchId: row.batchId, reportId: row.reportId, classification: row.classification, severity: row.severity, confidence: row.confidence, gateStatus };
  });
}
