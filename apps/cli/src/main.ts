#!/usr/bin/env node
type Json = Record<string, unknown>;

export class CliError extends Error {}

export function parseArguments(args: readonly string[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || !key.startsWith('--')) throw new CliError('Arguments must use --name value pairs.');
    values[key.slice(2)] = value;
  }
  return values;
}

async function request(url: string, init: RequestInit): Promise<Json> {
  const response = await fetch(url, init);
  const body: unknown = await response.json();
  if (!response.ok || typeof body !== 'object' || body === null || Array.isArray(body)) throw new CliError(`Varytra API request failed with status ${response.status}.`);
  return body as Json;
}

export async function runCli(args: readonly string[], output: (value: string) => void = console.log): Promise<number> {
  const [command, ...flags] = args;
  const values = parseArguments(flags);
  const apiUrl = values['api-url'];
  const apiKey = values['api-key'];
  if (apiUrl === undefined || apiKey === undefined) throw new CliError('--api-url and --api-key are required.');
  const authorization = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  if (command === 'status') {
    const ciRunId = values['ci-run-id'];
    if (ciRunId === undefined) throw new CliError('--ci-run-id is required.');
    const body = await request(`${apiUrl}/v1/ci-runs/${encodeURIComponent(ciRunId)}`, { headers: authorization });
    output(JSON.stringify(body));
    const status = (body.ci_run as Json | undefined)?.status;
    return status === 'fail' ? 1 : status === 'pending' ? 2 : 0;
  }
  if (command !== 'start') throw new CliError('Use start or status.');
  const projectId = values['project-id'];
  const baseline = values['baseline-agent-version-id'];
  const candidate = values['candidate-agent-version-id'];
  const scenarios = values['scenario-version-ids'];
  const idempotencyKey = values['idempotency-key'];
  if ([projectId, baseline, candidate, scenarios, idempotencyKey].some((value) => value === undefined)) throw new CliError('start requires project, baseline, candidate, scenario, and idempotency identifiers.');
  const body = await request(`${apiUrl}/v1/projects/${encodeURIComponent(projectId!)}/ci-runs`, {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseline_agent_version_id: baseline, candidate_agent_version_id: candidate, scenario_version_ids: scenarios!.split(','), repetition_count: Number(values['repetition-count'] ?? '1'), idempotency_key: idempotencyKey }),
  });
  output(JSON.stringify(body));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  try { process.exitCode = await runCli(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'CLI failed.'}\n`); process.exitCode = 2; }
}
