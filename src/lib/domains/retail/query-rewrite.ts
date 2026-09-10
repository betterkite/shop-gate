import { extractExplicitEntityRefs } from '@/lib/domains/retail/entity-aliases';
import { getProjectLlmConfig } from '@/lib/config/llm';

export const RETAIL_QUERY_REWRITE_SCHEMA_VERSION = 4 as const;

export type RetailQueryRewriteStatus =
  | 'ready'
  | 'partial'
  | 'needs_clarification'
  | 'refused';

export interface RetailQueryRewriteSafety {
  decision: 'allow' | 'refuse';
  code: 'GUARANTEED_SALES_REQUEST' | null;
  message: string | null;
}

export type RetailQueryFocusId =
  | 'comprehensive'
  | 'funnel'
  | 'catalog'
  | 'price_inventory'
  | 'daily_brief'
  | 'comparison';

export interface RetailQueryTimeRange {
  label: string;
  value?: number;
  unit:
    | 'day'
    | 'week'
    | 'month'
    | 'quarter'
    | 'year'
    | 'date_range'
    | 'data_window';
  source: 'explicit';
}

export type RetailQueryRewriteLlmTrigger = 'primary';

export type RetailQueryRewriteLlmStatus =
  | 'not_applicable'
  | 'applied'
  | 'skipped_unconfigured'
  | 'invalid_output'
  | 'timed_out'
  | 'failed';

export interface RetailQueryRewriteExecution {
  strategy: 'llm_primary' | 'llm_unavailable' | 'safety_refusal';
  llm: {
    attempted: boolean;
    applied: boolean;
    trigger: RetailQueryRewriteLlmTrigger | null;
    status: RetailQueryRewriteLlmStatus;
    provider: string | null;
    model: string | null;
    durationMs: number | null;
    semanticConfidence: number | null;
    guardedFields: string[];
    errorCode: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
  };
}

export interface RetailQueryFocus {
  id: RetailQueryFocusId;
  label: string;
}

export interface RetailResolvedEntity {
  query: string;
  kind: 'category' | 'item';
  id: number;
  name: string;
  /** 命中实体的合成口径字段披露（如价格）。 */
  syntheticFields: string[];
  source: string | null;
  confidence: number;
}

export interface RetailAmbiguousTarget {
  query: string;
  candidates: RetailResolvedEntity[];
}

export type RetailQueryRewriteIssueCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'ENTITY_RESOLVER_UNAVAILABLE'
  | 'QUERY_REWRITE_LLM_UNAVAILABLE'
  | 'GUARANTEED_SALES_REQUEST';

export interface RetailQueryRewriteIssue {
  code: RetailQueryRewriteIssueCode;
  message: string;
  target?: string;
  retryable: boolean;
}

export interface RetailQueryRewriteResult {
  schemaVersion: typeof RETAIL_QUERY_REWRITE_SCHEMA_VERSION;
  originalQuery: string;
  normalizedQuery: string;
  rewrittenQuery: string;
  status: RetailQueryRewriteStatus;
  confidence: number;
  capabilityHint: string;
  targetCandidates: string[];
  resolvedEntities: RetailResolvedEntity[];
  unresolvedTargets: string[];
  ambiguousTargets: RetailAmbiguousTarget[];
  timeRange: RetailQueryTimeRange | null;
  analysisFocus: RetailQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  /** 全库口径：数据窗口内全部类目/商品（不特指某实体）。 */
  broadUniverse: boolean;
  safety: RetailQueryRewriteSafety;
  issues: RetailQueryRewriteIssue[];
  execution: RetailQueryRewriteExecution;
}

type JsonRecord = Record<string, unknown>;

export type RetailEntityResolver = (
  query: string,
  count: number,
) => Promise<unknown>;

export interface RetailQuerySemanticDraft {
  targetCandidates: string[];
  timeRange: RetailQueryTimeRange | null;
  analysisFocus: RetailQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
}

