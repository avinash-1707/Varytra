import { type FormEvent, useEffect, useState } from 'react';

const ORGANIZATION_STORAGE_KEY = 'x-varytra-organization';

export type ReportCoverage = Readonly<{
  expectedPairs: number;
  completePairs: number;
  analyzablePairs: number;
}>;

export type ReportFinding = Readonly<{
  id: string | null;
  category: string;
  severity: string;
  repetition: number | null;
  summary: string | null;
}>;

export type FirstMaterialDivergence = Readonly<{
  baselineSequenceRange: readonly [number, number] | null;
  candidateSequenceRange: readonly [number, number] | null;
  score: number | null;
}>;

export type StateChange = Readonly<{
  field: string;
  baselineValue: string | null;
  candidateValue: string | null;
  relevance: string | null;
}>;

export type StateComparison = Readonly<{
  status: 'available' | 'redacted' | 'unavailable';
  expectedSummary: string | null;
  baselineSummary: string | null;
  candidateSummary: string | null;
  changes: readonly StateChange[];
  redactionReason: string | null;
}>;

export type ReviewDecision = Readonly<{
  id: string | null;
  action: string;
  rationale: string;
  actor: string | null;
  createdAt: string | null;
}>;

export type ComparisonReport = Readonly<{
  classification: string;
  severity: string;
  confidence: string;
  coverage: ReportCoverage;
  gateStatus: string;
  summary: string;
  findings: readonly ReportFinding[];
  firstMaterialDivergence: FirstMaterialDivergence | null;
  stateComparison: StateComparison;
  reviewDecisions: readonly ReviewDecision[];
  redaction: Readonly<{ reason: string; scope: string | null; accessRole: string | null }> | null;
}>;

export type ReportRequestState =
  | { status: 'loading' }
  | { status: 'ready'; report: ComparisonReport }
  | { status: 'error' }
  | { status: 'permission' };

type ReviewState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success' }
  | { status: 'error' }
  | { status: 'permission' };

const reviewActions = ['approve', 'reject', 'mark_inconclusive', 'override_classification'] as const;
const overrideClassifications = ['improvement', 'no-material-change', 'suspected-regression', 'inconclusive'] as const;

type ReviewAction = (typeof reviewActions)[number];
type OverrideClassification = (typeof overrideClassifications)[number];
type ReviewSubmission =
  | Readonly<{ action: Exclude<ReviewAction, 'override_classification'>; rationale: string }>
  | Readonly<{ action: 'override_classification'; rationale: string; overrideClassification: OverrideClassification }>;

export function createReviewRequestBody(submission: ReviewSubmission): Readonly<{ action: ReviewAction; rationale: string; override_classification?: OverrideClassification }> {
  return submission.action === 'override_classification'
    ? { action: submission.action, rationale: submission.rationale, override_classification: submission.overrideClassification }
    : { action: submission.action, rationale: submission.rationale };
}

function isReviewAction(value: string): value is ReviewAction {
  return (reviewActions as readonly string[]).includes(value);
}

function isOverrideClassification(value: string): value is OverrideClassification {
  return (overrideClassifications as readonly string[]).includes(value);
}

class ReportApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Report request failed with status ${status}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(record[key]);
    if (value !== null) return value;
  }

  return null;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readRequiredString(record: Record<string, unknown>, keys: readonly string[], description: string): string {
  const value = readFirstString(record, keys);
  if (value === null) throw new TypeError(`Report ${description} must be a non-empty string.`);
  return value;
}

function readRange(value: unknown): readonly [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const [start, end] = value;
  return typeof start === 'number' && Number.isSafeInteger(start) && typeof end === 'number' && Number.isSafeInteger(end)
    ? [start, end]
    : null;
}

function parseCoverage(value: unknown): ReportCoverage {
  if (!isRecord(value)) throw new TypeError('Report coverage must be an object.');
  const expectedPairs = readNonNegativeInteger(value.expected_pairs ?? value.expectedPairs);
  const completePairs = readNonNegativeInteger(value.complete_pairs ?? value.completePairs);
  const analyzablePairs = readNonNegativeInteger(value.analyzable_pairs ?? value.analyzablePairs);
  if (expectedPairs === null || completePairs === null || analyzablePairs === null) {
    throw new TypeError('Report coverage is missing safe pair counts.');
  }
  return { expectedPairs, completePairs, analyzablePairs };
}

