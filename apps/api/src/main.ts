import { buildApp } from './app.js';

const app = buildApp();

await app.listen({ host: '0.0.0.0', port: 3000 });