export interface RetailQueryLlmSemantics {
  targetCandidates: string[];
  timeRange: (Omit<RetailQueryTimeRange, 'source' | 'value'> & {
    value?: number | null;
    evidence: string;
  }) | null;
  analysisFocusId: RetailQueryFocusId;
  outputIntent: 'dashboard' | 'answer';
  /** 明确要求只回答不出图的查询原文字面摘录。 */
  answerOnlyEvidence: string | null;
  broadUniverse: boolean;
  /** 明确指定全库/整体口径的查询原文字面摘录。 */
  broadUniverseEvidence: string | null;
  confidence: number;
}

export interface RetailQuerySemanticRewriteInput {
  originalQuery: string;
  normalizedQuery: string;
  trigger: RetailQueryRewriteLlmTrigger;
  requestedModel?: string | null;
  projectId?: string;
  signal: AbortSignal;
}

export type RetailQuerySemanticRewriteOutcome =
  | {
      ok: true;
      data: RetailQueryLlmSemantics;
      provider: string;
      model: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | {
      ok: false;
      code: string;
      provider?: string;
      model?: string;
      status?: number;
      retryable: boolean;
      /** 仅用于修复后续 LLM 工具调用的有界、无载荷反馈。 */
      repairInstruction?: string;
    };

export type RetailQuerySemanticRewriter = (
  input: RetailQuerySemanticRewriteInput,
) => Promise<RetailQuerySemanticRewriteOutcome>;

export interface RewriteRetailQueryOptions {
  requestedCapabilityId?: string | null;
  resolver?: RetailEntityResolver;
  maxTargets?: number;
  llmTimeoutMs?: number;
  requestedModel?: string | null;
  semanticRewriter?: RetailQuerySemanticRewriter;
  projectId?: string;
}

const EXPLICIT_REF_PATTERN = /^(?:item|cat):\d+$/;
const GUARANTEED_SALES_PATTERN =
  /(?:(?:一定|保证|确保|必然|百分之百|100%)\s*(?:能|会|可以)?\s*(?:卖爆|成为爆款|爆款|翻倍|卖完|清空)|(?:稳赚|包爆|必爆|必成爆款|稳卖爆))/iu;
const GUARANTEED_SALES_REQUEST_PATTERN =
  /(?:推荐|选|哪个|哪些|商品|类目|预测|告诉我|补货|进货|上架)/iu;

const FOCUS_LABELS: Record<RetailQueryFocusId, string> = {
  comprehensive: '综合经营诊断',
  funnel: '流量与转化漏斗',
  catalog: '类目与商品结构',
  price_inventory: '价格与库存',
  daily_brief: '经营日报',
  comparison: '类目/商品对比',
};

const VALID_TIME_RANGE_UNITS = new Set<RetailQueryTimeRange['unit']>([
  'day',
  'week',
  'month',
  'quarter',
  'year',
  'date_range',
  'data_window',
]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEntityText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .toLocaleLowerCase();
}

export function normalizeRetailQuery(query: string): string {
  return query
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripConversationalEntityReferenceSuffix(value: string): string {
  let candidate = value.trim();
  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate
      .replace(/(?:(?:这|那)(?:个|款|只|类)?|该(?:款|只|类)?)(?:商品|类目|单品|SKU)?$/u, '')
      .replace(/(?:商品|类目|单品)$/u, '')
      .trim();
  }
  return candidate;
}

function capabilityHintForFocus(focus: RetailQueryFocusId): string {
  if (focus === 'price_inventory') return 'price_inventory';
  if (focus === 'daily_brief') return 'daily_brief';
  if (focus === 'catalog') return 'catalog_structure';
  if (focus === 'comparison') return 'catalog_structure';
  if (focus === 'funnel') return 'traffic_funnel';
  return 'traffic_funnel';
}

function configuredLlmTimeoutMs(value?: number, requestedModel?: string | null): number {
  const configured = value ?? getProjectLlmConfig(requestedModel).queryRewrite.timeoutMs;
  return Number.isSafeInteger(configured) && configured >= 500 && configured <= 15_000
    ? configured
    : 4_000;
}

function querySafety(query: string): RetailQueryRewriteSafety {
  if (
    GUARANTEED_SALES_PATTERN.test(query) &&
    GUARANTEED_SALES_REQUEST_PATTERN.test(query)
  ) {
    return {
      decision: 'refuse',
      code: 'GUARANTEED_SALES_REQUEST',
      message: '无法保证某个商品/类目一定卖爆、翻倍或清空。可以改为基于真实数据给出结构分析，并明确依据、口径和不确定性。',
    };
  }
  return { decision: 'allow', code: null, message: null };
}

function scoreResolverRow(query: string, row: JsonRecord): number {
  const kind = (stringValue(row.kind) ?? '').toLocaleLowerCase();
  const id = row.id;
  const name = stringValue(row.name) ?? '';
  const confidence = typeof row.confidence === 'number' ? row.confidence : 0;
  const normalizedQuery = normalizeEntityText(query);
  const normalizedName = normalizeEntityText(name);
  let score = confidence * 100;
  if (EXPLICIT_REF_PATTERN.test(query)) {
    const refId = Number.parseInt(query.split(':', 2)[1] ?? '', 10);
    if (id === refId) score += 120;
  }
  if (normalizedName === normalizedQuery) score += 100;
  else if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) {
    score += 55;
  }
  if (kind === 'category') score += 12;
  return score;
}

