import nodemailer from 'nodemailer';
import type { ReviewNotification } from '@varytra/infrastructure/review-notifications';

export interface ReviewNotificationSender {
  readonly send: (notification: ReviewNotification) => Promise<void>;
}

export function createSmtpReviewNotificationSender(environment: NodeJS.ProcessEnv): ReviewNotificationSender | undefined {
  const from = environment.SMTP_FROM;
  const host = environment.SMTP_HOST;
  const password = environment.SMTP_PASSWORD;
  const user = environment.SMTP_USER;
  const values = [from, host, password, user];
  if (values.every((value) => value === undefined)) return undefined;
  const appUrlValue = environment.APP_URL;
  if (from === undefined || host === undefined || password === undefined || user === undefined || appUrlValue === undefined) {
    throw new Error('SMTP_FROM, SMTP_HOST, SMTP_PASSWORD, SMTP_USER, and APP_URL are required for review notifications');
  }
  const appUrl = new URL(appUrlValue);
  const port = environment.SMTP_PORT === undefined ? 587 : Number(environment.SMTP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SMTP_PORT must be a valid port number');
  const transporter = nodemailer.createTransport({
    auth: { pass: password, user },
    host,
    port,
    requireTLS: port !== 465,
    secure: port === 465,
  });

  return {
    send: async (notification) => {
      const reportUrl = new URL(`/reports/${notification.comparisonId}`, appUrl).toString();
      await transporter.sendMail({
        from,
        to: notification.recipientEmail,
        messageId: `<${notification.id}@varytra>`,
        subject: `Review required: ${notification.severity} Varytra regression`,
        // SMTP delivery is at-least-once across a process crash; the stable message ID makes retries diagnosable.
        text: `A Varytra comparison needs review.\n\nClassification: ${notification.classification}\nSeverity: ${notification.severity}\n\nOpen the authorized report: ${reportUrl}`,
      });
    },
  };
}
