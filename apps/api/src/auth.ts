import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { createDatabasePool } from '@varytra/infrastructure';
import { z } from 'zod';
import { createAuthAuditWriter } from './auth-audit.js';

const authConfigSchema = z.object({
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
}).refine(
  (config) => (config.GOOGLE_CLIENT_ID === undefined) === (config.GOOGLE_CLIENT_SECRET === undefined),
  { message: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured together' },
);

export interface AuthConfig {
  readonly appUrl: string;
  readonly baseUrl: string;
  readonly databaseUrl: string;
  readonly google?: Readonly<{
    clientId: string;
    clientSecret: string;
  }>;
  readonly secret: string;
}

export interface OtpEmailSender {
  readonly sendOtp: (message: Readonly<{
    email: string;
    otp: string;
    purpose: 'email-verification' | 'forget-password';
  }>) => Promise<void>;
}

export function loadAuthConfig(environment: NodeJS.ProcessEnv): AuthConfig {
  const parsed = authConfigSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid auth configuration: ${parsed.error.issues.map((issue) => (
      issue.path.length === 0 ? issue.message : issue.path.join('.')
    )).join(', ')}`);
  }

  return {
    baseUrl: parsed.data.BETTER_AUTH_URL,
    appUrl: parsed.data.APP_URL,
    databaseUrl: parsed.data.DATABASE_URL,
    ...(parsed.data.GOOGLE_CLIENT_ID === undefined ? {} : {
      google: {
        clientId: parsed.data.GOOGLE_CLIENT_ID,
        clientSecret: parsed.data.GOOGLE_CLIENT_SECRET!,
      },
    }),
    secret: parsed.data.BETTER_AUTH_SECRET,
  };
}

export function createAuth(config: AuthConfig, emailSender: OtpEmailSender) {
  const database = createDatabasePool({ connectionString: config.databaseUrl });
  const audit = createAuthAuditWriter(database);
  const auth = betterAuth({
    baseURL: config.baseUrl,
    database,
    secret: config.secret,
    trustedOrigins: [config.baseUrl, config.appUrl],
    emailAndPassword: {
      enabled: true,
      onPasswordReset: async ({ user }) => {
        await audit.write({ action: 'auth.password_reset', userId: user.id });
      },
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
      afterEmailVerification: async (user) => {
        await audit.write({ action: 'auth.email_verified', userId: user.id });
      },
    },
    databaseHooks: {
      account: {
        create: {
          after: async (account) => {
            await audit.write({
              action: 'auth.account_linked',
              providerId: account.providerId,
              userId: account.userId,
            });
          },
        },
        delete: {
          before: async (account) => {
            await audit.write({
              action: 'auth.account_unlink_requested',
              providerId: account.providerId,
              userId: account.userId,
            });
          },
        },
      },
    },
    account: {
      accountLinking: {
        allowUnlinkingAll: false,
        disableImplicitLinking: true,
      },
    },
    session: {
      freshAge: 60 * 60 * 24,
    },
    ...(config.google === undefined ? {} : {
      socialProviders: {
        google: config.google,
      },
    }),
    plugins: [emailOTP({
      allowedAttempts: 3,
      overrideDefaultEmailVerification: true,
      otpLength: 6,
      sendVerificationOnSignUp: true,
      storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type === 'email-verification' || type === 'forget-password') {
          await emailSender.sendOtp({ email, otp, purpose: type });
        }
      },
    })],
  });

  return Object.assign(auth, {
    isRecentSession: async (headers: Headers): Promise<boolean> => {
      const session = await auth.api.getSession({ headers });

      return session !== null && Date.now() - new Date(session.session.createdAt).getTime() <= 86_400_000;
    },
  });
}
