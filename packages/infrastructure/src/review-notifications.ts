import type { Pool } from 'pg';
import { withOrganizationTransaction } from './index.js';

export interface ReviewNotification {
  readonly classification: 'inconclusive' | 'no-material-change' | 'suspected-regression';
  readonly comparisonId: string;
  readonly id: string;
  readonly projectId: string;
  readonly recipientEmail: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'none' | 'unknown';
}

export async function claimReviewNotification(pool: Pool, organizationId: string): Promise<ReviewNotification | undefined> {
  return withOrganizationTransaction(pool, organizationId, async (client) => {
    await client.query(
      `UPDATE review_notification_outbox notification SET status = 'cancelled', updated_at = now()
       WHERE status IN ('queued', 'sending') AND NOT EXISTS (
         SELECT 1 FROM organization_memberships member JOIN "user" recipient ON recipient.id = member.user_id
         WHERE member.organization_id = notification.organization_id AND member.user_id = notification.recipient_user_id
           AND member.role IN ('owner', 'admin', 'editor') AND recipient."emailVerified" = true
       )`,
    );
    await client.query(
      "UPDATE review_notification_outbox SET status = 'failed', lease_expires_at = NULL, updated_at = now() WHERE status = 'sending' AND lease_expires_at <= now() AND attempt_count >= 3",
    );
    const result = await client.query<ReviewNotification>(
      `WITH next_notification AS (
         SELECT notification.id, recipient.email AS "recipientEmail" FROM review_notification_outbox notification
         JOIN organization_memberships member ON member.organization_id = notification.organization_id AND member.user_id = notification.recipient_user_id
         JOIN "user" recipient ON recipient.id = member.user_id
         WHERE (notification.status = 'queued' AND notification.available_at <= now()
           OR notification.status = 'sending' AND notification.lease_expires_at <= now())
           AND notification.attempt_count < 3 AND member.role IN ('owner', 'admin', 'editor') AND recipient."emailVerified" = true
         ORDER BY notification.created_at, notification.id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE review_notification_outbox notification
       SET status = 'sending', attempt_count = attempt_count + 1, recipient_email = next_notification."recipientEmail",
         lease_expires_at = now() + interval '5 minutes', updated_at = now()
       FROM next_notification
       WHERE notification.id = next_notification.id
       RETURNING notification.id, notification.comparison_id AS "comparisonId", notification.project_id AS "projectId",
         notification.recipient_email AS "recipientEmail", notification.classification, notification.severity`,
    );
    return result.rows[0];
  });
}

export async function markReviewNotificationDelivered(pool: Pool, organizationId: string, notificationId: string): Promise<void> {
  await withOrganizationTransaction(pool, organizationId, async (client) => {
    await client.query("UPDATE review_notification_outbox SET status = 'sent', sent_at = now(), lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND status = 'sending'", [notificationId]);
  });
}

export async function retryReviewNotification(pool: Pool, organizationId: string, notificationId: string): Promise<void> {
  await withOrganizationTransaction(pool, organizationId, async (client) => {
    await client.query(
      `UPDATE review_notification_outbox
       SET status = CASE WHEN attempt_count >= 3 THEN 'failed' ELSE 'queued' END,
         available_at = now() + interval '1 minute', lease_expires_at = NULL, updated_at = now()
       WHERE id = $1 AND status = 'sending'`,
      [notificationId],
    );
  });
}
