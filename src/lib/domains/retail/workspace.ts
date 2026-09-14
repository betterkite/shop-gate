import fs from 'fs/promises';
import path from 'path';
import {
  assessRetailIntentForClarification,
  RetailIntentClarification,
} from '@/lib/domains/retail/intent';
import { buildRetailProjectSettings, getExecutionRetailCapability, getRetailCapability } from '@/lib/domains/retail/capabilities';
import {
  rewriteRetailQuery,
  type RetailQueryRewriteResult,
} from '@/lib/domains/retail/query-rewrite';
import {
  projectRetailPlanToDataAgentPlan,
  projectRetailProfileSelection,
  projectRetailRewriteToDataAgentTask,
} from '@/lib/domains/retail/data-agent-projection';
import { serializeRetailVisualizationTemplate } from '@/lib/domains/retail/visualization-templates';
import {
  applyRetailOutputIntent,
  inferRetailOutputIntent,
  matchRetailTemplateCoverage,
  type RetailRequestOutputMode,
  type RetailRouteStatus,
} from '@/lib/domains/retail/template-routing';
import {
  getProjectLlmConfig,
  type ProjectLlmConfig,
} from '@/lib/config/llm';
import type {
  DataAgentCompositionLock,
  DataAgentProfileSelection,
} from '@/lib/data-agent';
import {
  DATA_AGENT_EVENTS_RELATIVE_PATH,
  DATA_AGENT_PLAN_RELATIVE_PATH,
  DATA_AGENT_PROFILE_RELATIVE_PATH,
  DATA_AGENT_ROOT_RELATIVE_PATH,
  DATA_AGENT_TASK_RELATIVE_PATH,
  writeWorkspaceJsonAtomic,
} from '@/lib/data-agent';
import {
  DATA_AGENT_ARTIFACT_CONTRACTS_RELATIVE_PATH,
  DATA_AGENT_VALIDATION_RELATIVE_PATH,
  DATA_AGENT_VISUAL_VALIDATION_RELATIVE_PATH,
} from '@/lib/data-agent/workspace-layout';
import {
  createRetailDataAgentRegistry,
  RETAIL_AGENT_PROFILE_ID,
} from '@/lib/domains/retail/agent-profile';
import {
  RETAIL_QUERY_REWRITE_RELATIVE_PATH,
  RETAIL_RUN_PLAN_RELATIVE_PATH,
} from '@/lib/domains/retail/workspace-artifacts';

type RunPlanStatus = 'pending' | 'planned' | 'needs_clarification' | 'refused';

export type RetailAnalysisDimension = 'item' | 'category' | 'channel' | 'campaign' | 'user';

export interface RetailAnalysisScope {
  dimension: RetailAnalysisDimension;
  value: string;
  source: 'previous-final-data';
}

