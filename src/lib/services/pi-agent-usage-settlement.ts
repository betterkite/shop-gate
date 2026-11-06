import type { PrismaClient } from '@prisma/client';
import { createQuotaService, QuotaError } from '@/lib/quota/service';

export const biAgentTokenReservationKey = (runId: string) => `bi-agent:${runId}:tokens`;

/** One settlement path for live completion and crash/maintenance recovery.
 * Observed usage must still be recorded if a crashed worker's reservation has
 * expired; that never grants permission to start another model request. */
export async function settleAgentRunUsage(client: PrismaClient, runId: string) {
  const run = await client.agentRun.findUniqueOrThrow({ where: { id: runId } });
  if (!run.finishedAt || ['pending', 'running', 'waiting', 'reconciling'].includes(run.status) || !run.actorUserId) {
    throw new Error('Only terminal, actor-bound Agent usage can be settled.');
  }
  const quota = createQuotaService(client);
  const reservation = await client.quotaReservation.findUnique({ where: { idempotencyKey: biAgentTokenReservationKey(run.id) } });
  if (reservation && (reservation.actorUserId !== run.actorUserId || reservation.projectId !== run.projectId
      || reservation.metric !== 'llm.total_tokens.monthly' || !run.biRequestId)) {
    throw new Error('Agent token reservation identity mismatch.');
  }
  if (run.totalTokens === 0) {
    if (reservation) await quota.release({ reservationId: reservation.id });
    return null;
  }
  const eventKey = `agent-run:${run.id}:total-tokens`;
  const metadata = { provider: run.provider, model: run.model, inputTokens: run.inputTokens, outputTokens: run.outputTokens };
  // An older application instance may already have recorded the same usage.
  // Preserve its idempotency key and release the now-redundant reservation.
  const existing = await client.usageEvent.findUnique({ where: { idempotencyKey: eventKey }, select: { id: true } });
  if (reservation?.status === 'active' && !existing) {
    try {
      return await quota.settle({ reservationId: reservation.id, actualQuantity: run.totalTokens,
        sourceType: 'agent_run', sourceId: run.id, usageEventIdempotencyKey: eventKey,
        occurredAt: run.finishedAt, metadata });
    } catch (error) {
      if (!(error instanceof QuotaError) || !['QUOTA_RESERVATION_EXPIRED', 'QUOTA_RESERVATION_INACTIVE',
        'QUOTA_SETTLEMENT_EXCEEDS_RESERVATION', 'QUOTA_IDEMPOTENCY_CONFLICT'].includes(error.code)) throw error;
      // Re-read through recordUsage below: it verifies actor/project/quantity/
      // source identity, so a conflict can never silently discard real usage.
    }
  }
  const result = await quota.recordUsage({ actorUserId: run.actorUserId, projectId: run.projectId,
    metric: 'llm.total_tokens.monthly', quantity: run.totalTokens, idempotencyKey: eventKey,
    sourceType: 'agent_run', sourceId: run.id, occurredAt: run.finishedAt, metadata });
  if (reservation) await quota.release({ reservationId: reservation.id });
  return result;
}
