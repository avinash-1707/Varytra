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

describeDatabase('auth recovery', () => {
  let app: ReturnType<typeof buildApp>;
  let sentOtps: Array<Parameters<OtpEmailSender['sendOtp']>[0]>;

  beforeEach(async () => {
    await runMigrations(connectionString!);
    const database = createDatabasePool({ connectionString: connectionString! });
    await database.query('TRUNCATE account_security_events, account, session, verification, "user" CASCADE');
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

  it('returns a generic reset response and revokes sessions after a successful reset', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', name: 'User', password: 'correct-horse-battery-staple' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/verify-email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', otp: sentOtps[0]?.otp },
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', password: 'correct-horse-battery-staple' },
    });

    const knownReset = await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/request-password-reset',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com' },
    });
    const unknownReset = await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/request-password-reset',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'unknown@example.com' },
    });

    expect(knownReset.statusCode).toBe(200);
    expect(unknownReset.statusCode).toBe(200);
    expect(knownReset.body).toBe(unknownReset.body);

    const resetOtp = sentOtps.find((message) => message.purpose === 'forget-password');
    const reset = await app.inject({
      method: 'POST',
      url: '/api/auth/email-otp/reset-password',
      headers: { 'content-type': 'application/json', origin: authConfig.appUrl },
      payload: { email: 'user@example.com', otp: resetOtp?.otp, password: 'new-correct-horse-battery-staple' },
    });

    const database = createDatabasePool({ connectionString: connectionString! });
    const sessions = await database.query('SELECT id FROM session');
    const auditEvents = await database.query<{ readonly action: string }>(
      'SELECT action FROM account_security_events ORDER BY occurred_at',
    );
    await database.end();

    expect(reset.statusCode).toBe(200);
    expect(sessions.rows).toEqual([]);
    expect(auditEvents.rows).toEqual([
      { action: 'auth.account_linked' },
      { action: 'auth.email_verified' },
      { action: 'auth.password_reset' },
    ]);
  });
});
