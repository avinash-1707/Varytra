export interface NoopJobResult {
  readonly status: 'processed';
}

export async function processNoopJob(): Promise<NoopJobResult> {
  return { status: 'processed' };
}
