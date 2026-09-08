import { type FormEvent, useEffect, useState } from 'react';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
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

function parseCreatedProjectResponse(response: unknown): Project {
  if (isRecord(response) && 'project' in response) {
    return parseProject(response.project);
  }

  return parseProject(response);
}

export function getProjectRequestState(status: number): 'permission' | 'error' {
  return status === 403 ? 'permission' : 'error';
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

export function App() {
  const [organizationName] = useState(readOrganizationName);
  const [projectState, setProjectState] = useState<ProjectListState>({ status: 'loading' });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [creationState, setCreationState] = useState<CreationState>({ status: 'idle' });

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

      <section className="create-pane" aria-labelledby="create-project-title">
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
