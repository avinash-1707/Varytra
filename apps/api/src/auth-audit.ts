import type { Pool } from 'pg';

type AuthAuditAction =
  | 'auth.account_linked'
  | 'auth.account_unlink_requested'
  | 'auth.email_verified'
  | 'auth.password_reset';

export interface AuthAuditWriter {
  readonly write: (event: Readonly<{
    action: AuthAuditAction;
    providerId?: string;
    userId: string;
  }>) => Promise<void>;
}

export function createAuthAuditWriter(pool: Pool): AuthAuditWriter {
  return {
    write: async ({ action, providerId, userId }) => {
      await pool.query(
        'INSERT INTO account_security_events (user_id, action, provider_id) VALUES ($1, $2, $3)',
        [userId, action, providerId ?? null],
      );
    },
  };
}
