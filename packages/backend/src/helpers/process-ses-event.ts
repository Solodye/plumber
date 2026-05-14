import { WorkerPro } from '@taskforcesh/bullmq-pro'

import { createRedisClient } from '@/config/redis'
import logger from '@/helpers/logger'
import { SesEvent, SesEventType } from '@/helpers/ses-event-parser'
import EmailSuppressionEntry from '@/models/email-suppression-entry'
import { startSqsPoller } from '@/queues/ses-events'

export interface SesEventInput {
  sesEvent: SesEvent
  sqsMessageId: string
}

/**
 * Process a parsed SES event (called by the SQS consumer's handleMessage).
 *
 * NOTE on recipient arrays:
 *   `bouncedRecipients` and `complainedRecipients` are arrays per the SES
 *   spec, but in practice each event we receive will only contain ONE
 *   recipient. This is because our SES sender (sendViaSes) calls
 *   SendEmailCommand with a single `ToAddresses` per call. The loops below
 *   still iterate to remain faithful to the spec and to be safe if Phase 2
 *   ever introduces multi-recipient sends via SendBulkEmailCommand.
 */
export async function processSesEvent(data: SesEventInput): Promise<void> {
  const { sesEvent, sqsMessageId } = data
  const { eventType, mail } = sesEvent

  if (eventType === SesEventType.Bounce) {
    // Defensive: an event tagged Bounce must carry a bounce payload. If it
    // doesn't, surface it loudly rather than silently dropping the event.
    if (!sesEvent.bounce) {
      logger.error('Bounce event missing bounce payload', {
        event: 'ses-malformed-event',
        sqsMessageId,
        messageId: mail?.messageId,
      })
      return
    }

    const { bounceType, bounceSubType, bouncedRecipients } = sesEvent.bounce

    if (bounceType === 'Permanent') {
      for (const recipient of bouncedRecipients) {
        await EmailSuppressionEntry.upsertSuppression({
          email: recipient.emailAddress,
          reason: 'BOUNCE',
          reasonDetail: bounceSubType,
          sesMessageId: mail.messageId,
        })

        logger.info('Email suppressed due to permanent bounce', {
          event: 'ses-email-suppressed',
          email: recipient.emailAddress,
          bounceType,
          bounceSubType,
          sesMessageId: mail.messageId,
          sqsMessageId,
        })
      }
    } else {
      // Transient / Undetermined — log only, do not suppress
      logger.info('Transient bounce received — no suppression', {
        event: 'ses-transient-bounce',
        bounceType,
        bounceSubType,
        recipients: bouncedRecipients.map((r) => r.emailAddress),
        sesMessageId: mail.messageId,
        sqsMessageId,
      })
    }
    return
  }

  if (eventType === SesEventType.Complaint) {
    if (!sesEvent.complaint) {
      logger.error('Complaint event missing complaint payload', {
        event: 'ses-malformed-event',
        sqsMessageId,
        messageId: mail?.messageId,
      })
      return
    }

    const { complainedRecipients, complaintFeedbackType } = sesEvent.complaint

    if (complaintFeedbackType === 'not-spam') {
      // Auto-whitelist: recipient marked the email as not-spam
      const emails = complainedRecipients.map((r) => r.emailAddress)
      const whitelisted = await EmailSuppressionEntry.whitelistEmails(emails)

      logger.info('Auto-whitelisted emails due to not-spam complaint', {
        event: 'ses-auto-whitelist',
        whitelisted,
        sesMessageId: mail.messageId,
        sqsMessageId,
      })
    } else {
      // abuse, fraud, virus, other, null — suppress
      for (const recipient of complainedRecipients) {
        await EmailSuppressionEntry.upsertSuppression({
          email: recipient.emailAddress,
          reason: 'COMPLAINT',
          reasonDetail: complaintFeedbackType ?? 'other',
          sesMessageId: mail.messageId,
        })

        logger.info('Email suppressed due to complaint', {
          event: 'ses-email-suppressed',
          email: recipient.emailAddress,
          complaintFeedbackType,
          sesMessageId: mail.messageId,
          sqsMessageId,
        })
      }
    }
    return
  }

  logger.warn('Unhandled SES event type', {
    event: 'ses-unhandled-event',
    eventType,
    sqsMessageId,
  })
}

export const worker = new WorkerPro(
  'ses-events',
  async (job) => {
    await processSesEvent(job.data)
  },
  {
    prefix: '{sesEventsQ}',
    connection: createRedisClient(),
    concurrency: 5,
  },
)

worker.on('completed', (job) => {
  logger.info(`SES event job completed: ${job.id}`)
})

worker.on('failed', (job, err) => {
  logger.error(`SES event job failed: ${job.id} — ${err.message}`, {
    event: 'ses-event-job-failed',
    jobId: job.id,
    error: err.stack,
  })
})

worker.on('ready', () => {
  logger.info('SES events worker is ready!')
})

worker.on('closed', () => {
  logger.info('SES events worker is closed!')
})

worker.on('error', (err) => {
  if (!err) {
    logger.error('SES events worker undefined error')
    return
  }
  logger.error(`SES events worker errored with ${err.message}`, {
    err: err.stack,
  })
})

process.on('SIGTERM', async () => {
  await worker.close()
})

// Start the SQS poller after worker is registered
startSqsPoller()
