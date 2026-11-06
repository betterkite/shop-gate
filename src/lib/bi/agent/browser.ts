import { z } from 'zod';
import { biAgentIdentifier, biAgentPageScopeSchema, biAgentSubmissionSchema } from './contracts';
import { biAgentAnswerSchema, biMetric, biDimension } from './result-contracts';
import { ledgerRowSchema } from '../overview-contracts';

const count = z.number().int().nonnegative();
const pagination = { total: count, page: z.number().int().positive(), page_size: z.literal(20) };
const run = z.object({ id: z.string().uuid(), status: z.string(), version: count, createdAt: z.string(),
  finishedAt: z.string().nullable(), cancelRequestedAt: z.string().nullable(), errorCode: z.string().nullable() });
const question = z.object({ id: z.string().uuid(), instruction: z.string(), model: z.string(), datasetVersion: count,
  pageScope: biAgentPageScopeSchema, createdAt: z.string(), runs: z.array(run) });
export const agentAvailabilitySchema = z.object({ workspace_id: biAgentIdentifier, can_run: z.boolean(),
  worker_available: z.boolean(), models: z.array(z.object({ id: biAgentSubmissionSchema.shape.model, name: z.string() })) });
export const agentConversationsSchema = z.object({ ...pagination, workspace_id: biAgentIdentifier, dataset_id: biAgentIdentifier,
  rows: z.array(z.object({ id: z.string().uuid(), title: z.string(), version: count, createdAt: z.string() })) });
export const agentQuestionsSchema = z.object({ ...pagination, rows: z.array(question), conversation: z.object({
  id: z.string().uuid(), title: z.string(), version: count, scope: z.object({ datasetId: biAgentIdentifier, workspaceId: biAgentIdentifier }) }) });
export const agentAcceptedSchema = z.object({ conversation_id: z.string().uuid(), conversation_version: count,
  replayed: z.boolean(), request: question });
export const agentAnswerSchema = z.object({ status: z.string(), dataset_version: count.optional(),
  page_scope: biAgentPageScopeSchema.optional(), answer: biAgentAnswerSchema.nullable() });
export const agentResultSchema = z.object({ ...pagination, evidence_id: z.string().uuid(),
  query: z.object({ dimension: biDimension, metrics: z.array(biMetric) }),
  metadata: z.object({ workspace_id: biAgentIdentifier, dataset_id: biAgentIdentifier, version: count,
    range: z.object({ start: z.string().nullable(), end: z.string().nullable(), refund_basis: z.enum(['payment', 'occurred']) }) }),
  rows: z.array(ledgerRowSchema).max(20) });
export const ACTIVE_AGENT_STATUSES = ['pending', 'running', 'waiting', 'reconciling', 'candidate_complete'];
export const AGENT_STATUS_LABELS: Record<string, string> = { pending: '等待处理', running: '正在分析', waiting: '等待继续',
  reconciling: '正在恢复状态', candidate_complete: '正在核验答案', completed: '分析完成', failed: '分析未完成，请重新提问',
  interrupted: '分析已中断，请重新提问', cancelled: '已取消', budget_exceeded: '已达到本次分析预算，请缩小问题范围' };
export const AGENT_METRIC_LABELS: Record<z.infer<typeof biMetric>, string> = {
  sales_amount: '付款成交金额（元）', refund_amount: '退款金额（元）', net_sales: '净销售额（元）', order_count: '付款订单数（笔）',
  average_order_value: '付款客单价（元/笔）', standard_quantity: '标准规格数量', product_cost: '商品成本（元）',
  expense_amount: '费用（元）', contribution_profit: '经营贡献利润（元）', accounted_contribution: '已核算经营贡献（元）',
  contribution_margin: '经营贡献利润率（%）', refund_ratio: '退款金额占比（%）', accounted_revenue: '已核算收入（元）', coverage_ratio: '核算覆盖比例（%）',
};
export class AgentRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}
export async function readAgent<T>(params: Record<string, string>, schema: z.ZodType<T>, options: RequestInit = {}) {
  const response = await fetch(`/api/bi/assistant?${new URLSearchParams(params)}`, { ...options,
    cache: 'no-store', credentials: 'same-origin', headers: { ...(options.body ? {
      'content-type': 'application/json', 'x-shopgate-request': 'same-origin' } : {}), ...options.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const known = typeof body?.error === 'string' && /^(BI_AGENT_|QUOTA_)/.test(body.error);
    throw new AgentRequestError(known && typeof body.message === 'string' && body.message.length <= 300 ? body.message
      : '经营助手暂不可用，请稍后重试；经营数据页面仍可查看。', response.status, known ? body.error : undefined);
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) throw new Error('分析结果格式不完整，请刷新后重试。');
  return parsed.data;
}
