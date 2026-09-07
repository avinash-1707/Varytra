import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { OtpEmailSender } from './auth.js';

const smtpConfigSchema = z.object({
  SMTP_FROM: z.string().email(),
  SMTP_HOST: z.string().min(1),
  SMTP_PASSWORD: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
  SMTP_USER: z.string().min(1),
});

export interface SmtpConfig {
  readonly from: string;
  readonly host: string;
  readonly password: string;
  readonly port: number;
  readonly user: string;
}

export function loadSmtpConfig(environment: NodeJS.ProcessEnv): SmtpConfig {
  const parsed = smtpConfigSchema.safeParse(environment);

  if (!parsed.success) {
    throw new Error(`Invalid SMTP configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  }

  return {
    from: parsed.data.SMTP_FROM,
    host: parsed.data.SMTP_HOST,
    password: parsed.data.SMTP_PASSWORD,
    port: parsed.data.SMTP_PORT,
    user: parsed.data.SMTP_USER,
  };
}

export function createSmtpOtpSender(config: SmtpConfig): OtpEmailSender {
  const transporter = nodemailer.createTransport({
    auth: {
      pass: config.password,
      user: config.user,
    },
    host: config.host,
    port: config.port,
    requireTLS: config.port !== 465,
    secure: config.port === 465,
  });

  return {
    sendOtp: async ({ email, otp, purpose }) => {
      const subject = purpose === 'email-verification'
        ? 'Verify your Varytra email address'
        : 'Reset your Varytra password';
      const text = `Your Varytra code is ${otp}. It expires in 5 minutes.`;

      await transporter.sendMail({ from: config.from, to: email, subject, text });
    },
  };
}