export interface RetailRunPlan {
  schemaVersion: 1;
  runId: string;
  status: RunPlanStatus;
  /** 面向用户的输出路由；与 generation status 分开，便于审计为何生成或阻断看板。 */
  routeStatus?: RetailRouteStatus;
  routeReason?: string;
  /** 看板模板不覆盖时保留原路由事实，并记录已降级为问答。 */
  fallbackFrom?: 'template_not_supported';
  capabilityId: string;
  composition: DataAgentCompositionLock;
  llm: ProjectLlmConfig;
  requestedCapabilityId?: string;
  executionCapabilityId?: string;
  /** Agent 本轮预取所绑定的数据集；缺省时才允许使用环境默认数据集。 */
  datasetId?: string;
  question: string;
  queryRewrite?: RetailQueryRewriteResult;
  /** 已解析实体的文本形式（item:<id> / cat:<id> / 名称提示）。 */
  entities: string[];
  /** 具体数据窗口；planning 阶段可为 null，由 data_prefetch 以 /meta 精化。 */
  window: { start: string; end: string } | null;
  /**
   * 本轮可审计的分析上下文。它只保存范围指针，不保存模型私有思考或
   * 用户长期偏好，用于多轮追问时稳定继承数据集、实体和时间口径。
   */
  context?: {
    datasetId: string | null;
    entities: string[];
    timeRange: string | null;
    inherited: boolean;
    sourceRunId?: string;
    scope?: RetailAnalysisScope;
    inheritedItemIds?: number[];
  };
  /** 计划实体范围；空数组 = 全库口径。 */
  plannedEntities: { categoryIds: number[]; itemIds: number[] };
  timeRange: string | null;
  dataRequirements: string[];
  analysisSteps: string[];
  visualization: {
    required: boolean;
    templateId?: string;
    name?: string;
    scenario?: string;
    variantId?: string;
    variantName?: string;
    variantScenario?: string;
    layout?: string;
    density?: string;
    firstViewport?: string[];
    variantGuidance?: string[];
    matchReasons?: string[];
    panels: string[];
    painPoints?: string[];
    optionalPanels?: string[];
    dataSignals?: string[];
    coverage?: {
      metrics: string[];
      dimensions: string[];
      outputModes: string[];
    };
    requestedMetrics?: string[];
    requestedDimensions?: string[];
    missingMetrics?: string[];
    missingDimensions?: string[];
    finalDataContract?: string[];
  };
  clarification?: RetailIntentClarification;
  refusal?: {
    code: 'GUARANTEED_SALES_REQUEST';
    message: string;
  };
  expectedArtifacts: string[];
  validationRules: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RetailWorkspaceEvent {
  event_type: string;
  stage: string;
  status: 'pending' | 'success' | 'warning' | 'error';
  summary: string;
  run_id?: string;
  artifact_path?: string;
  created_at?: string;
}

const OPERATIONAL_INSTRUCTION_MARKERS = [
  '图片附件处理要求',
  '可见过程叙述要求',
  '执行过程要求',
  '平台执行要求',
  '生成过程要求',
  '系统附加要求',
  '工作区文件要求',
  '重要执行规则',
  '重要约束',
  'Visible process instructions',
  'Process instructions',
];

function dataAgentDir(projectPath: string) {
  return path.join(projectPath, DATA_AGENT_ROOT_RELATIVE_PATH);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readDataAgentProfile(
  projectPath: string,
): Promise<DataAgentProfileSelection | null> {
  return readJsonFile<DataAgentProfileSelection>(
    path.join(projectPath, DATA_AGENT_PROFILE_RELATIVE_PATH),
  );
}

function stripOperationalInstructions(instruction: string): string {
  let cleaned = instruction.trim();
  for (const marker of OPERATIONAL_INSTRUCTION_MARKERS) {
    const markerIndex = cleaned.indexOf(marker);
    if (markerIndex > 0) {
      cleaned = cleaned.slice(0, markerIndex).trim();
    }
  }

  return cleaned
    .replace(/\n*Image #\d+ path: [^\n]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractExplicitRetailDatasetId(value: string): string | undefined {
  const match = value.match(
    /(?:数据集|dataset(?:[_\s-]?id)?|data\s+set)\s*[:：=]?\s*([A-Za-z0-9][A-Za-z0-9._-]{0,119})/iu,
  );
  return match?.[1];
}

function normalizeForIntent(instruction: string): string {
  return stripOperationalInstructions(instruction).replace(/\s+/g, '');
}

function inferDefaultTimeRange(capabilityId: string): string | null {
  if (
    [
      'traffic_funnel',
      'catalog_structure',
      'price_inventory',
      'daily_brief',
    ].includes(capabilityId)
  ) {
    return '数据窗口内最近 9 天';
  }

  return null;
}

function mergeQueryRewriteClarification(params: {
  base: RetailIntentClarification;
  queryRewrite: RetailQueryRewriteResult;
  capabilityId: string;
  hasImageAttachments?: boolean;
}): RetailIntentClarification {
  if (params.hasImageAttachments || params.queryRewrite.broadUniverse) return params.base;

  const rewriteUnavailable = params.queryRewrite.issues.find(
    (issue) => issue.code === 'QUERY_REWRITE_LLM_UNAVAILABLE',
  );
  if (rewriteUnavailable) {
    return {
      required: true,
      reason: rewriteUnavailable.message,
      missing: [],
      questions: [rewriteUnavailable.message],
      confidence: 0,
      defaults: params.base.defaults,
    };
  }

  const actionableIssues = params.queryRewrite.issues.filter(
    (issue) => issue.code === 'TARGET_NOT_FOUND' || issue.code === 'TARGET_AMBIGUOUS',
  );
  if (actionableIssues.length === 0) return params.base;

  const comparisonAffected =
    params.capabilityId === 'catalog_structure' ||
    params.capabilityId === 'price_inventory' ||
    params.queryRewrite.analysisFocus.id === 'comparison' ||
    params.queryRewrite.resolvedEntities.length > 0;
  const missing = Array.from(new Set([
    ...params.base.missing,
    comparisonAffected ? 'comparison_scope' as const : 'target' as const,
  ]));
  const rewriteQuestions = actionableIssues.map((issue) => {
    if (issue.code === 'TARGET_AMBIGUOUS') {
      const ambiguity = params.queryRewrite.ambiguousTargets.find(
        (item) => item.query === issue.target,
      );
      const candidates = ambiguity?.candidates
        .map((item) => `${item.name}（${item.kind === 'item' ? 'item' : 'cat'}:${item.id}）`)
        .join('、');
      return candidates
        ? `“${issue.target}”对应多个类目/商品：${candidates}。你想分析哪一个？`
        : `“${issue.target}”对应多个类目/商品，请补充名称或 ID。`;
    }
    return `没有找到“${issue.target}”对应的类目/商品，请确认名称或提供 item:/cat: ID。`;
  });

  return {
    required: true,
    reason: actionableIssues.map((issue) => issue.message).join('；'),
    missing,
    questions: Array.from(new Set([...rewriteQuestions, ...params.base.questions])).slice(0, 3),
    confidence: Math.min(params.base.confidence, params.queryRewrite.confidence),
    defaults: params.base.defaults,
  };
}

function isWholeCatalogInstruction(instruction: string): boolean {
  const normalized = instruction.replace(/\s+/g, '');
  return /全库|所有类目|全部类目|整体|全店|商品池|类目结构|大盘|数据窗口/.test(normalized);
}

function hasExplicitInventoryIntent(instruction: string, hasImageAttachments?: boolean): boolean {
  const normalized = normalizeForIntent(instruction);
  const textSignals =
    /库存|库销比|滞销|积压|补货|进货|清仓|下架|价格带|售价|定价|成本价/.test(normalized);
  const imageSignals =
    hasImageAttachments === true && /库存|价格|商品|销售|订单/.test(normalized);

  return textSignals || imageSignals;
}

function uniqueEntityList(entities: unknown): string[] {
  if (!Array.isArray(entities)) {
    return [];
  }
  return Array.from(
    new Set(
      entities
        .map((entity) => (typeof entity === 'string' ? entity.trim() : ''))
        .filter((entity) => /^(?:item|cat):\d+$/.test(entity))
    )
  );
}

function isDashboardRevisionInstruction(instruction: string): boolean {
  const normalized = normalizeForIntent(instruction);
  if (!normalized) {
    return false;
  }

  const revisionSignals =
    /这个|当前|现在|刚才|上一轮|上一版|原页面|结果|看板|页面|图表|方向对|不够贴题|重构|优化|调整|修改|改成|删除|新增|补充|保留|替换|不要|必须|移动端|横向溢出|折线图|热力图|矩阵/.test(
      normalized
    );
  const commandSignals =
    /重构|优化|调整|修改|改成|删除|新增|补充|保留|替换|不要|必须|方向对|不够贴题|移动端|横向溢出|折线图|热力图|矩阵/.test(
      normalized
    );

  return revisionSignals && commandSignals;
}

function isContextualFollowUpInstruction(instruction: string): boolean {
  const normalized = normalizeForIntent(instruction);
  if (!normalized) {
    return false;
  }

  // 只对明确指向上一轮范围的追问继承上下文，避免把新的泛化问题误绑定到旧实体。
  const referenceSignals =
    /这个(?:类目|商品|渠道|活动|用户)?|这些(?:商品|产品)?|它们|该(?:类目|商品|渠道|活动|用户)?|其中|上述|刚才|上一轮|上一条|这里|这个范围/.test(
      normalized
    );
  const followUpSignals =
    /哪个|哪些|谁|为什么|如何|怎么|情况|表现|转化|浏览|加购|收藏|购买|销量|销售|库存|价格|利润|排名|对比|继续|再看|下钻|分析|详情/.test(
      normalized
    );

  return referenceSignals && followUpSignals;
}

function hasExplicitVariantReselection(instruction: string): boolean {
  return /类目|渠道|商品阶段|生命周期|价格|库存|利润|转化|动销|库销比|成交额|折线图|柱状图|漏斗图|散点图|热力图|排名|排序/.test(
    normalizeForIntent(instruction)
  );
}

function shouldInheritPreviousPlanContext(params: {
  instruction: string;
  explicitEntities: string[];
  previousPlan?: RetailRunPlan | null;
  hasImageAttachments?: boolean;
}): boolean {
  const previousEntities = uniqueEntityList(params.previousPlan?.entities);
  const previousWasWholeCatalog = params.previousPlan?.queryRewrite?.broadUniverse === true;
  if (!params.previousPlan || params.previousPlan.status === 'needs_clarification') {
    return false;
  }
  if (params.explicitEntities.length > 0 || (previousEntities.length === 0 && !previousWasWholeCatalog)) {
    return false;
  }
  if (
    !isDashboardRevisionInstruction(params.instruction) &&
    !isContextualFollowUpInstruction(params.instruction)
  ) {
    return false;
  }
  if (
    hasExplicitInventoryIntent(params.instruction, params.hasImageAttachments) &&
    params.previousPlan.capabilityId !== 'price_inventory' &&
    !previousWasWholeCatalog
  ) {
    return false;
  }
  return true;
}

function inferCapabilityId(params: {
  requestedCapabilityId?: string | null;
  requestedCapabilitySource?: string | null;
  profileCapabilityId?: string | null;
  profileCapabilitySource?: string | null;
  queryRewrite: RetailQueryRewriteResult;
  resolvedEntityCount: number;
}) {
  const requestedCapabilityIsAuthoritative =
    params.requestedCapabilitySource === 'manual' ||
    params.requestedCapabilitySource === 'benchmark';

  if (params.requestedCapabilityId && requestedCapabilityIsAuthoritative) {
    // The home-screen default is currently serialized as `manual` even when
    // the user did not explicitly change the research tab. For answer-only
    // requests, a high-confidence semantic inventory focus must win over that
    // default so a question about stock health cannot fall back to funnel.
    if (
      params.queryRewrite.outputIntent === 'answer' &&
      params.queryRewrite.analysisFocus.id === 'price_inventory'
    ) {
      return 'price_inventory';
    }
    return params.requestedCapabilityId;
  }

  // A natural-language focus inferred by Query Rewrite should override the
  // home-screen default tab. Only an explicitly selected/manual capability or
  // benchmark is authoritative enough to suppress this semantic routing.
  if (params.queryRewrite.analysisFocus.id === 'price_inventory') {
    return 'price_inventory';
  }

  if (!params.requestedCapabilityId && params.profileCapabilityId && params.profileCapabilitySource === 'manual') {
    return params.profileCapabilityId;
  }

  if (params.queryRewrite.broadUniverse) {
    return 'catalog_structure';
  }

  if (
    params.queryRewrite.analysisFocus.id === 'comparison' &&
    params.resolvedEntityCount >= 2
  ) {
    return 'catalog_structure';
  }

  if (params.queryRewrite.capabilityHint) {
    return params.queryRewrite.capabilityHint;
  }

  if (params.requestedCapabilityId) {
    return params.requestedCapabilityId;
  }

  if (params.resolvedEntityCount >= 2) {
    return 'catalog_structure';
  }

  return params.profileCapabilityId;
}

function buildAnalysisSteps(
  capabilityId: string,
  hasEntities: boolean,
  instruction: string,
  outputIntent: 'dashboard' | 'answer' = 'dashboard',
): string[] {
  const common = [
    hasEntities
      ? '确认输入类目/商品实体（item:/cat: 或名称经 /resolve 解析）。'
      : '通过 /api/v1/commerce/resolve 解析用户问题中的类目/商品；无法解析时按全库口径或发起澄清。',
    '调用 /api/v1/commerce/meta，确认数据窗口与数据规模可用。',
  ];

  if (outputIntent === 'answer') {
    const answerDataStep = capabilityId === 'price_inventory'
      ? '调用 /api/v1/commerce/inventory-risk 和相关转化接口，按库存、浏览、购买和转化指标整理回答。'
      : '调用当前能力对应的数据接口，按用户问题整理可核验的分析回答。';
    return [
      ...common,
      answerDataStep,
      '明确真实行为数据、合成经营字段和数据窗口边界。',
      '只返回中文分析结论与限制说明，不生成或修改看板。',
    ];
  }

  if (capabilityId === 'catalog_structure') {
    if (!hasEntities && isWholeCatalogInstruction(instruction)) {
      return [
        '按全库口径调用 /api/v1/commerce/categories/top，获取类目 GMV/转化排名。',
        '记录类目覆盖与合成金额口径说明。',
        '计算集中度（top-5 GMV 占比）并挑选动销异常商品。',
        '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
        '生成包含 window、plannedEntities 和 datasets.categories 的最终数据文件。',
        '生成类目结构看板并验证集中度口径、图表、合成标注和更新时间。',
      ];
    }
    return [
      ...common,
      '解析输入类目/商品实体，调用 categories/top 与 items/daily 获取真实数据。',
      '计算类目 GMV/转化/客单价与集中度口径。',
      '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成包含 datasets.categories 的最终数据文件。',
      '生成类目结构看板并验证覆盖率、图表、合成标注和更新时间。',
    ];
  }

  if (capabilityId === 'price_inventory') {
    return [
      ...common,
      '调用 /api/v1/commerce/inventory-risk 获取库销比排行与价格/库存（合成口径）。',
      '调用 /api/v1/commerce/funnel/daily、/api/v1/commerce/categories/top、/api/v1/commerce/channels 和 /api/v1/commerce/items 获取 BI 总览、趋势与拆解数据。',
      '生成真实行为指标与合成经营指标的边界说明，并识别高流量低转化、滞销和库存金额风险。',
      '标注零销量商品与库销比地板值口径。',
      '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成包含 datasets.biOverview、datasets.channels、datasets.itemPool 和 datasets.inventoryRisk 的最终数据文件。',
      '生成 BI 级价格库存看板并验证 KPI、趋势、异常、拆解、行动、合成徽标和更新时间。',
    ];
  }

  if (capabilityId === 'daily_brief') {
    return [
      ...common,
      '调用 /api/v1/commerce/summary 获取单日快照与环比（首日无环比要明示）。',
      '汇总类目异动榜（环比绝对值排序）。',
      '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成包含 datasets.summary 的最终数据文件。',
      '生成经营日报看板并验证摘要、环比、异动榜和合成标注。',
    ];
  }

  return [
    ...common,
    '调用 /api/v1/commerce/funnel 与 /funnel/daily 获取浏览到购买的转化过程与分日趋势。',
    '分类目拆解转化差异并标注事件数口径。',
    '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
    '生成包含 datasets.funnel 与 datasets.funnelDaily 的最终数据文件。',
    '生成流量与购买转化看板并验证转化过程、分日趋势和更新时间。',
  ];
}

function plannedCapabilityNotice(requestedCapabilityId: string, executionCapabilityId: string): string[] {
  if (requestedCapabilityId === executionCapabilityId || requestedCapabilityId === 'catalog_structure') {
    return [];
  }
  return [
    `用户选择的能力为 ${requestedCapabilityId}，当前先映射到已验证执行链路 ${executionCapabilityId}。`,
    '页面必须显式说明尚未完全接入的分析维度，避免把计划能力包装成已完成结果。',
  ];
}

export async function ensureRetailWorkspace(projectPath: string) {
  await Promise.all([
    fs.mkdir(dataAgentDir(projectPath), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'raw'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'intermediate'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'evidence'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'scripts'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'dashboard'), { recursive: true }),
  ]);
}

export async function appendRetailWorkspaceEvent(projectPath: string, event: RetailWorkspaceEvent) {
  await ensureRetailWorkspace(projectPath);
  const line = {
    ...event,
    created_at: event.created_at ?? new Date().toISOString(),
  };
  await fs.appendFile(
    path.join(projectPath, DATA_AGENT_EVENTS_RELATIVE_PATH),
    `${JSON.stringify(line)}\n`,
    'utf8',
  );
}

export async function readRetailRunPlan(projectPath: string): Promise<RetailRunPlan | null> {
  return readJsonFile<RetailRunPlan>(path.join(projectPath, RETAIL_RUN_PLAN_RELATIVE_PATH));
}

async function readPreviousFinalScope(
  projectPath: string,
  previousPlan: RetailRunPlan | null,
  datasetId: string | undefined,
): Promise<RetailAnalysisScope | undefined> {
  if (!previousPlan?.runId) return undefined;
  try {
    const finalData = JSON.parse(
      await fs.readFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), 'utf8'),
    ) as unknown;
    if (!finalData || typeof finalData !== 'object' || Array.isArray(finalData)) return undefined;
    const record = finalData as Record<string, unknown>;
    if (record.runId !== previousPlan.runId) return undefined;
    if (datasetId && record.datasetId !== datasetId) return undefined;
    const datasets = record.datasets;
    if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) return undefined;
    const funnel = (datasets as Record<string, unknown>).funnel;
    if (!funnel || typeof funnel !== 'object' || Array.isArray(funnel)) return undefined;
    const filter = (funnel as Record<string, unknown>).filter;
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return undefined;
    const dimension = (filter as Record<string, unknown>).dimension;
    const value = (filter as Record<string, unknown>).value;
    if (
      !['item', 'category', 'channel', 'campaign', 'user'].includes(String(dimension)) ||
      (typeof value !== 'string' && typeof value !== 'number')
    ) return undefined;
    return {
      dimension: dimension as RetailAnalysisDimension,
      value: String(value),
      source: 'previous-final-data',
    };
  } catch {
    return undefined;
  }
}

