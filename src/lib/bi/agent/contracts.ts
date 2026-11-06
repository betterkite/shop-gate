// Browser-safe request boundary; actor/session/SQL/tool configuration are never inputs.
import { z } from 'zod';
import { DEEPSEEK_MODEL_ID, LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID } from '@/lib/constants/models';

export const biAgentIdentifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const identifiers = z.array(biAgentIdentifier).max(100).default([])
  .transform((values) => [...new Set(values)].sort());
const text = (max: number) => z.string().max(max).refine((value) => !value.includes('\0') && value.isWellFormed());
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const biAgentPageScopeSchema = z.object({
  module: z.enum(['overview', 'channels', 'stores', 'products', 'profit', 'refunds', 'reports', 'costs']),
  start: date.optional(), end: date.optional(),
  refund_basis: z.enum(['payment', 'occurred']).default('payment'),
  channel_ids: identifiers, store_ids: identifiers, product_ids: identifiers,
  sku_ids: identifiers, listing_ids: identifiers,
  category: text(200).optional(), search: text(200).default(''),
}).strict().refine((scope) => !scope.start || !scope.end || scope.start <= scope.end)
  // Leave room for JSONB whitespace under the database's 16KiB contract.
  .refine((scope) => new TextEncoder().encode(JSON.stringify(scope)).byteLength <= 14_000);
export const biAgentSubmissionSchema = z.object({
  workspace_id: biAgentIdentifier.optional(), dataset_id: biAgentIdentifier,
  dataset_version: z.number().int().positive().max(2_147_483_647),
  conversation_id: z.string().uuid(), expected_conversation_version: z.number().int().min(0).max(2_147_483_646),
  idempotency_key: biAgentIdentifier,
  instruction: z.string().trim().min(1).max(8000).refine((value) => !value.includes('\0') && value.isWellFormed()),
  model: z.enum([DEEPSEEK_MODEL_ID, LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID]),
  page_scope: biAgentPageScopeSchema,
}).strict();
export type BiAgentPageScope = z.infer<typeof biAgentPageScopeSchema>;
export type BiAgentSubmission = z.infer<typeof biAgentSubmissionSchema>;

export class BiAgentProblem extends Error {
  constructor(readonly code: 'BI_AGENT_CONFLICT' | 'BI_AGENT_NOT_FOUND' | 'BI_AGENT_BUSY'
    | 'BI_AGENT_MODEL_UNAVAILABLE' | 'BI_AGENT_INPUT_INVALID' | 'BI_AGENT_CANCELLED',
  readonly status: number, message: string) { super(message); }
}
