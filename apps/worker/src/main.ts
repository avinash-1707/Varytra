import { processNoopJob } from './noop-job.js';

const result = await processNoopJob();
process.stdout.write(`No-op worker job ${result.status}.\n`);
