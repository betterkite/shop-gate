import type { PrismaClient } from '@prisma/client';

/** Read-only reconciliation candidates. NULL project IDs are genuine personal
 * or shared BI runs, and must match an existing NULL-bound usage event. */
export interface UnmeteredAgentRun {
  id: string;
  actorUserId: string;
  projectId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishedAt: Date;
}

export async function listUnmeteredAgentRuns(
  client: Pick<PrismaClient, '$queryRaw'>, limit: number,
): Promise<UnmeteredAgentRun[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Usage reconciliation batch size must be between 1 and 10000.');
  }
  return client.$queryRaw<UnmeteredAgentRun[]>`
    SELECT
      runs."id",
      runs."actor_user_id" AS "actorUserId",
      runs."project_id" AS "projectId",
      runs."provider",
      runs."model",
      runs."input_tokens" AS "inputTokens",
      runs."output_tokens" AS "outputTokens",
      runs."total_tokens" AS "totalTokens",
      runs."finished_at" AS "finishedAt"
    FROM "agent_runs" runs
    WHERE runs."actor_user_id" IS NOT NULL
      AND runs."finished_at" IS NOT NULL
      AND runs."total_tokens" > 0
      AND NOT EXISTS (
        SELECT 1
        FROM "usage_events" events
        WHERE events."idempotency_key" = 'agent-run:' || runs."id" || ':total-tokens'
          AND events."actor_user_id" = runs."actor_user_id"
          AND events."project_id" IS NOT DISTINCT FROM runs."project_id"
          AND events."metric" = 'llm.total_tokens.monthly'
          AND events."quantity" = runs."total_tokens"::bigint
          AND events."source_type" = 'agent_run'
          AND events."source_id" = runs."id"
      )
    ORDER BY runs."finished_at" ASC, runs."id" ASC
    LIMIT ${limit}
  `;
}

