import { betterAuth } from 'better-auth';
import { emailOTP } from 'better-auth/plugins';
import { createDatabasePool } from '@varytra/infrastructure';
import { z } from 'zod';

const authConfigSchema = z.object({
  APP_URL: z.url(),
  DATABASE_URL: z.url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
});

export interface AuthConfig {
  readonly appUrl: string;
  readonly baseUrl: string;
  readonly databaseUrl: string;
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
    throw new Error(`Invalid auth configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }

  return {
    baseUrl: parsed.data.BETTER_AUTH_URL,
    appUrl: parsed.data.APP_URL,
    databaseUrl: parsed.data.DATABASE_URL,
    secret: parsed.data.BETTER_AUTH_SECRET,
  };
}

export function createAuth(config: AuthConfig, emailSender: OtpEmailSender) {
  return betterAuth({
    baseURL: config.baseUrl,
    database: createDatabasePool({ connectionString: config.databaseUrl }),
    secret: config.secret,
    trustedOrigins: [config.baseUrl, config.appUrl],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
    },
    account: {
      accountLinking: {
        disableImplicitLinking: true,
      },
    },
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
}