function parseFinding(value: unknown): ReportFinding {
  if (!isRecord(value)) throw new TypeError('Report finding must be an object.');
  return {
    id: readFirstString(value, ['id', 'finding_id', 'findingId']),
    category: readRequiredString(value, ['category'], 'finding category'),
    severity: readRequiredString(value, ['severity'], 'finding severity'),
    repetition: readNonNegativeInteger(value.repetition),
    summary: readFirstString(value, ['summary', 'summary_redacted', 'summaryRedacted']),
  };
}

function parseDivergence(value: unknown): FirstMaterialDivergence | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new TypeError('First material divergence must be an object or null.');
  const score = typeof value.score === 'number' && Number.isFinite(value.score) ? value.score : null;
  return {
    baselineSequenceRange: readRange(value.baseline_sequence_range ?? value.baselineSequenceRange),
    candidateSequenceRange: readRange(value.candidate_sequence_range ?? value.candidateSequenceRange),
    score,
  };
}

function parseStateChange(value: unknown): StateChange {
  if (!isRecord(value)) throw new TypeError('State comparison change must be an object.');
  return {
    field: readRequiredString(value, ['field', 'field_label', 'fieldLabel'], 'state comparison field'),
    baselineValue: readFirstString(value, ['baseline_value', 'baselineValue', 'before']),
    candidateValue: readFirstString(value, ['candidate_value', 'candidateValue', 'after']),
    relevance: readFirstString(value, ['relevance', 'classification']),
  };
}

function parseStateComparison(value: unknown): StateComparison {
  if (!isRecord(value)) throw new TypeError('Report state comparison must be a safe projection object.');
  const status = readFirstString(value, ['status'])?.toLowerCase();
  const changes = Array.isArray(value.changes) ? value.changes.map(parseStateChange) : [];
  return {
    status: status === 'redacted' ? 'redacted' : status === 'unavailable' ? 'unavailable' : 'available',
    expectedSummary: readFirstString(value, ['expected_summary', 'expectedSummary']),
    baselineSummary: readFirstString(value, ['baseline_summary', 'baselineSummary']),
    candidateSummary: readFirstString(value, ['candidate_summary', 'candidateSummary']),
    changes,
    redactionReason: readFirstString(value, ['redaction_reason', 'redactionReason']),
  };
}

function parseReviewDecision(value: unknown): ReviewDecision {
  if (!isRecord(value)) throw new TypeError('Review decision must be an object.');
  return {
    id: readFirstString(value, ['id', 'review_id', 'reviewId']),
    action: readRequiredString(value, ['action'], 'review decision action'),
    rationale: readRequiredString(value, ['rationale'], 'review decision rationale'),
    actor: readFirstString(value, ['actor', 'actor_label', 'actorLabel', 'reviewer']),
    createdAt: readFirstString(value, ['created_at', 'createdAt']),
  };
}

function parseRedaction(value: unknown): ComparisonReport['redaction'] {
  if (!isRecord(value)) return null;
  const reason = readFirstString(value, ['reason', 'message']);
  if (reason === null) return null;
  return {
    reason,
    scope: readFirstString(value, ['scope']),
    accessRole: readFirstString(value, ['access_role', 'accessRole', 'request_access_role', 'requestAccessRole']),
  };
}

export function parseComparisonReportResponse(response: unknown): ComparisonReport {
  if (!isRecord(response) || !isRecord(response.report)) {
    throw new TypeError('Comparison report response must contain a report object.');
  }

  const { report } = response;
  const reviewDecisions = report.review_decisions ?? report.reviewDecisions;
  if (!Array.isArray(report.findings) || !Array.isArray(reviewDecisions)) {
    throw new TypeError('Comparison report is missing safe finding or review decision arrays.');
  }

  return {
    classification: readRequiredString(report, ['classification'], 'classification'),
    severity: readRequiredString(report, ['severity'], 'severity'),
    confidence: readRequiredString(report, ['confidence'], 'confidence'),
    coverage: parseCoverage(report.coverage),
    gateStatus: readRequiredString(report, ['gate_status', 'gateStatus'], 'gate status'),
    summary: readRequiredString(report, ['summary'], 'summary'),
    findings: report.findings.map(parseFinding),
    firstMaterialDivergence: parseDivergence(report.first_material_divergence ?? report.firstMaterialDivergence),
    stateComparison: parseStateComparison(report.state_comparison ?? report.stateComparison),
    reviewDecisions: reviewDecisions.map(parseReviewDecision),
    redaction: parseRedaction(report.redaction),
  };
}

