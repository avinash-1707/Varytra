import { describe, expect, it } from 'vitest';
import { loadSmtpConfig } from '../apps/api/src/email.js';

describe('SMTP configuration', () => {
  it('fails closed when delivery credentials are incomplete', () => {
    expect(() => loadSmtpConfig({ SMTP_HOST: 'smtp.example.com' })).toThrow(
      'SMTP_FROM, SMTP_PASSWORD, SMTP_USER',
    );
  });

  it('uses the secure submission port by default', () => {
    expect(loadSmtpConfig({
      SMTP_FROM: 'noreply@example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PASSWORD: 'smtp-password',
      SMTP_USER: 'smtp-user',
    })).toEqual({
      from: 'noreply@example.com',
      host: 'smtp.example.com',
      password: 'smtp-password',
      port: 587,
      user: 'smtp-user',
    });
  });
});