function previousItemSetReference(instruction: string): boolean {
  return /这些(?:商品|产品)|它们|上述(?:商品|产品)|这几(?:个)?(?:商品|产品)/.test(instruction);
}

function collectItemIds(value: unknown, ids: Set<number>, depth = 0): void {
  if (depth > 3 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) collectItemIds(item, ids, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const rawItemId = record.item_id;
  const itemId = typeof rawItemId === 'number'
    ? rawItemId
    : typeof rawItemId === 'string' && rawItemId.trim()
      ? Number(rawItemId)
      : NaN;
  if (Number.isSafeInteger(itemId) && itemId > 0) ids.add(itemId);
  for (const key of ['items', 'item_elasticities', 'item_pool', 'itemPool', 'top_items', 'rows']) {
    if (key in record) collectItemIds(record[key], ids, depth + 1);
  }
}

async function readPreviousFinalItemIds(
  projectPath: string,
  previousPlan: RetailRunPlan | null,
  datasetId: string | undefined,
): Promise<number[]> {
  if (!previousPlan?.runId) return [];
  try {
    const finalData = JSON.parse(
      await fs.readFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), 'utf8'),
    ) as unknown;
    if (!finalData || typeof finalData !== 'object' || Array.isArray(finalData)) return [];
    const record = finalData as Record<string, unknown>;
    if (record.runId !== previousPlan.runId) return [];
    if (datasetId && record.datasetId !== datasetId) return [];
    const datasets = record.datasets;
    if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) return [];
    const datasetRecords = datasets as Record<string, unknown>;
    const ids = new Set<number>();
    for (const key of ['inventoryRisk', 'analyticsInventory', 'analyticsReplenishment', 'analyticsLifecycle', 'analyticsElasticity', 'elasticity', 'itemPool']) {
      collectItemIds(datasetRecords[key], ids);
    }
    return [...ids].slice(0, 20);
  } catch {
    return [];
  }
}

