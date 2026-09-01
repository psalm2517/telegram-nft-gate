import type { AppContext } from './context.js';
import { addHours, nowIso } from './lib/time.js';

export interface RecheckSummary {
  checked: number;
  stillEligible: number;
  graceStarted: number;
  restored: number;
  revoked: number;
  indeterminate: number;
  noncesPurged: number;
  errors: number;
}

/**
 * Scheduled ownership re-check (Cron Trigger).
 *
 * Two passes:
 *  1. users whose last check is older than RECHECK_INTERVAL_HOURS
 *  2. grace-period users whose window has closed, so revocation happens on time
 *     even if their ownership check is not yet due
 *
 * Work is bounded by RECHECK_BATCH_SIZE per invocation to stay inside Worker
 * limits; the queue is ordered oldest-first so nobody is starved.
 */
export async function runScheduledRecheck(ctx: AppContext): Promise<RecheckSummary> {
  const summary: RecheckSummary = {
    checked: 0,
    stillEligible: 0,
    graceStarted: 0,
    restored: 0,
    revoked: 0,
    indeterminate: 0,
    noncesPurged: 0,
    errors: 0,
  };

  const at = nowIso();
  const dueCutoff = addHours(at, -ctx.config.recheckIntervalHours);

  const due = await ctx.db.listUsersDueForRecheck(dueCutoff, ctx.config.recheckBatchSize);

  // Grace users past their deadline, that the pass above may not have picked up.
  const graceCutoff = addHours(at, -ctx.config.gracePeriodHours);
  const expired = await ctx.db.listExpiredGraceUsers(graceCutoff, ctx.config.recheckBatchSize);

  const seen = new Set<string>();
  const queue = [...due, ...expired].filter((u) => {
    if (seen.has(u.telegram_user_id)) return false;
    seen.add(u.telegram_user_id);
    return true;
  });

  for (const user of queue) {
    try {
      const decision = await ctx.access.recheckUser(user, 'scheduled_recheck');
      summary.checked++;

      switch (decision.ownership) {
        case 'INDETERMINATE':
          summary.indeterminate++;
          break;
        case 'OWNED':
          if (decision.previousStatus === 'grace') summary.restored++;
          else summary.stillEligible++;
          break;
        case 'NOT_OWNED':
          if (decision.newStatus === 'grace' && decision.changed) summary.graceStarted++;
          if (decision.newStatus === 'revoked' && decision.changed) summary.revoked++;
          break;
      }

      // Notify out-of-band; a failed DM must not abort the batch.
      if (decision.notify && decision.changed) {
        await ctx.telegram.sendMessage(user.telegram_user_id, decision.notify);
        if (decision.inviteLink) {
          await ctx.telegram.sendMessage(
            user.telegram_user_id,
            `Your single-use invite link:\n${decision.inviteLink}`,
          );
        }
      }
    } catch (err) {
      // One bad row must not take down the whole scheduled run.
      summary.errors++;
      console.error('recheck failed', { user: user.telegram_user_id, error: String(err) });
    }
  }

  summary.noncesPurged = await ctx.db.deleteExpiredNonces(addHours(at, -24));
  return summary;
}