function toResolvedEntity(query: string, row: JsonRecord, score: number): RetailResolvedEntity | null {
  const kind = stringValue(row.kind);
  const id = row.id;
  const name = stringValue(row.name);
  if ((kind !== 'category' && kind !== 'item') || typeof id !== 'number' || !name) return null;
  const syntheticFields: string[] = [];
  if (row.synthetic_master === true) syntheticFields.push('price');
  if (kind === 'category') syntheticFields.push('category_name');
  return {
    query,
    kind,
    id,
    name,
    syntheticFields,
    source: stringValue(row.source),
    confidence: Math.min(0.99, Math.max(0.55, score / 145)),
  };
}

export function rankRetailEntityCandidates(
  query: string,
  payload: unknown,
): { selected: RetailResolvedEntity | null; ambiguous: RetailResolvedEntity[] } {
  const record = asRecord(payload);
  const rows = Array.isArray(record?.matches)
    ? record.matches.map(asRecord).filter((row): row is JsonRecord => Boolean(row))
    : [];
  const ranked = rows
    .map((row) => ({ row, score: scoreResolverRow(query, row) }))
    .map(({ row, score }) => ({ resolved: toResolvedEntity(query, row, score), score }))
    .filter((item): item is { resolved: RetailResolvedEntity; score: number } => Boolean(item.resolved))
    .sort((left, right) => right.score - left.score || left.resolved.id - right.resolved.id);

  if (ranked.length === 0) return { selected: null, ambiguous: [] };
  const topScore = ranked[0].score;
  const top = ranked.filter((item) => item.score === topScore).map((item) => item.resolved);
  // 零售语义（对上游规则的收紧）：类目/商品名是“家居类目02”这类合成映射，
  // 子串匹配经常并列命中多个实体——并列即歧义，交给澄清，不自动选第一个。
  if (top.length > 1) return { selected: null, ambiguous: top.slice(0, 5) };
  return { selected: ranked[0].resolved, ambiguous: [] };
}

