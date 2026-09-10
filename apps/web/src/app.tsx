import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { FirstRunOnboarding } from './onboarding';
import { readComparisonIdFromSearch, ReportScreen } from './report';

const ORGANIZATION_STORAGE_KEY = 'x-varytra-organization';

export type Project = {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string | null;
};

export type ProjectListState =
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'ready'; projects: Project[] }
  | { status: 'error' }
  | { status: 'permission' };

export type ScenarioVersion = {
  id: string;
  version: string;
  contentHash: string | null;
  fixtureRef: string | null;
  policyVersion: string | null;
};

export type AgentVersion = {
  id: string;
  version: string;
  contentHash: string | null;
  adapter: string | null;
  model: string | null;
};

export type VersionSelectionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; scenarioVersions: ScenarioVersion[]; agentVersions: AgentVersion[] }
  | { status: 'error' }
  | { status: 'permission' };

export type ComparisonBatchProgress = {
  id: string;
  status: string;
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  runningRunCount: number;
  stage: string;
};

export type BatchProgressState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; batch: ComparisonBatchProgress }
  | { status: 'failed'; batch: ComparisonBatchProgress }
  | { status: 'complete'; batch: ComparisonBatchProgress }
  | { status: 'error' }
  | { status: 'permission' };

type CreationState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; projectName: string }
  | { status: 'error' }
  | { status: 'permission' };

class ProjectApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Project request failed with status ${status}.`);
  }
}

class BatchProgressApiError extends Error {
  public constructor(public readonly status: number) {
    super(`Batch progress request failed with status ${status}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readOptionalVersion(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return readOptionalString(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readFirstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readOptionalString(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function readFirstVersion(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = readOptionalVersion(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function parseProject(value: unknown): Project {
  if (!isRecord(value)) {
    throw new TypeError('Project response item must be an object.');
  }

  const id = readOptionalString(value.id);
  const name = readOptionalString(value.name);

  if (!id || !name) {
    throw new TypeError('Project response item is missing an id or name.');
  }

  return {
    id,
    name,
    description: readOptionalString(value.description),
    updatedAt: readOptionalString(value.updatedAt) ?? readOptionalString(value.updated_at),
  };
}

export function parseProjectsResponse(response: unknown): Project[] {
  const projects = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.projects)
      ? response.projects
      : null;

  if (!projects) {
    throw new TypeError('Project list response must contain a projects array.');
  }

  return projects.map(parseProject);
}

function parseScenarioVersion(value: unknown): ScenarioVersion {
  if (!isRecord(value)) {
    throw new TypeError('Scenario version response item must be an object.');
  }

  const id = readFirstString(value, ['id', 'scenario_version_id', 'scenarioVersionId']);

  if (!id) {
    throw new TypeError('Scenario version response item is missing an id.');
  }

  return {
    id,
    version: readFirstVersion(value, ['version', 'version_number', 'versionNumber', 'label']) ?? id,
    contentHash: readFirstString(value, ['content_hash', 'contentHash', 'hash']),
    fixtureRef: readFirstString(value, ['fixture_ref', 'fixtureRef', 'fixture_reference', 'fixtureReference']),
    policyVersion: readFirstString(value, ['policy_version', 'policyVersion']),
  };
}

function parseAgentVersion(value: unknown): AgentVersion {
  if (!isRecord(value)) {
    throw new TypeError('Agent version response item must be an object.');
  }

  const id = readFirstString(value, ['id', 'agent_version_id', 'agentVersionId']);

  if (!id) {
    throw new TypeError('Agent version response item is missing an id.');
  }

  return {
    id,
    version: readFirstVersion(value, ['version', 'version_number', 'versionNumber', 'label']) ?? id,
    contentHash: readFirstString(value, ['content_hash', 'contentHash', 'hash']),
    adapter: readFirstString(value, ['adapter', 'adapter_type', 'adapterType']),
    model: readFirstString(value, ['model', 'model_name', 'modelName']),
  };
}

export function parseScenarioVersionsResponse(response: unknown): ScenarioVersion[] {
  if (!isRecord(response) || !Array.isArray(response.scenario_versions)) {
    throw new TypeError('Scenario version response must contain a scenario_versions array.');
  }

  return response.scenario_versions.map(parseScenarioVersion);
}

export function parseAgentVersionsResponse(response: unknown): AgentVersion[] {
  if (!isRecord(response) || !Array.isArray(response.agent_versions)) {
    throw new TypeError('Agent version response must contain an agent_versions array.');
  }

  return response.agent_versions.map(parseAgentVersion);
}

export function parseComparisonBatchProgressResponse(response: unknown): ComparisonBatchProgress {
  if (!isRecord(response) || !isRecord(response.batch)) {
    throw new TypeError('Batch progress response must contain a batch object.');
  }

  const { batch } = response;
  const id = readOptionalString(batch.id);
  const status = readOptionalString(batch.status);
  const stage = readOptionalString(batch.stage);
  const runCount = readNonNegativeInteger(batch.run_count);
  const completedRunCount = readNonNegativeInteger(batch.completed_run_count);
  const failedRunCount = readNonNegativeInteger(batch.failed_run_count);
  const runningRunCount = readNonNegativeInteger(batch.running_run_count);

  if (!id || !status || !stage || runCount === null || completedRunCount === null || failedRunCount === null || runningRunCount === null) {
    throw new TypeError('Batch progress response is missing required safe progress fields.');
  }

  return { id, status, runCount, completedRunCount, failedRunCount, runningRunCount, stage };
}

function parseCreatedProjectResponse(response: unknown): Project {
  if (isRecord(response) && 'project' in response) {
    return parseProject(response.project);
  }

  return parseProject(response);
}

export function getProjectRequestState(status: number): 'permission' | 'error' {
  return status === 403 ? 'permission' : 'error';
}

export function getVersionSelectionStateContent(status: Exclude<VersionSelectionState['status'], 'idle' | 'loading' | 'ready'>): Readonly<{ label: string; heading: string; body: string }> {
  return {
    error: {
      label: 'Version records unavailable',
      heading: 'The immutable version records could not be loaded',
      body: 'Check the connection and choose this project again. No resolved configuration was shown while the request failed.',
    },
    permission: {
      label: 'Access restricted',
      heading: 'You do not have access to this project’s version records',
      body: 'Ask an organization owner or admin to confirm your project access. Version details remain unavailable.',
    },
  }[status];
}

export function getBatchProgressStateContent(status: Exclude<BatchProgressState['status'], 'loading' | 'ready'>): Readonly<{ label: string; heading: string; body: string }> {
  return {
    idle: {
      label: 'No live batch selected',
      heading: 'Open a comparison batch to observe its execution',
      body: 'Batch progress is available from an authorized batch record. This pane never shows trace content or artifact links.',
    },
    error: {
      label: 'Progress unavailable',
      heading: 'The safe batch-progress record could not be loaded',
      body: 'Check the connection and try again. No trace, artifact, or run content was shown while the request failed.',
    },
    permission: {
      label: 'Access restricted',
      heading: 'You do not have access to this batch progress',
      body: 'Ask an organization owner or admin to confirm your access. Batch details remain unavailable.',
    },
    failed: {
      label: 'Execution failed',
      heading: 'This batch ended in a failed state',
      body: 'The run accounting below is the safe persisted progress projection. It does not disclose trace or artifact content.',
    },
    complete: {
      label: 'Batch complete',
      heading: 'Execution stages are complete',
      body: 'The run accounting below records the completed batch without exposing trace or artifact content.',
    },
  }[status];
}

export function getBatchProgressRequestState(status: number): 'permission' | 'error' {
  return status === 401 || status === 403 ? 'permission' : 'error';
}

export function isTerminalBatchStatus(status: string): boolean {
  return ['complete', 'completed', 'failed', 'cancelled', 'canceled'].includes(status.trim().toLowerCase());
}

export function isTerminalBatchProgress(batch: ComparisonBatchProgress): boolean {
  const stage = normalizeStage(batch.stage);
  return isTerminalBatchStatus(batch.status) || stage === 'complete' || stage === 'completed' || stage === 'failed';
}

export function getBatchProgressStateFromBatch(batch: ComparisonBatchProgress): Extract<BatchProgressState, { status: 'ready' | 'failed' | 'complete' }> {
  const status = batch.status.trim().toLowerCase();
  const stage = normalizeStage(batch.stage);

  if (status === 'complete' || status === 'completed' || stage === 'complete' || stage === 'completed') {
    return { status: 'complete', batch };
  }

  if (status === 'failed' || status === 'cancelled' || status === 'canceled' || stage === 'failed') {
    return { status: 'failed', batch };
  }

  return { status: 'ready', batch };
}

export function getProjectStateContent(status: Exclude<ProjectListState['status'], 'loading' | 'ready'>): Readonly<{ label: string; heading: string; body: string }> {
  return {
    empty: {
      label: 'No project records',
      heading: 'No projects in this workspace',
      body: 'Create the first project to frame a release decision before comparing an agent change.',
    },
    error: {
      label: 'Project register unavailable',
      heading: 'The project record could not be loaded',
      body: 'Check the connection and reload this page. No project details were shown while the request failed.',
    },
    permission: {
      label: 'Access restricted',
      heading: 'You do not have access to this workspace',
      body: 'Ask an organization owner or admin to confirm your membership. Project details remain unavailable.',
    },
  }[status];
}

function readOrganizationId(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    return readOptionalString(window.localStorage.getItem(ORGANIZATION_STORAGE_KEY));
  } catch {
    // Local storage can be unavailable in privacy-restricted browser contexts.
    return null;
  }
}

function readOrganizationName(): string {
  return readOrganizationId() ?? 'Personal workspace';
}

export function readBatchIdFromSearch(search: string): string | null {
  return readOptionalString(new URLSearchParams(search).get('batchId'));
}

function readBatchId(): string | null {
  return typeof window === 'undefined' ? null : readBatchIdFromSearch(window.location.search);
}

function formatUpdatedAt(updatedAt: string | null): string {
  if (!updatedAt) {
    return 'No activity recorded';
  }

  const date = new Date(updatedAt);

  if (Number.isNaN(date.getTime())) {
    return 'Activity timestamp unavailable';
  }

  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

async function requestProjects(signal: AbortSignal): Promise<Project[]> {
  const organizationId = readOrganizationId();
  const response = await fetch('/v1/projects', {
    credentials: 'include',
    headers: { Accept: 'application/json', ...(organizationId === null ? {} : { 'x-varytra-organization': organizationId }) },
    signal,
  });

  if (!response.ok) {
    throw new ProjectApiError(response.status);
  }

  const body: unknown = await response.json();
  return parseProjectsResponse(body);
}

function getRequestHeaders(): HeadersInit {
  const organizationId = readOrganizationId();
  return { Accept: 'application/json', ...(organizationId === null ? {} : { 'x-varytra-organization': organizationId }) };
}

async function requestVersionData(projectId: string, signal: AbortSignal): Promise<Readonly<{ scenarioVersions: ScenarioVersion[]; agentVersions: AgentVersion[] }>> {
  const encodedProjectId = encodeURIComponent(projectId);
  const [scenarioResponse, agentResponse] = await Promise.all([
    fetch(`/v1/projects/${encodedProjectId}/scenario-versions`, { credentials: 'include', headers: getRequestHeaders(), signal }),
    fetch(`/v1/projects/${encodedProjectId}/agent-versions`, { credentials: 'include', headers: getRequestHeaders(), signal }),
  ]);

  if (!scenarioResponse.ok) {
    throw new ProjectApiError(scenarioResponse.status);
  }

  if (!agentResponse.ok) {
    throw new ProjectApiError(agentResponse.status);
  }

  const [scenarioBody, agentBody]: [unknown, unknown] = await Promise.all([scenarioResponse.json(), agentResponse.json()]);
  return {
    scenarioVersions: parseScenarioVersionsResponse(scenarioBody),
    agentVersions: parseAgentVersionsResponse(agentBody),
  };
}

async function requestBatchProgress(batchId: string, signal: AbortSignal): Promise<ComparisonBatchProgress> {
  const response = await fetch(`/v1/comparison-batches/${encodeURIComponent(batchId)}/progress`, {
    credentials: 'include',
    headers: getRequestHeaders(),
    signal,
  });

  if (!response.ok) {
    throw new BatchProgressApiError(response.status);
  }

  const body: unknown = await response.json();
  return parseComparisonBatchProgressResponse(body);
}

function ProjectTable({ projects }: { projects: Project[] }) {
  return (
    <div className="project-table-wrap">
      <table className="project-table">
        <caption>Projects available in this workspace</caption>
        <thead>
          <tr>
            <th scope="col">Project</th>
            <th scope="col">Release question</th>
            <th scope="col">Last recorded activity</th>
            <th scope="col">Project ID</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr key={project.id}>
              <th scope="row" data-label="Project">
                {project.name}
              </th>
              <td data-label="Release question">
                {project.description ?? 'Release question not yet recorded.'}
              </td>
              <td data-label="Last recorded activity">{formatUpdatedAt(project.updatedAt)}</td>
              <td className="project-id" data-label="Project ID">
                {project.id}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ProjectListStateView({ state }: { state: ProjectListState }) {
  if (state.status === 'loading') {
    return (
      <div className="project-loading" aria-busy="true" aria-label="Loading projects">
        <div className="loading-row"><span /><span /><span /></div>
        <div className="loading-row"><span /><span /><span /></div>
        <div className="loading-row"><span /><span /><span /></div>
      </div>
    );
  }

  if (state.status === 'ready') {
    return <ProjectTable projects={state.projects} />;
  }

  const copy = getProjectStateContent(state.status);

  return (
    <section className={`project-state project-state--${state.status}`} aria-labelledby="project-state-title">
      <p className="eyebrow">{copy.label}</p>
      <h3 id="project-state-title">{copy.heading}</h3>
      <p>{copy.body}</p>
    </section>
  );
}

function formatVersionLabel(version: { id: string; version: string }): string {
  return `Version ${version.version} · ${version.id}`;
}

function MetadataValue({ value }: { value: string | null }) {
  return <dd className={value === null ? 'metadata-value metadata-value--unavailable' : 'metadata-value'}>{value ?? 'Not recorded'}</dd>;
}

function ResolvedConfigurationPreview({ scenarioVersion, baselineVersion, candidateVersion }: Readonly<{
  scenarioVersion: ScenarioVersion;
  baselineVersion: AgentVersion;
  candidateVersion: AgentVersion;
}>) {
  return (
    <section className="resolved-preview" aria-labelledby="resolved-preview-title" aria-live="polite">
      <div className="resolved-preview-heading">
        <div>
          <p className="eyebrow">Immutable resolved configuration</p>
          <h3 id="resolved-preview-title">Selection evidence</h3>
        </div>
        <span className="status-tag">Resolved</span>
      </div>
      <p className="redaction-notice">
        <span className="redaction-swatch" aria-hidden="true" /> Redacted metadata only. Raw prompts, fixtures, adapter configuration, and secrets are not displayed here.
      </p>
      <div className="configuration-ledger">
        <section className="configuration-record" aria-labelledby="scenario-record-title">
          <p className="eyebrow">Scenario</p>
          <h4 id="scenario-record-title">{formatVersionLabel(scenarioVersion)}</h4>
          <dl>
            <div><dt>Scenario version ID</dt><MetadataValue value={scenarioVersion.id} /></div>
            <div><dt>Content hash</dt><MetadataValue value={scenarioVersion.contentHash} /></div>
            <div><dt>Fixture reference</dt><MetadataValue value={scenarioVersion.fixtureRef} /></div>
            <div><dt>Policy version</dt><MetadataValue value={scenarioVersion.policyVersion} /></div>
          </dl>
        </section>
        <section className="configuration-record" aria-labelledby="baseline-record-title">
          <p className="eyebrow">Baseline agent</p>
          <h4 id="baseline-record-title">{formatVersionLabel(baselineVersion)}</h4>
          <dl>
            <div><dt>Agent version ID</dt><MetadataValue value={baselineVersion.id} /></div>
            <div><dt>Content hash</dt><MetadataValue value={baselineVersion.contentHash} /></div>
            <div><dt>Adapter</dt><MetadataValue value={baselineVersion.adapter} /></div>
            <div><dt>Model</dt><MetadataValue value={baselineVersion.model} /></div>
          </dl>
        </section>
        <section className="configuration-record" aria-labelledby="candidate-record-title">
          <p className="eyebrow">Candidate agent</p>
          <h4 id="candidate-record-title">{formatVersionLabel(candidateVersion)}</h4>
          <dl>
            <div><dt>Agent version ID</dt><MetadataValue value={candidateVersion.id} /></div>
            <div><dt>Content hash</dt><MetadataValue value={candidateVersion.contentHash} /></div>
            <div><dt>Adapter</dt><MetadataValue value={candidateVersion.adapter} /></div>
            <div><dt>Model</dt><MetadataValue value={candidateVersion.model} /></div>
          </dl>
        </section>
      </div>
    </section>
  );
}

function VersionSelectionStateView({ state }: { state: VersionSelectionState }) {
  if (state.status === 'loading') {
    return (
      <div className="version-loading" aria-busy="true" aria-label="Loading version records">
        <span /><span /><span />
      </div>
    );
  }

  if (state.status === 'idle') {
    return (
      <section className="version-state" aria-labelledby="version-state-title">
        <p className="eyebrow">Project required</p>
        <h3 id="version-state-title">Choose a project to inspect its immutable versions</h3>
        <p>Scenario and agent version records are loaded only after you select a project.</p>
      </section>
    );
  }

  if (state.status === 'ready') {
    return null;
  }

  const copy = getVersionSelectionStateContent(state.status);
  return (
    <section className={`version-state version-state--${state.status}`} aria-labelledby="version-state-title">
      <p className="eyebrow">{copy.label}</p>
      <h3 id="version-state-title">{copy.heading}</h3>
      <p>{copy.body}</p>
    </section>
  );
}

function VersionSelectionControls({
  state,
  scenarioVersionId,
  baselineVersionId,
  candidateVersionId,
  onScenarioVersionChange,
  onBaselineVersionChange,
  onCandidateVersionChange,
}: Readonly<{
  state: Extract<VersionSelectionState, { status: 'ready' }>;
  scenarioVersionId: string;
  baselineVersionId: string;
  candidateVersionId: string;
  onScenarioVersionChange: (id: string) => void;
  onBaselineVersionChange: (id: string) => void;
  onCandidateVersionChange: (id: string) => void;
}>) {
  const scenarioVersion = state.scenarioVersions.find(({ id }) => id === scenarioVersionId);
  const baselineVersion = state.agentVersions.find(({ id }) => id === baselineVersionId);
  const candidateVersion = state.agentVersions.find(({ id }) => id === candidateVersionId);
  const cannotCompareAgents = state.agentVersions.length < 2;
  const isResolved = scenarioVersion !== undefined && baselineVersion !== undefined && candidateVersion !== undefined;

  return (
    <>
      <div className="version-controls">
        <div className="field-group">
          <label htmlFor="scenario-version">Scenario version</label>
          <select
            id="scenario-version"
            name="scenarioVersion"
            value={scenarioVersionId}
            onChange={(event) => onScenarioVersionChange(event.target.value)}
            disabled={state.scenarioVersions.length === 0}
            aria-describedby="scenario-version-help"
          >
            <option value="">{state.scenarioVersions.length === 0 ? 'No scenario versions available' : 'Choose an immutable scenario version'}</option>
            {state.scenarioVersions.map((version) => <option key={version.id} value={version.id}>{formatVersionLabel(version)}</option>)}
          </select>
          <p id="scenario-version-help" className="field-help">Includes its fixture reference and policy version in the resolved record.</p>
          {state.scenarioVersions.length === 0 && <p className="selection-notice" role="status">No scenario versions are available for this project. Create an immutable scenario version before continuing.</p>}
        </div>

        <fieldset className="agent-version-fields">
          <legend>Agent versions</legend>
          <p className="field-help">Choose two different immutable agent versions for a meaningful comparison.</p>
          <div className="agent-version-grid">
            <div className="field-group">
              <label htmlFor="baseline-agent-version">Baseline</label>
              <select
                id="baseline-agent-version"
                name="baselineAgentVersion"
                value={baselineVersionId}
                onChange={(event) => onBaselineVersionChange(event.target.value)}
                disabled={cannotCompareAgents}
              >
                <option value="">{cannotCompareAgents ? 'Two agent versions are required' : 'Choose a baseline version'}</option>
                {state.agentVersions.map((version) => <option key={version.id} value={version.id} disabled={version.id === candidateVersionId}>{formatVersionLabel(version)}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="candidate-agent-version">Candidate</label>
              <select
                id="candidate-agent-version"
                name="candidateAgentVersion"
                value={candidateVersionId}
                onChange={(event) => onCandidateVersionChange(event.target.value)}
                disabled={cannotCompareAgents}
              >
                <option value="">{cannotCompareAgents ? 'Two agent versions are required' : 'Choose a candidate version'}</option>
                {state.agentVersions.map((version) => <option key={version.id} value={version.id} disabled={version.id === baselineVersionId}>{formatVersionLabel(version)}</option>)}
              </select>
            </div>
          </div>
          {cannotCompareAgents && <p className="selection-notice" role="status">A baseline and candidate require at least two agent version records.</p>}
        </fieldset>
      </div>

      {isResolved && <ResolvedConfigurationPreview scenarioVersion={scenarioVersion} baselineVersion={baselineVersion} candidateVersion={candidateVersion} />}
    </>
  );
}

const BATCH_STAGES = [
  { key: 'queued', label: 'Queued' },
  { key: 'preparing_fixture', label: 'Preparing fixture' },
  { key: 'running_baseline', label: 'Running baseline' },
  { key: 'running_candidate', label: 'Running candidate' },
  { key: 'aligning', label: 'Aligning' },
  { key: 'checking_policies', label: 'Checking policies' },
  { key: 'reviewing_semantic_differences', label: 'Reviewing semantic differences' },
  { key: 'complete', label: 'Complete' },
] as const;

function normalizeStage(stage: string): string {
  return stage.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function getBatchStageLabel(stage: string): string {
  const normalizedStage = normalizeStage(stage);
  const knownStage = BATCH_STAGES.find(({ key }) => key === normalizedStage);

  if (knownStage) {
    return knownStage.label;
  }

  return stage
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1).toLowerCase()}`)
    .join(' ');
}

function BatchStageLedger({ batch, state }: Readonly<{
  batch: ComparisonBatchProgress;
  state: Extract<BatchProgressState, { status: 'ready' | 'failed' | 'complete' }>['status'];
}>) {
  const currentStageIndex = BATCH_STAGES.findIndex(({ key }) => key === normalizeStage(batch.stage));
  const isComplete = state === 'complete';

  return (
    <ol className="batch-stage-ledger" aria-label="Comparison batch stages">
      {BATCH_STAGES.map((stage, index) => {
        const isCurrent = !isComplete && currentStageIndex === index;
        const isObserved = isComplete || (currentStageIndex !== -1 && index < currentStageIndex);
        const stateLabel = isCurrent ? 'Current' : isObserved ? 'Observed' : 'Awaiting';

        return (
          <li key={stage.key} className={`batch-stage batch-stage--${isCurrent ? 'current' : isObserved ? 'observed' : 'awaiting'}`} aria-current={isCurrent ? 'step' : undefined}>
            <span className="batch-stage-marker" aria-hidden="true">{isCurrent ? '→' : isObserved ? '•' : '·'}</span>
            <span className="batch-stage-name">{stage.label}</span>
            <span className="batch-stage-state">{stateLabel}</span>
          </li>
        );
      })}
    </ol>
  );
}

function BatchRunAccounting({ batch }: { batch: ComparisonBatchProgress }) {
  return (
    <dl className="batch-run-accounting">
      <div>
        <dt>Run count</dt>
        <dd>{batch.runCount}</dd>
      </div>
      <div>
        <dt>Completed</dt>
        <dd>{batch.completedRunCount}</dd>
      </div>
      <div>
        <dt>Running</dt>
        <dd>{batch.runningRunCount}</dd>
      </div>
      <div>
        <dt>Failed</dt>
        <dd>{batch.failedRunCount}</dd>
      </div>
    </dl>
  );
}

function BatchProgressRecord({ state, batch }: Readonly<{
  state: Extract<BatchProgressState, { status: 'ready' | 'failed' | 'complete' }>['status'];
  batch: ComparisonBatchProgress;
}>) {
  const copy = state === 'ready'
    ? {
        label: 'Live execution',
        heading: 'Batch is progressing through recorded stages',
        body: 'Stage and run counts are refreshed from the authorized safe projection. Counts are reported as recorded, not converted into a progress percentage.',
      }
    : getBatchProgressStateContent(state);
  const stageLabel = getBatchStageLabel(batch.stage);

  return (
    <div className={`batch-progress-record batch-progress-record--${state}`}>
      <div className="batch-progress-summary">
        <div>
          <p className="eyebrow">{copy.label}</p>
          <h3>{copy.heading}</h3>
          <p>{copy.body}</p>
        </div>
        <span className={`batch-status-tag batch-status-tag--${state}`}>
          {state === 'ready' ? 'In progress' : state === 'complete' ? 'Complete' : 'Failed'}
        </span>
      </div>

      <div className="batch-current-stage" role="status" aria-live="polite">
        <span className="eyebrow">Current recorded stage</span>
        <strong>{stageLabel}</strong>
      </div>

      <BatchStageLedger batch={batch} state={state} />

      <div className="batch-accounting-section">
        <div>
          <p className="eyebrow">Safe run accounting</p>
          <p>These counts describe execution state only. They do not reveal run output, trace payloads, or artifacts.</p>
        </div>
        <BatchRunAccounting batch={batch} />
      </div>

      <p className="batch-identifier"><span>Batch ID</span> {batch.id}</p>
    </div>
  );
}

export function BatchProgressStateView({ state, onRetry }: Readonly<{
  state: BatchProgressState;
  onRetry: () => void;
}>) {
  if (state.status === 'loading') {
    return (
      <div className="batch-progress-loading" aria-busy="true" aria-label="Loading batch progress">
        <span /><span /><span /><span />
      </div>
    );
  }

  if (state.status === 'ready' || state.status === 'failed' || state.status === 'complete') {
    return <BatchProgressRecord state={state.status} batch={state.batch} />;
  }

  const copy = getBatchProgressStateContent(state.status);
  return (
    <section className={`batch-progress-state batch-progress-state--${state.status}`} aria-labelledby="batch-progress-state-title">
      <p className="eyebrow">{copy.label}</p>
      <h3 id="batch-progress-state-title">{copy.heading}</h3>
      <p>{copy.body}</p>
      {state.status === 'error' && <button type="button" className="batch-progress-retry" onClick={onRetry}>Retry progress request</button>}
    </section>
  );
}

function Workspace() {
  const [organizationName] = useState(readOrganizationName);
  const [projectState, setProjectState] = useState<ProjectListState>({ status: 'loading' });
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [versionState, setVersionState] = useState<VersionSelectionState>({ status: 'idle' });
  const [scenarioVersionId, setScenarioVersionId] = useState('');
  const [baselineVersionId, setBaselineVersionId] = useState('');
  const [candidateVersionId, setCandidateVersionId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creationState, setCreationState] = useState<CreationState>({ status: 'idle' });
  const batchId = useMemo(readBatchId, []);
  const [batchProgressState, setBatchProgressState] = useState<BatchProgressState>(() => batchId === null ? { status: 'idle' } : { status: 'loading' });
  const [batchProgressRetryKey, setBatchProgressRetryKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    void requestProjects(controller.signal)
      .then((projects) => {
        setProjectState(projects.length === 0 ? { status: 'empty' } : { status: 'ready', projects });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setProjectState({
          status: error instanceof ProjectApiError ? getProjectRequestState(error.status) : 'error',
        });
      });

    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setVersionState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    setVersionState({ status: 'loading' });

    void requestVersionData(selectedProjectId, controller.signal)
      .then(({ scenarioVersions, agentVersions }) => {
        setVersionState({ status: 'ready', scenarioVersions, agentVersions });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setVersionState({
          status: error instanceof ProjectApiError ? getProjectRequestState(error.status) : 'error',
        });
      });

    return () => controller.abort();
  }, [selectedProjectId]);

  useEffect(() => {
    if (batchId === null) {
      setBatchProgressState({ status: 'idle' });
      return;
    }

    const controller = new AbortController();
    let pollTimer: number | undefined;

    const poll = (): void => {
      void requestBatchProgress(batchId, controller.signal)
        .then((batch) => {
          const nextState = getBatchProgressStateFromBatch(batch);
          setBatchProgressState(nextState);

          if (!isTerminalBatchProgress(batch)) {
            pollTimer = window.setTimeout(poll, 4_000);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) {
            return;
          }

          setBatchProgressState({
            status: error instanceof BatchProgressApiError ? getBatchProgressRequestState(error.status) : 'error',
          });
        });
    };

    setBatchProgressState({ status: 'loading' });
    poll();

    return () => {
      controller.abort();
      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer);
      }
    };
  }, [batchId, batchProgressRetryKey]);

  function handleProjectSelection(projectId: string) {
    setSelectedProjectId(projectId);
    setScenarioVersionId('');
    setBaselineVersionId('');
    setCandidateVersionId('');
  }

  function handleBaselineVersionChange(versionId: string) {
    setBaselineVersionId(versionId);
    if (versionId === candidateVersionId) {
      setCandidateVersionId('');
    }
  }

  function handleCandidateVersionChange(versionId: string) {
    setCandidateVersionId(versionId);
    if (versionId === baselineVersionId) {
      setBaselineVersionId('');
    }
  }

  async function handleCreateProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedDescription = description.trim();

    if (!trimmedName || projectState.status === 'loading') {
      return;
    }

    setCreationState({ status: 'submitting' });

    try {
      const organizationId = readOrganizationId();
      const response = await fetch('/v1/projects', {
        method: 'POST',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(organizationId === null ? {} : { 'x-varytra-organization': organizationId }),
        },
        body: JSON.stringify({ name: trimmedName, description: trimmedDescription || undefined }),
      });

      if (!response.ok) {
        throw new ProjectApiError(response.status);
      }

      const body: unknown = await response.json();
      const project = parseCreatedProjectResponse(body);

      setProjectState((current) => {
        if (current.status === 'ready') {
          const projects = current.projects.some(({ id }) => id === project.id)
            ? current.projects
            : [project, ...current.projects];
          return { status: 'ready', projects };
        }

        return { status: 'ready', projects: [project] };
      });
      setName('');
      setDescription('');
      setCreationState({ status: 'success', projectName: project.name });
    } catch (error: unknown) {
      setCreationState({
        status: error instanceof ProjectApiError ? getProjectRequestState(error.status) : 'error',
      });
    }
  }

  const accessRestricted = projectState.status === 'permission';
  const isSubmitting = creationState.status === 'submitting';

  return (
    <main className="app-shell">
      <header className="masthead">
        <a className="wordmark" href="#projects" aria-label="Varytra projects workspace">
          VARYTRA<span className="wordmark-mark">/</span>
        </a>
        <div className="organization-context">
          <span className="eyebrow">Active organization</span>
          <strong title={organizationName}>{organizationName}</strong>
        </div>
      </header>

      <section className="workspace-heading" aria-labelledby="page-title">
        <p className="eyebrow">Workspace / project register</p>
        <h1 id="page-title">Projects anchor every release decision.</h1>
        <p className="lede">
          Define the release question once, then keep its scenarios, agent versions, comparisons, and evidence in one accountable record.
        </p>
      </section>

      <section id="projects" className="projects-pane" aria-labelledby="projects-title">
        <div className="pane-header">
          <div>
            <p className="eyebrow">Available records</p>
            <h2 id="projects-title">Project register</h2>
          </div>
          <p className="record-count" aria-live="polite">
            {projectState.status === 'ready' ? `${projectState.projects.length} recorded` : 'Live record'}
          </p>
        </div>
        <ProjectListStateView state={projectState} />
      </section>

      {projectState.status === 'empty' && <FirstRunOnboarding />}

      <section className="version-pane" aria-labelledby="version-selection-title">
        <div className="version-pane-heading">
          <div>
            <p className="eyebrow">Comparison input / immutable selection</p>
            <h2 id="version-selection-title">Resolve versioned inputs</h2>
          </div>
          <p>Choose a project, then explicitly select the scenario, baseline, and candidate records that will define a future comparison.</p>
        </div>

        <div className="project-selector field-group">
          <label htmlFor="comparison-project">Project</label>
          <select
            id="comparison-project"
            name="project"
            value={selectedProjectId}
            onChange={(event) => handleProjectSelection(event.target.value)}
            disabled={projectState.status !== 'ready'}
            aria-describedby="comparison-project-help"
          >
            <option value="">{projectState.status === 'ready' ? 'Choose a project' : 'Project records are unavailable'}</option>
            {projectState.status === 'ready' && projectState.projects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.id}</option>)}
          </select>
          <p id="comparison-project-help" className="field-help">Project selection determines which version records can be inspected.</p>
        </div>

        {versionState.status === 'ready' ? (
          <VersionSelectionControls
            state={versionState}
            scenarioVersionId={scenarioVersionId}
            baselineVersionId={baselineVersionId}
            candidateVersionId={candidateVersionId}
            onScenarioVersionChange={setScenarioVersionId}
            onBaselineVersionChange={handleBaselineVersionChange}
            onCandidateVersionChange={handleCandidateVersionChange}
          />
        ) : <VersionSelectionStateView state={versionState} />}
      </section>

      <section className="batch-progress-pane" aria-labelledby="batch-progress-title">
        <div className="batch-progress-pane-heading">
          <div>
            <p className="eyebrow">Comparison batch / safe projection</p>
            <h2 id="batch-progress-title">Execution progress</h2>
          </div>
          <p>Observe the batch stage and exact run accounting without opening raw traces or artifacts.</p>
        </div>
        <BatchProgressStateView state={batchProgressState} onRetry={() => setBatchProgressRetryKey((current) => current + 1)} />
      </section>

      <section id="create-project" className="create-pane" aria-labelledby="create-project-title">
        <div className="create-pane-heading">
          <p className="eyebrow">New record</p>
          <h2 id="create-project-title">Create project</h2>
          <p>Start with a concise name and the decision this workspace will make legible.</p>
        </div>

        {accessRestricted ? (
          <p className="form-notice form-notice--permission" role="status">
            Project creation is unavailable because this workspace is restricted.
          </p>
        ) : (
          <form className="project-form" onSubmit={handleCreateProject}>
            <div className="field-group">
              <label htmlFor="project-name">Project name</label>
              <input
                id="project-name"
                name="name"
                autoComplete="off"
                maxLength={120}
                required
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  if (creationState.status !== 'idle') setCreationState({ status: 'idle' });
                }}
                disabled={isSubmitting || projectState.status === 'loading'}
              />
            </div>
            <div className="field-group">
              <label htmlFor="project-description">Release question <span>(optional)</span></label>
              <textarea
                id="project-description"
                name="description"
                rows={3}
                maxLength={500}
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                  if (creationState.status !== 'idle') setCreationState({ status: 'idle' });
                }}
                disabled={isSubmitting || projectState.status === 'loading'}
              />
            </div>
            <button type="submit" disabled={isSubmitting || projectState.status === 'loading'}>
              {isSubmitting ? 'Creating project…' : 'Create project'}
            </button>
            {creationState.status === 'success' && (
              <p className="form-notice form-notice--success" role="status">
                <span aria-hidden="true">✓</span> {creationState.projectName} was added to the register.
              </p>
            )}
            {creationState.status === 'permission' && (
              <p className="form-notice form-notice--permission" role="alert">
                You do not have the role required to create projects in this organization.
              </p>
            )}
            {creationState.status === 'error' && (
              <p className="form-notice form-notice--error" role="alert">
                The project could not be created. Check the connection and try again.
              </p>
            )}
          </form>
        )}
      </section>

      <footer>
        <span>Varytra</span>
        <span>Evidence before release</span>
      </footer>
    </main>
  );
}

export function App() {
  const comparisonId = typeof window === 'undefined' ? null : readComparisonIdFromSearch(window.location.search);
  return comparisonId === null ? <Workspace /> : <ReportScreen comparisonId={comparisonId} />;
}
