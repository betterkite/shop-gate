import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { hashPiAgentProvenance } from '@/lib/services/pi-agent-provenance';
import { ledgerRowSchema } from '../overview-contracts';
import { BiAgentProblem, biAgentPageScopeSchema, type BiAgentSubmission, type BiAgentPageScope } from './contracts';
import { biAgentAnswerSchema } from './result-contracts';
import { entityFields, isEntityDimension, type EvidenceSelection } from './selection-contracts';

const invalid = () => new BiAgentProblem('BI_AGENT_CONFLICT', 409, '所选明细已失效或不属于当前对话和数据版本，请重新选择。');

export async function resolveEvidenceSelection(tx: Prisma.TransactionClient, source: EvidenceSelection,
  input: BiAgentSubmission, scopeId: string, actorId: string, page: BiAgentPageScope) {
  const result = await tx.biAgentResult.findFirst({ where: { id: source.result_id, complete: true,
    run: { status: 'completed', actorUserId: actorId, executionScopeId: scopeId,
      biRequest: { conversationId: input.conversation_id, datasetVersion: input.dataset_version } } },
    include: { run: { select: { biAnswer: { select: { content: true } } } } } });
  if (!result || result.collected !== result.total || !result.run.biAnswer
      || !biAgentAnswerSchema.parse(result.run.biAnswer.content).evidence_ids.includes(result.id)) throw invalid();
  const dimension = z.object({ dimension: z.string() }).parse(result.query).dimension;
  if (!isEntityDimension(dimension) || source.positions.some((p) => p > result.total)) throw invalid();

  const field = entityFields[dimension], positions = new Set(source.positions);
  const entities: { key: string; name: string }[] = [];
  // Validate all chunks in order, retaining only the requested objects in memory.
  const chunkCount = Math.ceil(result.total / 100);
  if (await tx.biAgentResultPage.count({ where: { resultId: result.id } }) !== chunkCount) throw invalid();
  for (let first = 1; first <= chunkCount; first += 10) {
    const pages = await tx.biAgentResultPage.findMany({ where: { resultId: result.id,
      page: { gte: first, lt: first + 10 } }, orderBy: { page: 'asc' } });
    if (pages.length !== Math.min(10, chunkCount - first + 1)) throw invalid();
    for (const [i, chunk] of pages.entries()) {
      const offset = (chunk.page - 1) * 100;
      if (chunk.page !== first + i || !Array.isArray(chunk.rows)
          || chunk.rows.length !== Math.min(100, result.total - offset)
          || hashPiAgentProvenance(chunk.rows) !== chunk.digest) throw invalid();
      for (const [index, row] of chunk.rows.entries()) {
        if (!positions.has(offset + index + 1)) continue;
        const { key, name } = ledgerRowSchema.parse(row);
        if (key === '__unattributed__') throw invalid();
        if (!page[field].length || page[field].includes(key)) entities.push({ key, name });
      }
    }
  }
  if (!entities.length) throw new BiAgentProblem('BI_AGENT_CONFLICT', 409,
    '所选对象都在当前页面的筛选范围之外，请调整筛选或重新选择。');
  return { page: biAgentPageScopeSchema.parse({ ...page, [field]: entities.map((e) => e.key) }),
    selection: { ...source, dimension, entities } };
}