export function getReportRequestState(status: number): 'permission' | 'error' {
  return status === 401 || status === 403 || status === 404 ? 'permission' : 'error';
}

export function getReportStateContent(status: Exclude<ReportRequestState['status'], 'loading' | 'ready'>): Readonly<{ label: string; heading: string; body: string }> {
  return {
    error: {
      label: 'Report unavailable',
      heading: 'The safe report projection could not be loaded',
      body: 'Check the connection and retry. No trace, artifact, or payload content was shown while the request failed.',
    },
    permission: {
      label: 'Access restricted',
      heading: 'You do not have access to this comparison report',
      body: 'Ask an organization owner or admin to confirm report access. Comparison details remain unavailable.',
    },
  }[status];
}

export function readComparisonIdFromSearch(search: string): string | null {
  return readOptionalString(new URLSearchParams(search).get('comparisonId'));
}

function getRequestHeaders(): HeadersInit {
  let organizationId: string | null = null;
  try {
    organizationId = typeof window === 'undefined' ? null : readOptionalString(window.localStorage.getItem(ORGANIZATION_STORAGE_KEY));
  } catch {
    // Privacy-restricted contexts can deny storage without affecting a session request.
  }
  return { Accept: 'application/json', ...(organizationId === null ? {} : { 'x-varytra-organization': organizationId }) };
}

async function requestReport(comparisonId: string, signal: AbortSignal): Promise<ComparisonReport> {
  const response = await fetch(`/v1/comparisons/${encodeURIComponent(comparisonId)}/report`, {
    credentials: 'include', headers: getRequestHeaders(), signal,
  });
  if (!response.ok) throw new ReportApiError(response.status);
  return parseComparisonReportResponse(await response.json() as unknown);
}