export async function writeInitialRunPlan(params: {
  projectId?: string;
  projectPath: string;
  instruction: string;
  requestId: string;
  capabilityId?: string | null;
  capabilitySource?: string | null;
  hasImageAttachments?: boolean;
  previousPlan?: RetailRunPlan | null;
  queryRewrite?: RetailQueryRewriteResult;
  llmModel?: string | null;
  datasetId?: string | null;
  outputMode?: RetailRequestOutputMode | null;
}) {
  await ensureRetailWorkspace(params.projectPath);
  const profileSelection = await readDataAgentProfile(params.projectPath);
  const planningInstruction = stripOperationalInstructions(params.instruction) || params.instruction.trim();
  let queryRewrite = params.queryRewrite ?? await rewriteRetailQuery(planningInstruction, {
    requestedCapabilityId:
      params.capabilitySource === 'manual' || params.capabilitySource === 'benchmark'
        ? params.capabilityId
        : null,
    requestedModel: params.llmModel,
    projectId: params.projectId,
  });
  const outputIntent = inferRetailOutputIntent({
    query: planningInstruction,
    rewriteIntent: queryRewrite.outputIntent,
    requestedOutputMode: params.outputMode,
  });
  queryRewrite = applyRetailOutputIntent(queryRewrite, outputIntent);
  const explicitEntities = Array.from(new Set(
    queryRewrite.resolvedEntities.map((item) =>
      item.kind === 'item' ? `item:${item.id}` : `cat:${item.id}`,
    ),
  ));
  const inheritPreviousPlan = shouldInheritPreviousPlanContext({
    instruction: planningInstruction,
    explicitEntities,
    previousPlan: params.previousPlan,
    hasImageAttachments: params.hasImageAttachments,
  });
  if (
    inheritPreviousPlan &&
    params.previousPlan?.queryRewrite?.broadUniverse === true &&
    queryRewrite.targetCandidates.length === 0 &&
    !queryRewrite.broadUniverse
  ) {
    queryRewrite = {
      ...queryRewrite,
      broadUniverse: true,
    };
  }
  const inheritedEntities = inheritPreviousPlan ? uniqueEntityList(params.previousPlan?.entities) : [];
  const inheritedCapabilityId = inheritPreviousPlan ? params.previousPlan?.capabilityId : null;
  const inferredCapabilityId = inferCapabilityId({
    requestedCapabilityId: params.capabilityId ?? inheritedCapabilityId,
    requestedCapabilitySource: params.capabilityId
      ? params.capabilitySource
      : inheritedCapabilityId
        ? 'inherited'
        : params.capabilitySource,
    profileCapabilityId: profileSelection?.selectedCapabilityId,
    profileCapabilitySource: profileSelection?.selectionSource,
    queryRewrite,
    resolvedEntityCount: explicitEntities.length,
  });
  const capability = getRetailCapability(inferredCapabilityId);
  const executionCapability = capability.id === 'catalog_structure'
    ? capability
    : getExecutionRetailCapability(capability.id);
  const retailSettings = buildRetailProjectSettings(capability.id);
  const now = new Date().toISOString();
  const llm = getProjectLlmConfig(params.llmModel);
  const datasetId =
    params.datasetId?.trim() ||
    extractExplicitRetailDatasetId(planningInstruction) ||
    (inheritPreviousPlan ? params.previousPlan?.datasetId : undefined);
  const inheritedItemIds = inheritPreviousPlan && previousItemSetReference(planningInstruction)
    ? await readPreviousFinalItemIds(params.projectPath, params.previousPlan ?? null, datasetId)
    : [];
  const inheritedItemEntities = inheritedItemIds.map((itemId) => `item:${itemId}`);
  const entities = explicitEntities.length > 0
    ? explicitEntities
    : inheritedEntities.length > 0
      ? inheritedEntities
      : inheritedItemEntities;
  const resolvedPlannedEntities = {
    categoryIds: queryRewrite.resolvedEntities
      .filter((item) => item.kind === 'category')
      .map((item) => item.id),
    itemIds: queryRewrite.resolvedEntities
      .filter((item) => item.kind === 'item')
      .map((item) => item.id),
  };
  const inheritedPlannedEntities = inheritPreviousPlan
    ? params.previousPlan?.plannedEntities
    : undefined;
  const plannedEntities =
    resolvedPlannedEntities.categoryIds.length > 0 || resolvedPlannedEntities.itemIds.length > 0
      ? resolvedPlannedEntities
      : {
          categoryIds: [...(inheritedPlannedEntities?.categoryIds ?? [])],
          itemIds: inheritedItemIds.length > 0
            ? inheritedItemIds
            : [...(inheritedPlannedEntities?.itemIds ?? [])],
        };
  const requestedTimeRange =
    queryRewrite.timeRange?.label ??
    (inheritPreviousPlan ? params.previousPlan?.timeRange ?? null : null);
  const inheritedScope = inheritPreviousPlan
    ? params.previousPlan?.context?.scope ?? await readPreviousFinalScope(params.projectPath, params.previousPlan ?? null, datasetId)
    : undefined;
  const baseClarification = assessRetailIntentForClarification({
    instruction: planningInstruction,
    capabilityId: capability.id,
    entities,
    timeRange: requestedTimeRange,
    hasImageAttachments: params.hasImageAttachments,
    semanticFocusId: queryRewrite.analysisFocus.id,
    wholeCatalog: queryRewrite.broadUniverse,
    inheritedContext: inheritPreviousPlan,
  });
  const clarification = mergeQueryRewriteClarification({
    base: baseClarification,
    queryRewrite,
    capabilityId: capability.id,
    hasImageAttachments: params.hasImageAttachments,
  });
  const refused = queryRewrite.safety.decision === 'refuse';
  const timeRange = clarification.required || refused
    ? requestedTimeRange
    : requestedTimeRange ?? inferDefaultTimeRange(capability.id);
  const dataRequirements = Array.from(
    new Set([
      ...executionCapability.dataEndpoints,
      ...(retailSettings.dataEndpoints ?? []),
    ])
  );
  const expectedArtifacts = Array.from(
    new Set([
      ...capability.expectedArtifacts,
      ...(retailSettings.expectedArtifacts ?? []),
    ])
  );
  const validationRules = Array.from(
    new Set([
      ...capability.validationRules,
      ...plannedCapabilityNotice(capability.id, executionCapability.id),
      ...(retailSettings.validationRules ?? []),
    ])
  );
  const visualizationTemplate = serializeRetailVisualizationTemplate(capability.id, {
    instruction: planningInstruction,
    // Planning 阶段只固定显式实体引用；名称候选只是澄清提示，不是已解析实体。
    entityCount: entities.length > 0 ? entities.length : undefined,
    requestedVariantId:
      inheritPreviousPlan && !hasExplicitVariantReselection(planningInstruction)
        ? params.previousPlan?.visualization?.variantId
        : null,
  });
  const templateMatch = matchRetailTemplateCoverage({
    query: planningInstruction,
    outputIntent,
    template: visualizationTemplate,
    clarificationRequired: clarification.required,
  });
  const templateFallbackToAnswer =
    !refused &&
    !clarification.required &&
    templateMatch.routeStatus === 'template_not_supported';
  if (templateFallbackToAnswer) {
    // 阻断的是不匹配的看板产物，不阻断用户问题；后续仍由 Agent 取数并生成问答。
    queryRewrite = applyRetailOutputIntent(queryRewrite, 'answer');
  }
  const answerOnly = queryRewrite.outputIntent === 'answer';
  const answerOnlyExcludedArtifacts = new Set([
    DATA_AGENT_ARTIFACT_CONTRACTS_RELATIVE_PATH,
    DATA_AGENT_VISUAL_VALIDATION_RELATIVE_PATH,
    DATA_AGENT_VALIDATION_RELATIVE_PATH,
    'app/page.tsx',
  ]);
  const effectiveExpectedArtifacts = answerOnly
    ? expectedArtifacts.filter((artifact) => !answerOnlyExcludedArtifacts.has(artifact))
    : expectedArtifacts;
  const effectiveValidationRules = answerOnly
    ? [
        '必须先解析商品/类目实体（或明确说明是全库口径），再获取真实行为或经营数据。',
        '必须生成数据信源渠道和质量证据文件，并说明抽样窗口。',
        '回答必须区分真实行为数据、合成经营字段和数据窗口边界。',
        '只做问答时不得写入看板源码、启动构建、视觉验证或持久预览。',
      ]
    : validationRules;
  const routeStatus: RetailRouteStatus | undefined = refused
    ? undefined
    : templateMatch.routeStatus;

  const plan: RetailRunPlan = {
    schemaVersion: 1,
    runId: params.requestId,
    status: refused
      ? 'refused'
      : clarification.required
        ? 'needs_clarification'
        : 'planned',
    ...(routeStatus ? { routeStatus } : {}),
    ...(routeStatus && templateMatch.reason ? { routeReason: templateMatch.reason } : {}),
    ...(templateFallbackToAnswer ? { fallbackFrom: 'template_not_supported' as const } : {}),
    capabilityId: capability.id,
    composition: createRetailDataAgentRegistry().resolveCapability(
      RETAIL_AGENT_PROFILE_ID,
      capability.id,
    ).composition,
    llm,
    requestedCapabilityId: capability.id,
    executionCapabilityId: executionCapability.id,
    ...(datasetId ? { datasetId } : {}),
    question: planningInstruction,
    queryRewrite,
    entities,
    plannedEntities,
    window: null,
    context: {
      datasetId: datasetId ?? null,
      entities: [...entities],
      timeRange,
      inherited: inheritPreviousPlan,
      ...(inheritPreviousPlan && params.previousPlan?.runId
        ? { sourceRunId: params.previousPlan.runId }
        : {}),
      ...(inheritedScope ? { scope: inheritedScope } : {}),
      ...(inheritedItemIds.length > 0 ? { inheritedItemIds: [...inheritedItemIds] } : {}),
    },
    timeRange,
    dataRequirements,
    analysisSteps: refused
      ? ['停止执行取数和生成任务，返回确定性安全说明。']
      : clarification.required
      ? [
          ...plannedCapabilityNotice(capability.id, executionCapability.id),
          '补充用户缺失的关键输入。',
          '确认类目/商品范围或分析约束后，再重新生成 planned 状态的执行计划。',
        ]
      : [
          ...plannedCapabilityNotice(capability.id, executionCapability.id),
          ...buildAnalysisSteps(
            capability.id,
            entities.length > 0,
            planningInstruction,
            queryRewrite.outputIntent,
          ),
        ],
    visualization: {
      required:
        !refused &&
        !clarification.required &&
        templateMatch.routeStatus === 'dashboard',
      templateId: visualizationTemplate.templateId,
      name: visualizationTemplate.name,
      scenario: visualizationTemplate.scenario,
      variantId: visualizationTemplate.variantId,
      variantName: visualizationTemplate.variantName,
      variantScenario: visualizationTemplate.variantScenario,
      layout: visualizationTemplate.layout,
      density: visualizationTemplate.density,
      firstViewport: [...visualizationTemplate.firstViewport],
      variantGuidance: [...visualizationTemplate.variantGuidance],
      matchReasons: [...visualizationTemplate.matchReasons],
      panels: [...visualizationTemplate.requiredComponents],
      painPoints: [...visualizationTemplate.painPoints],
      optionalPanels: [...visualizationTemplate.optionalComponents],
      dataSignals: [...visualizationTemplate.dataSignals],
      coverage: {
        metrics: [...visualizationTemplate.coverage.metrics],
        dimensions: [...visualizationTemplate.coverage.dimensions],
        outputModes: [...visualizationTemplate.coverage.outputModes],
      },
      requestedMetrics: [...templateMatch.requestedMetrics],
      requestedDimensions: [...templateMatch.requestedDimensions],
      missingMetrics: [...templateMatch.missingMetrics],
      missingDimensions: [...templateMatch.missingDimensions],
      finalDataContract: [...visualizationTemplate.finalDataContract],
    },
    clarification: !refused && clarification.required ? clarification : undefined,
    refusal: refused && queryRewrite.safety.code && queryRewrite.safety.message
      ? {
          code: queryRewrite.safety.code,
          message: queryRewrite.safety.message,
        }
      : undefined,
    expectedArtifacts: clarification.required || refused
      ? ['.data-agent/retail-run-plan.json', '.data-agent/events.jsonl']
      : effectiveExpectedArtifacts,
    validationRules: effectiveValidationRules,
    createdAt: now,
    updatedAt: now,
  };

  const dataAgentTask = projectRetailRewriteToDataAgentTask(queryRewrite);
  const dataAgentPlan = projectRetailPlanToDataAgentPlan(plan);
  const selectionSource = params.capabilitySource === 'manual' ||
    params.capabilitySource === 'default' ||
    params.capabilitySource === 'inferred'
    ? params.capabilitySource
    : profileSelection?.selectionSource ?? 'inferred';
  const dataAgentProfile = projectRetailProfileSelection(
    dataAgentPlan.capabilityId,
    now,
    selectionSource,
  );
  await Promise.all([
    writeWorkspaceJsonAtomic(
      params.projectPath,
      RETAIL_RUN_PLAN_RELATIVE_PATH,
      plan,
    ),
    writeWorkspaceJsonAtomic(
      params.projectPath,
      RETAIL_QUERY_REWRITE_RELATIVE_PATH,
      queryRewrite,
    ),
    writeWorkspaceJsonAtomic(
      params.projectPath,
      DATA_AGENT_TASK_RELATIVE_PATH,
      dataAgentTask,
    ),
    writeWorkspaceJsonAtomic(
      params.projectPath,
      DATA_AGENT_PLAN_RELATIVE_PATH,
      dataAgentPlan,
    ),
    writeWorkspaceJsonAtomic(
      params.projectPath,
      DATA_AGENT_PROFILE_RELATIVE_PATH,
      dataAgentProfile,
    ),
  ]);

  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: 'query_rewritten',
    stage: 'planning',
    status: queryRewrite.status === 'ready' || queryRewrite.status === 'refused'
      ? 'success'
      : 'warning',
    run_id: params.requestId,
    artifact_path: '.data-agent/retail-query-rewrite.json',
    summary: queryRewrite.status === 'refused'
      ? `问题改写完成，安全策略拒绝执行：${queryRewrite.safety.message}`
      : queryRewrite.status === 'ready'
        ? `已将用户问题改写为结构化查询，并解析 ${queryRewrite.resolvedEntities.length} 个实体。`
        : `问题改写完成，仍有 ${queryRewrite.unresolvedTargets.length + queryRewrite.ambiguousTargets.length} 个商品或类目需要确认。`,
    created_at: now,
  });

  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: refused
      ? 'intent_refused'
        : clarification.required
          ? 'intent_clarification_required'
          : templateMatch.routeStatus === 'template_not_supported'
          ? 'template_coverage_fallback'
        : 'run_planned',
    stage: 'planning',
    status: clarification.required || refused || templateMatch.routeStatus === 'template_not_supported' ? 'warning' : 'success',
    run_id: params.requestId,
    artifact_path: '.data-agent/retail-run-plan.json',
    summary: refused
      ? queryRewrite.safety.message ?? '任务已被安全策略拒绝。'
      : clarification.required
        ? `任务缺少关键输入，需要先向用户澄清：${clarification.questions.join('；')}`
        : templateMatch.routeStatus === 'template_not_supported'
          ? `${templateMatch.reason} 已自动转为问答，继续取数回答原问题。`
        : queryRewrite.outputIntent === 'answer'
          ? `已生成${capability.name}分析计划，下一步将按计划取数并返回分析回答，不生成看板。`
          : `已生成${capability.name}计划，下一步将按计划解析类目/商品实体、获取真实数据并生成可视化产物。`,
    created_at: now,
  });

  return plan;
}