async function defaultEntityResolver(query: string, count: number): Promise<unknown> {
  const baseUrl = (process.env.SHOPGATE_MARKET_API_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
  const url = new URL('/api/v1/commerce/resolve', baseUrl);
  url.searchParams.set('term', query);
  url.searchParams.set('limit', String(count));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`entity resolver returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

interface ResolvedTargetSet {
  resolvedEntities: RetailResolvedEntity[];
  unresolvedTargets: string[];
  ambiguousTargets: RetailAmbiguousTarget[];
  issues: RetailQueryRewriteIssue[];
}

function normalizeResolvedIdentity(value: string): string {
  return normalizeEntityText(value).replace(/[^\p{Script=Han}A-Z\d]/gu, '');
}

function targetIsCoveredByResolvedEntity(
  target: string,
  resolvedEntities: RetailResolvedEntity[],
): boolean {
  const normalizedTarget = normalizeResolvedIdentity(target);
  if (!normalizedTarget) return false;

  return resolvedEntities.some((resolved) => {
    const normalizedId = normalizeResolvedIdentity(
      `${resolved.kind === 'item' ? 'item' : 'cat'}:${resolved.id}`,
    );
    const normalizedName = normalizeResolvedIdentity(resolved.name);
    if (
      normalizedTarget === normalizedId ||
      normalizedTarget === normalizedName
    ) {
      return true;
    }

    // LLM 常会同时保留显式引用与其相邻展示名（例如 "item:1000329 品牌148"）。
    // 引用解析成功后，规范名的足够长子串就是同一实体，不是第二个缺失对象。
    // 保留短的通用词（如“商品”）不解析，避免掩盖真实歧义。
    return normalizedTarget.length >= 4 && normalizedName.includes(normalizedTarget);
  });
}

async function resolveTargetSet(params: {
  targetCandidates: string[];
  resolver: RetailEntityResolver;
}): Promise<ResolvedTargetSet> {
  const resolvedEntities: RetailResolvedEntity[] = [];
  const unresolvedTargets: string[] = [];
  const ambiguousTargets: RetailAmbiguousTarget[] = [];
  const issues: RetailQueryRewriteIssue[] = [];

  await Promise.all(params.targetCandidates.map(async (target) => {
    try {
      const payload = await params.resolver(target, 5);
      const ranked = rankRetailEntityCandidates(target, payload);
      if (ranked.selected) {
        resolvedEntities.push(ranked.selected);
      } else if (ranked.ambiguous.length > 0) {
        ambiguousTargets.push({ query: target, candidates: ranked.ambiguous });
        issues.push({
          code: 'TARGET_AMBIGUOUS',
          message: `“${target}”存在多个同优先级的类目/商品候选，需要确认。`,
          target,
          retryable: false,
        });
      } else {
        unresolvedTargets.push(target);
        issues.push({
          code: 'TARGET_NOT_FOUND',
          message: `未找到与“${target}”匹配的类目或商品。`,
          target,
          retryable: false,
        });
      }
    } catch (error) {
      unresolvedTargets.push(target);
      issues.push({
        code: 'ENTITY_RESOLVER_UNAVAILABLE',
        message: `实体解析服务暂不可用：${error instanceof Error ? error.message : String(error)}`,
        target,
        retryable: true,
      });
    }
  }));

  resolvedEntities.sort(
    (left, right) =>
      params.targetCandidates.indexOf(left.query) - params.targetCandidates.indexOf(right.query),
  );
  const uniqueResolved = resolvedEntities.filter(
    (item, index, items) =>
      items.findIndex(
        (candidate) => candidate.kind === item.kind && candidate.id === item.id,
      ) === index,
  );
  const effectiveUnresolvedTargets = unresolvedTargets.filter(
    (target) => !targetIsCoveredByResolvedEntity(target, uniqueResolved),
  );
  const effectiveAmbiguousTargets = ambiguousTargets.filter(
    (target) => !targetIsCoveredByResolvedEntity(target.query, uniqueResolved),
  );
  const effectiveIssues = issues.filter(
    (issue) => !issue.target || !targetIsCoveredByResolvedEntity(issue.target, uniqueResolved),
  );
  effectiveUnresolvedTargets.sort(
    (left, right) => params.targetCandidates.indexOf(left) - params.targetCandidates.indexOf(right),
  );
  effectiveAmbiguousTargets.sort(
    (left, right) =>
      params.targetCandidates.indexOf(left.query) - params.targetCandidates.indexOf(right.query),
  );
  effectiveIssues.sort((left, right) =>
    params.targetCandidates.indexOf(left.target ?? '') -
    params.targetCandidates.indexOf(right.target ?? ''),
  );

  return {
    resolvedEntities: uniqueResolved,
    unresolvedTargets: effectiveUnresolvedTargets,
    ambiguousTargets: effectiveAmbiguousTargets,
    issues: effectiveIssues,
  };
}

function defaultLlmExecution(status: RetailQueryRewriteLlmStatus): RetailQueryRewriteExecution['llm'] {
  return {
    attempted: false,
    applied: false,
    trigger: null,
    status,
    provider: null,
    model: null,
    durationMs: null,
    semanticConfidence: null,
    guardedFields: [],
    errorCode: null,
    usage: null,
  };
}

function safeLlmTargetCandidates(query: string, candidates: unknown, maxTargets: number): string[] {
  if (!Array.isArray(candidates)) return [];
  const normalizedQuery = normalizeEntityText(query);
  const explicitRefs = extractExplicitEntityRefs(query)
    .map((ref) => `${ref.kind === 'item' ? 'item' : 'cat'}:${ref.id}`);
  return Array.from(new Set(candidates
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.normalize('NFKC').trim().replace(/\s+/g, ''))
    .filter((candidate) => candidate.length > 0 && candidate.length <= 24)
    .filter((candidate) => /[\p{Script=Han}A-Za-z\d:]/u.test(candidate))
    .filter((candidate) => {
      if (EXPLICIT_REF_PATTERN.test(candidate)) {
        return explicitRefs.includes(candidate);
      }
      return normalizedQuery.includes(normalizeEntityText(candidate));
    })))
    .sort((left, right) => query.indexOf(left) - query.indexOf(right))
    .slice(0, maxTargets);
}

function literalEvidence(query: string, value: unknown, maxLength: number): string | null {
  const evidence = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  return evidence && evidence.length <= maxLength && query.includes(evidence) ? evidence : null;
}

function normalizeLlmTimeRange(
  query: string,
  value: RetailQueryLlmSemantics['timeRange'],
): RetailQueryTimeRange | null {
  if (!value || !literalEvidence(query, value.evidence, 160)) return null;
  const label = typeof value.label === 'string' ? value.label.normalize('NFKC').trim() : '';
  const unit = value.unit;
  const rawValue = value.value;
  if (!label || label.length > 64 || !VALID_TIME_RANGE_UNITS.has(unit)) return null;
  if (
    rawValue !== undefined &&
    rawValue !== null &&
    (!Number.isSafeInteger(rawValue) || rawValue <= 0 || rawValue > 5_000)
  ) {
    return null;
  }
  return {
    label,
    ...(typeof rawValue === 'number' ? { value: rawValue } : {}),
    unit,
    source: 'explicit',
  };
}

function mergeLlmSemantics(params: {
  query: string;
  llm: RetailQueryLlmSemantics;
  maxTargets: number;
}): { draft: RetailQuerySemanticDraft; guardedFields: string[] } | null {
  const safeTargets = safeLlmTargetCandidates(
    params.query,
    params.llm.targetCandidates,
    params.maxTargets,
  );
  if (params.llm.targetCandidates.length > 0 && safeTargets.length === 0) return null;
  const focusId = params.llm.analysisFocusId;
  if (!(focusId in FOCUS_LABELS)) return null;
  if (
    params.llm.outputIntent !== 'dashboard' &&
    params.llm.outputIntent !== 'answer'
  ) {
    return null;
  }
  const answerOnlyEvidence = typeof params.llm.answerOnlyEvidence === 'string'
    ? literalEvidence(params.query, params.llm.answerOnlyEvidence, 160)
    : null;
  const validAnswerOnlyEvidence = Boolean(answerOnlyEvidence);
  const outputIntent = params.llm.outputIntent === 'answer' && validAnswerOnlyEvidence
    ? 'answer'
    : 'dashboard';
  const guardedFields = outputIntent !== params.llm.outputIntent ||
      (params.llm.outputIntent === 'dashboard' && Boolean(answerOnlyEvidence))
    ? ['outputIntent']
    : [];
  if (
    typeof params.llm.confidence !== 'number' ||
    !Number.isFinite(params.llm.confidence) ||
    params.llm.confidence < 0 ||
    params.llm.confidence > 1
  ) {
    return null;
  }
  const timeRange = normalizeLlmTimeRange(params.query, params.llm.timeRange);
  if (params.llm.timeRange && !timeRange) return null;
  const broadUniverseEvidence = literalEvidence(
    params.query,
    params.llm.broadUniverseEvidence,
    160,
  );
  if (params.llm.broadUniverse && !broadUniverseEvidence) return null;

  return {
    draft: {
      targetCandidates: safeTargets,
      timeRange,
      analysisFocus: { id: focusId, label: FOCUS_LABELS[focusId] },
      outputIntent,
      broadUniverse: params.llm.broadUniverse,
    },
    guardedFields,
  };
}

async function defaultSemanticRewriter(
  input: RetailQuerySemanticRewriteInput,
): Promise<RetailQuerySemanticRewriteOutcome> {
  const llmAdapter = await import('@/lib/domains/retail/query-rewrite-llm');
  return llmAdapter.rewriteRetailQuerySemanticsWithConfiguredProvider(input);
}

async function runLlmSemanticRewrite(params: {
  input: Omit<RetailQuerySemanticRewriteInput, 'signal'>;
  rewriter: RetailQuerySemanticRewriter;
  timeoutMs: number;
}): Promise<{
  outcome: RetailQuerySemanticRewriteOutcome;
  durationMs: number;
  timedOut: boolean;
}> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<RetailQuerySemanticRewriteOutcome>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort(new DOMException('Query Rewrite LLM timed out.', 'TimeoutError'));
        resolve({ ok: false, code: 'LLM_TIMEOUT', retryable: true });
      }, params.timeoutMs);
      timeoutId.unref?.();
    });
    const outcome = await Promise.race([
      params.rewriter({ ...params.input, signal: controller.signal }),
      timeout,
    ]);
    return {
      outcome,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timedOut: !outcome.ok && outcome.code === 'LLM_TIMEOUT',
    };
  } catch {
    return {
      outcome: { ok: false, code: 'LLM_REWRITE_FAILED', retryable: true },
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timedOut: false,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function rewrittenQueryText(params: {
  targets: string[];
  timeRange: RetailQueryTimeRange | null;
  focus: RetailQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
}): string {
  const targetText = params.targets.length > 0
    ? params.targets.join('、')
    : params.broadUniverse
      ? '数据窗口内全库口径'
      : '待确认类目/商品';
  return [
    `分析对象：${targetText}`,
    `分析重点：${params.focus.label}`,
    `时间范围：${params.timeRange?.label ?? '使用数据窗口内最近 9 天'}`,
    `输出方式：${params.outputIntent === 'dashboard' ? '生成可验证看板' : '只做分析问答'}`,
  ].join('；');
}

function normalizeLlmFailureCode(
  outcome: Extract<RetailQuerySemanticRewriteOutcome, { ok: false }>,
): string {
  if (outcome.code === 'LLM_HTTP_ERROR' && (outcome.status === 401 || outcome.status === 403)) {
    return 'LLM_AUTH_FAILED';
  }
  if (outcome.code === 'LLM_HTTP_ERROR' && outcome.status === 404) {
    return 'LLM_MODEL_NOT_FOUND';
  }
  return outcome.code;
}

function llmUnavailableMessage(
  errorCode: string | null,
  provider: string | null,
  model: string | null,
): string {
  if (errorCode === 'LLM_AUTH_FAILED') {
    return `${provider ?? 'LLM'} 凭据无效或已失效（${model ?? '当前模型'}），任务已暂停；请更新模型凭据后重试。`;
  }
  if (errorCode === 'LLM_MODEL_NOT_FOUND') {
    return `${provider ?? 'LLM'} 当前模型不可用（${model ?? '未指定模型'}），任务已暂停；请更换可用模型后重试。`;
  }
  return 'Query Rewrite 大模型暂时不可用或返回了无效结果，任务已暂停；请稍后重试。';
}

const WHOLE_CATALOG_SCOPE_PATTERN =
  /数据窗口内|窗口内|全库|全量|整体|大盘|总体|全店|商品池|全部类目|所有商品|各类目|各价格带/;
const VAGUE_DISCOVERY_PATTERN =
  /(?:有哪些|有什么).{0,12}(?:商品|类目).{0,12}(?:值得关注|推荐|重点)/;

function shouldInferBroadUniverse(params: {
  query: string;
  targetCandidates: string[];
  focusId: RetailQueryFocusId;
}): boolean {
  if (params.targetCandidates.length > 0 || VAGUE_DISCOVERY_PATTERN.test(params.query)) {
    return false;
  }

  // The four retail capabilities are executable over the platform-wide data
  // window when the user explicitly names that scope. DeepSeek occasionally
  // omits broadUniverse for phrases such as “窗口内各价格带”; recover only
  // this bounded, literal scope instead of falling back to keyword guessing.
  return (
    params.focusId === 'funnel' ||
    params.focusId === 'catalog' ||
    params.focusId === 'price_inventory' ||
    params.focusId === 'daily_brief'
  ) && WHOLE_CATALOG_SCOPE_PATTERN.test(params.query);
}

export async function rewriteRetailQuery(
  query: string,
  options: RewriteRetailQueryOptions = {},
): Promise<RetailQueryRewriteResult> {
  const originalQuery = query;
  const normalizedQuery = normalizeRetailQuery(query);
  const maxTargets = Math.min(8, Math.max(1, options.maxTargets ?? 8));
  const neutralFocus: RetailQueryFocus = { id: 'comprehensive', label: FOCUS_LABELS.comprehensive };
  const safety = querySafety(normalizedQuery);
  if (safety.decision === 'refuse') {
    return {
      schemaVersion: RETAIL_QUERY_REWRITE_SCHEMA_VERSION,
      originalQuery,
      normalizedQuery,
      rewrittenQuery: safety.message ?? '请求不在可执行范围内。',
      status: 'refused',
      confidence: 0.99,
      capabilityHint: options.requestedCapabilityId ?? 'traffic_funnel',
      targetCandidates: [],
      resolvedEntities: [],
      unresolvedTargets: [],
      ambiguousTargets: [],
      timeRange: null,
      analysisFocus: neutralFocus,
      outputIntent: 'answer',
      broadUniverse: false,
      safety,
      issues: [{
        code: 'GUARANTEED_SALES_REQUEST',
        message: safety.message ?? '不支持确定性销量承诺。',
        retryable: false,
      }],
      execution: {
        strategy: 'safety_refusal',
        llm: defaultLlmExecution('not_applicable'),
      },
    };
  }

  const semanticRewriter = options.semanticRewriter ?? defaultSemanticRewriter;
  const llmResult = await runLlmSemanticRewrite({
    input: {
      originalQuery,
      normalizedQuery,
      trigger: 'primary',
      requestedModel: options.requestedModel,
      projectId: options.projectId,
    },
    rewriter: semanticRewriter,
    timeoutMs: configuredLlmTimeoutMs(options.llmTimeoutMs, options.requestedModel),
  });
  const llmExecution: RetailQueryRewriteExecution['llm'] = {
    ...defaultLlmExecution('failed'),
    attempted: true,
    trigger: 'primary' as const,
    durationMs: llmResult.durationMs,
  };

  let semanticDraft: RetailQuerySemanticDraft | null = null;
  let llmRetryable = true;
  if (!llmResult.outcome.ok) {
    llmExecution.provider = llmResult.outcome.provider ?? null;
    llmExecution.model = llmResult.outcome.model ?? null;
    llmExecution.errorCode = normalizeLlmFailureCode(llmResult.outcome);
    llmExecution.status = llmResult.timedOut
      ? 'timed_out'
      : llmResult.outcome.code === 'LLM_NOT_CONFIGURED'
        ? 'skipped_unconfigured'
        : llmResult.outcome.code === 'LLM_INVALID_OUTPUT'
          ? 'invalid_output'
          : 'failed';
    llmRetryable = llmResult.outcome.retryable;
  } else {
    const merged = mergeLlmSemantics({
      query: normalizedQuery,
      llm: llmResult.outcome.data,
      maxTargets,
    });
    llmExecution.provider = llmResult.outcome.provider;
    llmExecution.model = llmResult.outcome.model;
    llmExecution.semanticConfidence = llmResult.outcome.data.confidence;
    llmExecution.usage = llmResult.outcome.usage ?? null;
    if (merged) {
      const inferredBroadUniverse = shouldInferBroadUniverse({
        query: normalizedQuery,
        targetCandidates: merged.draft.targetCandidates,
        focusId: merged.draft.analysisFocus.id,
      });
      semanticDraft = inferredBroadUniverse
        ? { ...merged.draft, broadUniverse: true }
        : merged.draft;
      llmExecution.guardedFields = merged.guardedFields;
      if (inferredBroadUniverse) {
        llmExecution.guardedFields = [...llmExecution.guardedFields, 'broadUniverse'];
      }
      llmExecution.applied = true;
      llmExecution.status = 'applied';
      llmExecution.errorCode = null;
    } else {
      llmExecution.status = 'invalid_output';
      llmExecution.errorCode = 'LLM_INVALID_OUTPUT';
      llmRetryable = true;
    }
  }

  if (!semanticDraft) {
    const unavailableMessage = llmExecution.status === 'skipped_unconfigured'
      ? 'Query Rewrite 大模型未配置，任务已暂停；请配置可用模型后重试。'
      : llmUnavailableMessage(llmExecution.errorCode, llmExecution.provider, llmExecution.model);
    return {
      schemaVersion: RETAIL_QUERY_REWRITE_SCHEMA_VERSION,
      originalQuery,
      normalizedQuery,
      rewrittenQuery: unavailableMessage,
      status: 'needs_clarification',
      confidence: 0,
      capabilityHint: options.requestedCapabilityId ?? 'traffic_funnel',
      targetCandidates: [],
      resolvedEntities: [],
      unresolvedTargets: [],
      ambiguousTargets: [],
      timeRange: null,
      analysisFocus: neutralFocus,
      outputIntent: 'dashboard',
      broadUniverse: false,
      safety,
      issues: [{
        code: 'QUERY_REWRITE_LLM_UNAVAILABLE',
        message: unavailableMessage,
        retryable: llmRetryable,
      }],
      execution: {
        strategy: 'llm_unavailable',
        llm: llmExecution,
      },
    };
  }

  const targetCandidates = semanticDraft.targetCandidates.slice(0, maxTargets);
  const resolvedTargetSet = await resolveTargetSet({
    targetCandidates,
    resolver: options.resolver ?? defaultEntityResolver,
  });

  const {
    resolvedEntities,
    unresolvedTargets,
    ambiguousTargets,
    issues,
  } = resolvedTargetSet;
  const canonicalTargets = resolvedEntities.map((item) =>
    item.kind === 'item'
      ? `${item.name}（item:${item.id}）`
      : `${item.name}（cat:${item.id}）`,
  );
  const status: RetailQueryRewriteStatus =
    ambiguousTargets.length > 0 ||
    (targetCandidates.length === 0 && !semanticDraft.broadUniverse)
      ? 'needs_clarification'
      : unresolvedTargets.length > 0
        ? resolvedEntities.length > 0 ? 'partial' : 'needs_clarification'
        : 'ready';
  const confidence = status === 'ready'
    ? resolvedEntities.length > 0
      ? Math.min(
          ...resolvedEntities.map((item) => item.confidence),
          llmExecution.semanticConfidence ?? 1,
        )
      : llmExecution.semanticConfidence ?? 0.86
    : status === 'partial' ? 0.68 : 0.45;
  const execution: RetailQueryRewriteExecution = {
    strategy: 'llm_primary',
    llm: llmExecution,
  };

  return {
    schemaVersion: RETAIL_QUERY_REWRITE_SCHEMA_VERSION,
    originalQuery,
    normalizedQuery,
    rewrittenQuery: rewrittenQueryText({
      targets: canonicalTargets.length > 0 ? canonicalTargets : targetCandidates,
      timeRange: semanticDraft.timeRange,
      focus: semanticDraft.analysisFocus,
      outputIntent: semanticDraft.outputIntent,
      broadUniverse: semanticDraft.broadUniverse,
    }),
    status,
    confidence,
    capabilityHint:
      options.requestedCapabilityId ?? capabilityHintForFocus(semanticDraft.analysisFocus.id),
    targetCandidates,
    resolvedEntities,
    unresolvedTargets,
    ambiguousTargets,
    timeRange: semanticDraft.timeRange,
    analysisFocus: semanticDraft.analysisFocus,
    outputIntent: semanticDraft.outputIntent,
    broadUniverse: semanticDraft.broadUniverse,
    safety,
    issues,
    execution,
  };
}