function formatLabel(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string | null): string {
  if (value === null) return 'Time not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Time not recorded' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function SequenceRange({ range }: { range: readonly [number, number] | null }) {
  return <span className="report-sequence-range">{range === null ? 'No sequence recorded' : range[0] === range[1] ? `Sequence ${range[0]}` : `Sequences ${range[0]}–${range[1]}`}</span>;
}

function ReportMasthead({ comparisonId }: { comparisonId: string }) {
  return (
    <header className="masthead report-masthead">
      <a className="wordmark" href="/" aria-label="Varytra projects workspace">VARYTRA<span className="wordmark-mark">/</span></a>
      <p className="report-deep-link"><span>Comparison</span> {comparisonId}</p>
    </header>
  );
}

function ReportLoading({ comparisonId }: { comparisonId: string }) {
  return (
    <main className="app-shell report-shell">
      <ReportMasthead comparisonId={comparisonId} />
      <section className="report-loading" aria-busy="true" aria-label="Loading comparison report">
        <span /><span /><span /><span />
        <p>Loading the authorized report projection…</p>
      </section>
    </main>
  );
}

function ReportUnavailable({ comparisonId, state, onRetry }: Readonly<{ comparisonId: string; state: Extract<ReportRequestState, { status: 'error' | 'permission' }>; onRetry: () => void }>) {
  const copy = getReportStateContent(state.status);
  return (
    <main className="app-shell report-shell">
      <ReportMasthead comparisonId={comparisonId} />
      <section className={`report-state report-state--${state.status}`} aria-labelledby="report-state-title">
        <p className="eyebrow">{copy.label}</p>
        <h1 id="report-state-title">{copy.heading}</h1>
        <p>{copy.body}</p>
        {state.status === 'error' && <button type="button" onClick={onRetry}>Retry report request</button>}
      </section>
    </main>
  );
}

function VerdictHeader({ comparisonId, report }: Readonly<{ comparisonId: string; report: ComparisonReport }>) {
  const coverageText = `${report.coverage.analyzablePairs}/${report.coverage.expectedPairs} analyzable pairs`;
  return (
    <section className={`report-verdict report-verdict--${report.classification}`} aria-labelledby="report-title">
      <div className="report-verdict-main">
        <p className="eyebrow">Immutable comparison report</p>
        <h1 id="report-title">{formatLabel(report.classification)}</h1>
        <p className="report-summary">{report.summary}</p>
      </div>
      <div className="report-verdict-status" aria-label={`Severity ${formatLabel(report.severity)}, gate ${formatLabel(report.gateStatus)}`}>
        <span className={`report-status report-status--${report.severity}`}>Severity · {formatLabel(report.severity)}</span>
        <span className={`report-status report-status--gate-${report.gateStatus}`}>Gate · {formatLabel(report.gateStatus)}</span>
      </div>
      <dl className="report-metrics">
        <div><dt>Confidence</dt><dd>{formatLabel(report.confidence)}</dd></div>
        <div><dt>Coverage</dt><dd>{coverageText}</dd></div>
        <div><dt>Complete pairs</dt><dd>{report.coverage.completePairs}/{report.coverage.expectedPairs}</dd></div>
        <div><dt>Comparison ID</dt><dd title={comparisonId}>{comparisonId}</dd></div>
      </dl>
    </section>
  );
}

function RedactionNotice({ report }: { report: ComparisonReport }) {
  const reason = report.redaction?.reason ?? report.stateComparison.redactionReason;
  if (reason === null) return null;
  return (
    <aside className="report-redaction" aria-label="Redacted evidence notice">
      <span className="redaction-swatch" aria-hidden="true" />
      <div><p className="eyebrow">Evidence redacted</p><p>{reason}{report.redaction?.scope === null || report.redaction?.scope === undefined ? '' : ` Scope: ${report.redaction.scope}.`}{report.redaction?.accessRole === null || report.redaction?.accessRole === undefined ? '' : ` Access requests require ${report.redaction.accessRole}.`}</p></div>
    </aside>
  );
}

function InconclusiveNotice({ report }: { report: ComparisonReport }) {
  if (report.classification.toLowerCase() !== 'inconclusive') return null;
  return <aside className="report-inconclusive" role="status"><p className="eyebrow">Decision limited</p><p>This comparison is inconclusive. Review the coverage and evidence, then increase runs, repair the fixture, or resolve the unavailable assessment before making a release decision.</p></aside>;
}

function TrajectoryLedger({ divergence }: { divergence: FirstMaterialDivergence | null }) {
  return (
    <section className="trajectory-ledger" aria-labelledby="trajectory-ledger-title">
      <div className="report-section-heading"><div><p className="eyebrow">Aligned evidence</p><h2 id="trajectory-ledger-title">Trajectory Ledger</h2></div><p>Chronology is represented by safe sequence anchors only; trace payloads are not displayed.</p></div>
      {divergence === null ? (
        <div className="ledger-empty"><strong>No material trajectory break recorded.</strong><p>The report found no first material divergence in the safe alignment projection.</p></div>
      ) : (
        <div className="ledger-content">
          <div className="ledger-visual" aria-hidden="true">
            <div className="ledger-lane"><span className="ledger-lane-label">Baseline</span><span className="ledger-track"><i /><i /><i className="ledger-marker--divergence">×</i><i /><i /></span></div>
            <div className="ledger-connector" />
            <div className="ledger-lane"><span className="ledger-lane-label">Candidate</span><span className="ledger-track"><i /><i /><i className="ledger-marker--divergence">×</i><i /><i /></span></div>
          </div>
          <div id="first-material-divergence" className="divergence-record" tabIndex={-1}>
            <p className="eyebrow">First material divergence</p>
            <h3>Divergence is localized to the recorded sequence range.</h3>
            <dl><div><dt>Baseline</dt><dd><SequenceRange range={divergence.baselineSequenceRange} /></dd></div><div><dt>Candidate</dt><dd><SequenceRange range={divergence.candidateSequenceRange} /></dd></div><div><dt>Alignment score</dt><dd>{divergence.score ?? 'Not recorded'}</dd></div></dl>
            <a href="#evidence">Inspect linked findings</a>
          </div>
        </div>
      )}
    </section>
  );
}

function StateComparisonView({ comparison }: { comparison: StateComparison }) {
  const summaries = [{ label: 'Expected final state', value: comparison.expectedSummary }, { label: 'Baseline final state', value: comparison.baselineSummary }, { label: 'Candidate final state', value: comparison.candidateSummary }];
  return (
    <section className="state-comparison" aria-labelledby="state-comparison-title">
      <div className="report-section-heading"><div><p className="eyebrow">Final state</p><h2 id="state-comparison-title">State comparison</h2></div><p>Final-state summaries and changed fields are pre-redacted by the report projection.</p></div>
      {comparison.status === 'redacted' ? <div className="state-comparison-empty state-comparison-empty--redacted"><span className="redaction-swatch" aria-hidden="true" /><p>{comparison.redactionReason ?? 'State evidence is redacted for this access level.'}</p></div>
        : comparison.status === 'unavailable' ? <div className="state-comparison-empty"><p>Final-state comparison was not available for this assessment.</p></div>
          : <><div className="state-summary-grid">{summaries.map((summary) => <div key={summary.label}><p className="eyebrow">{summary.label}</p><p>{summary.value ?? 'Not recorded in the safe projection.'}</p></div>)}</div>{comparison.changes.length === 0 ? <p className="state-comparison-empty">No changed state fields were included in the safe report projection.</p> : <div className="state-change-wrap"><table className="state-change-table"><caption>Safe state changes in this comparison</caption><thead><tr><th scope="col">Field</th><th scope="col">Baseline</th><th scope="col">Candidate</th><th scope="col">Relevance</th></tr></thead><tbody>{comparison.changes.map((change) => <tr key={`${change.field}-${change.baselineValue}-${change.candidateValue}`}><th scope="row">{change.field}</th><td data-label="Baseline">{change.baselineValue ?? 'Not recorded'}</td><td data-label="Candidate">{change.candidateValue ?? 'Not recorded'}</td><td data-label="Relevance">{change.relevance === null ? 'Not classified' : formatLabel(change.relevance)}</td></tr>)}</tbody></table></div>}</>}
    </section>
  );
}

function EvidenceTable({ findings }: { findings: readonly ReportFinding[] }) {
  return (
    <section id="evidence" className="evidence-table" aria-labelledby="evidence-title">
      <div className="report-section-heading"><div><p className="eyebrow">Supporting evidence</p><h2 id="evidence-title">Evidence register</h2></div><p>Finding records identify category, severity, repetition, and redacted summary—never trace artifacts or payloads.</p></div>
      {findings.length === 0 ? <div className="evidence-empty"><p>No findings were included in this report projection.</p></div> : <div className="evidence-table-wrap"><table><caption>Safe comparison findings</caption><thead><tr><th scope="col">Finding</th><th scope="col">Severity</th><th scope="col">Repetition</th><th scope="col">Redacted assessment</th></tr></thead><tbody>{findings.map((finding, index) => <tr key={finding.id ?? `${finding.category}-${index}`}><th scope="row"><span>{formatLabel(finding.category)}</span>{finding.id !== null && <small>{finding.id}</small>}</th><td data-label="Severity"><span className={`report-status report-status--${finding.severity}`}>{formatLabel(finding.severity)}</span></td><td data-label="Repetition">{finding.repetition === null ? 'Not recorded' : finding.repetition}</td><td data-label="Redacted assessment">{finding.summary ?? 'Safe finding summary not recorded.'}</td></tr>)}</tbody></table></div>}
    </section>
  );
}

function ReviewPanel({ comparisonId, decisions, onSubmitted }: Readonly<{ comparisonId: string; decisions: readonly ReviewDecision[]; onSubmitted: () => void }>) {
  const [action, setAction] = useState<ReviewAction>('approve');
  const [overrideClassification, setOverrideClassification] = useState<OverrideClassification | ''>('');
  const [rationale, setRationale] = useState('');
  const [state, setState] = useState<ReviewState>({ status: 'idle' });
  const isSubmitting = state.status === 'submitting';

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedRationale = rationale.trim();
    if (!trimmedRationale || isSubmitting) return;
    let requestBody: ReturnType<typeof createReviewRequestBody>;
    if (action === 'override_classification') {
      if (overrideClassification === '') return;
      requestBody = createReviewRequestBody({ action, rationale: trimmedRationale, overrideClassification });
    } else {
      requestBody = createReviewRequestBody({ action, rationale: trimmedRationale });
    }
    setState({ status: 'submitting' });
    try {
      const response = await fetch(`/v1/comparisons/${encodeURIComponent(comparisonId)}/review`, { method: 'POST', credentials: 'include', headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody) });
      if (!response.ok) throw new ReportApiError(response.status);
      setRationale('');
      setOverrideClassification('');
      setState({ status: 'success' });
      onSubmitted();
    } catch (error: unknown) {
      setState({ status: error instanceof ReportApiError && getReportRequestState(error.status) === 'permission' ? 'permission' : 'error' });
    }
  }

  return (
    <section className="review-panel" aria-labelledby="review-title">
      <div className="report-section-heading">
        <div><p className="eyebrow">Human decision</p><h2 id="review-title">Review and audit trail</h2></div>
        <p>Review decisions append to the machine verdict; they do not alter its original classification.</p>
      </div>
      <div className="review-grid">
        <form onSubmit={handleSubmit} className="review-form">
          <fieldset disabled={isSubmitting}>
            <legend>Record a reviewer decision</legend>
            <div className="field-group">
              <label htmlFor="review-action">Decision</label>
              <select id="review-action" value={action} onChange={(event) => {
                if (!isReviewAction(event.target.value)) return;
                setAction(event.target.value);
                setOverrideClassification('');
                if (state.status !== 'idle') setState({ status: 'idle' });
              }}>
                <option value="approve">Approve release</option>
                <option value="reject">Reject release</option>
                <option value="mark_inconclusive">Mark inconclusive</option>
                <option value="override_classification">Override classification</option>
              </select>
            </div>
            {action === 'override_classification' && <div className="field-group">
              <label htmlFor="review-override-classification">Replacement classification <span>(required)</span></label>
              <select id="review-override-classification" value={overrideClassification} required aria-describedby="review-override-classification-help" onChange={(event) => {
                if (!isOverrideClassification(event.target.value)) return;
                setOverrideClassification(event.target.value);
                if (state.status !== 'idle') setState({ status: 'idle' });
              }}>
                <option value="" disabled>Select a replacement classification</option>
                {overrideClassifications.map((classification) => <option key={classification} value={classification}>{formatLabel(classification)}</option>)}
              </select>
              <p id="review-override-classification-help" className="field-help">This classification replaces the machine verdict for this review decision only.</p>
            </div>}
            <div className="field-group">
              <label htmlFor="review-rationale">Rationale <span>(required)</span></label>
              <textarea id="review-rationale" value={rationale} onChange={(event) => { setRationale(event.target.value); if (state.status !== 'idle') setState({ status: 'idle' }); }} required minLength={1} maxLength={2000} aria-describedby="review-rationale-help" />
              <p id="review-rationale-help" className="field-help">This rationale is appended to the audit trail with your decision.</p>
            </div>
            <button type="submit">{isSubmitting ? 'Recording decision…' : 'Record review decision'}</button>
          </fieldset>
          {state.status === 'success' && <p className="form-notice form-notice--success" role="status">Review decision recorded. The safe report projection is refreshing.</p>}
          {state.status === 'permission' && <p className="form-notice form-notice--permission" role="alert">You do not have the role required to record a review decision.</p>}
          {state.status === 'error' && <p className="form-notice form-notice--error" role="alert">The decision could not be recorded. Check the connection and try again.</p>}
        </form>
        <ol className="review-decisions" aria-label="Recorded review decisions">
          {decisions.length === 0 ? <li className="review-decisions-empty">No human review decisions have been recorded.</li> : decisions.map((decision, index) => <li key={decision.id ?? `${decision.action}-${index}`}><div><p className="eyebrow">{formatTimestamp(decision.createdAt)}</p><strong>{formatLabel(decision.action)}</strong></div><p>{decision.rationale}</p><span>{decision.actor ?? 'Reviewer identity not included'}</span></li>)}
        </ol>
      </div>
    </section>
  );
}

