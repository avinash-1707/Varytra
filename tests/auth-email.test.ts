import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../apps/api/src/app.js';
import { createAuth, type OtpEmailSender } from '../apps/api/src/auth.js';
import { createDatabasePool } from '@varytra/infrastructure';
import { runMigrations } from '@varytra/infrastructure/migrate';

const connectionString = process.env.DATABASE_URL;
const describeDatabase = connectionString === undefined ? describe.skip : describe;
const authConfig = {
  appUrl: 'http://localhost:5173',
  baseUrl: 'http://localhost:3000',
  databaseUrl: 'postgres://varytra:varytra@127.0.0.1:5432/varytra',
  secret: '0123456789abcdef0123456789abcdef',
};

describeDatabase('auth email', () => {
  let sentOtps: Array<Parameters<OtpEmailSender['sendOtp']>[0]>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    await runMigrations(connectionString!);
    const database = createDatabasePool({ connectionString: connectionString! });
    await database.query('TRUNCATE account, session, verification, "user" CASCADE');
    await database.end();
    sentOtps = [];
    app = buildApp({
      auth: createAuth(authConfig, {
        sendOtp: async (message) => {
          sentOtps.push(message);
        },
      }),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('requires six-digit email verification before password sign-in', async () => {
    const signUp = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', name: 'User', password: 'correct-horse-battery-staple' },
    });

    expect(signUp.statusCode).toBe(200);
    expect(sentOtps).toHaveLength(1);
    expect(sentOtps[0]).toMatchObject({ email: 'user@example.com', purpose: 'email-verification' });

    const signInBeforeVerification = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', password: 'correct-horse-battery-staple' },
    });

    expect(signInBeforeVerification.statusCode).toBe(403);

    const verification = await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/verify-email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', otp: sentOtps[0]?.otp },
    });

    expect(verification.statusCode).toBe(200);

    const signInAfterVerification = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', password: 'correct-horse-battery-staple' },
    });

    expect(signInAfterVerification.statusCode).toBe(200);
  });
});