function ReportView({ comparisonId, report, onRefresh }: Readonly<{ comparisonId: string; report: ComparisonReport; onRefresh: () => void }>) {
  return <main className="app-shell report-shell"><ReportMasthead comparisonId={comparisonId} /><VerdictHeader comparisonId={comparisonId} report={report} /><RedactionNotice report={report} /><InconclusiveNotice report={report} /><TrajectoryLedger divergence={report.firstMaterialDivergence} /><StateComparisonView comparison={report.stateComparison} /><EvidenceTable findings={report.findings} /><ReviewPanel comparisonId={comparisonId} decisions={report.reviewDecisions} onSubmitted={onRefresh} /><footer><span>Varytra</span><span>Evidence before release</span></footer></main>;
}

export function ReportScreen({ comparisonId }: { comparisonId: string }) {
  const [state, setState] = useState<ReportRequestState>({ status: 'loading' });
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading' });
    void requestReport(comparisonId, controller.signal).then((report) => setState({ status: 'ready', report })).catch((error: unknown) => {
      if (!controller.signal.aborted) setState(error instanceof ReportApiError ? { status: getReportRequestState(error.status) } : { status: 'error' });
    });
    return () => controller.abort();
  }, [comparisonId, refreshKey]);

  if (state.status === 'loading') return <ReportLoading comparisonId={comparisonId} />;
  if (state.status === 'error' || state.status === 'permission') return <ReportUnavailable comparisonId={comparisonId} state={state} onRetry={() => setRefreshKey((value) => value + 1)} />;
  return <ReportView comparisonId={comparisonId} report={state.report} onRefresh={() => setRefreshKey((value) => value + 1)} />;
}
