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
  createRetailDataAgentRegistry,
  RETAIL_AGENT_PROFILE_ID,
} from '@/lib/domains/retail/agent-profile';
import {
  RETAIL_QUERY_REWRITE_RELATIVE_PATH,
  RETAIL_RUN_PLAN_RELATIVE_PATH,
} from '@/lib/domains/retail/workspace-artifacts';

type RunPlanStatus = 'pending' | 'planned' | 'needs_clarification' | 'refused';

export interface RetailRunPlan {
  schemaVersion: 1;
  runId: string;
  status: RunPlanStatus;
  capabilityId: string;
  composition: DataAgentCompositionLock;
  llm: ProjectLlmConfig;
  requestedCapabilityId?: string;
  executionCapabilityId?: string;
  question: string;
  queryRewrite?: RetailQueryRewriteResult;
  /** 已解析实体的文本形式（item:<id> / cat:<id> / 名称提示）。 */
  entities: string[];
  /** 具体数据窗口；planning 阶段可为 null，由 data_prefetch 以 /meta 精化。 */
  window: { start: string; end: string } | null;
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

function hasExplicitVariantReselection(instruction: string): boolean {
  return /相关性|热力图|分散|流动性|成交额|换手|强弱|累计收益|收益曲线|净值曲线|折线图|排名|排序|候选|选股/.test(
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
  if (!params.previousPlan || params.previousPlan.status === 'needs_clarification') {
    return false;
  }
  if (params.explicitEntities.length > 0 || previousEntities.length === 0) {
    return false;
  }
  if (!isDashboardRevisionInstruction(params.instruction)) {
    return false;
  }
  if (hasExplicitInventoryIntent(params.instruction, params.hasImageAttachments) && params.previousPlan.capabilityId !== 'price_inventory') {
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
    return params.requestedCapabilityId;
  }

  if (!params.requestedCapabilityId && params.profileCapabilityId && params.profileCapabilitySource === 'manual') {
    return params.profileCapabilityId;
  }

  if (params.queryRewrite.analysisFocus.id === 'price_inventory') {
    return 'price_inventory';
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
      ? '调用 /api/v1/commerce/inventory-risk 和相关漏斗接口，按库存、浏览、购买和转化指标整理回答。'
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
    '调用 /api/v1/commerce/funnel 与 /funnel/daily 获取漏斗与分日趋势。',
    '分类目拆解转化差异并标注事件数口径。',
    '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
    '生成包含 datasets.funnel 与 datasets.funnelDaily 的最终数据文件。',
    '生成流量转化漏斗看板并验证漏斗、分日趋势和更新时间。',
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
}) {
  await ensureRetailWorkspace(params.projectPath);
  const profileSelection = await readDataAgentProfile(params.projectPath);
  const planningInstruction = stripOperationalInstructions(params.instruction) || params.instruction.trim();
  const queryRewrite = params.queryRewrite ?? await rewriteRetailQuery(planningInstruction, {
    requestedCapabilityId:
      params.capabilitySource === 'manual' || params.capabilitySource === 'benchmark'
        ? params.capabilityId
        : null,
    requestedModel: params.llmModel,
    projectId: params.projectId,
  });
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
  const inheritedEntities = inheritPreviousPlan ? uniqueEntityList(params.previousPlan?.entities) : [];
  const inheritedCapabilityId = inheritPreviousPlan ? params.previousPlan?.capabilityId : null;
  const inferredCapabilityId = inferCapabilityId({
    requestedCapabilityId: params.capabilityId ?? inheritedCapabilityId,
    requestedCapabilitySource: params.capabilityId ? params.capabilitySource : inheritedCapabilityId ? 'manual' : params.capabilitySource,
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
  const entities = explicitEntities.length > 0 ? explicitEntities : inheritedEntities;
  const plannedEntities = {
    categoryIds: queryRewrite.resolvedEntities
      .filter((item) => item.kind === 'category')
      .map((item) => item.id),
    itemIds: queryRewrite.resolvedEntities
      .filter((item) => item.kind === 'item')
      .map((item) => item.id),
  };
  const requestedTimeRange =
    queryRewrite.timeRange?.label ??
    (inheritPreviousPlan ? params.previousPlan?.timeRange ?? null : null);
  const baseClarification = assessRetailIntentForClarification({
    instruction: planningInstruction,
    capabilityId: capability.id,
    entities,
    timeRange: requestedTimeRange,
    hasImageAttachments: params.hasImageAttachments,
    semanticFocusId: queryRewrite.analysisFocus.id,
    wholeCatalog: queryRewrite.broadUniverse,
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

  const plan: RetailRunPlan = {
    schemaVersion: 1,
    runId: params.requestId,
    status: refused
      ? 'refused'
      : clarification.required
        ? 'needs_clarification'
        : 'planned',
    capabilityId: capability.id,
    composition: createRetailDataAgentRegistry().resolveCapability(
      RETAIL_AGENT_PROFILE_ID,
      capability.id,
    ).composition,
    llm,
    requestedCapabilityId: capability.id,
    executionCapabilityId: executionCapability.id,
    question: planningInstruction,
    queryRewrite,
    entities,
    plannedEntities,
    window: null,
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
        queryRewrite.outputIntent === 'dashboard',
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
      : expectedArtifacts,
    validationRules,
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
        : `问题改写完成，仍有 ${queryRewrite.unresolvedTargets.length + queryRewrite.ambiguousTargets.length} 个标的需要确认。`,
    created_at: now,
  });

  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: refused
      ? 'intent_refused'
      : clarification.required
        ? 'intent_clarification_required'
        : 'run_planned',
    stage: 'planning',
    status: clarification.required || refused ? 'warning' : 'success',
    run_id: params.requestId,
    artifact_path: '.data-agent/retail-run-plan.json',
    summary: refused
      ? queryRewrite.safety.message ?? '任务已被安全策略拒绝。'
      : clarification.required
        ? `任务缺少关键输入，需要先向用户澄清：${clarification.questions.join('；')}`
        : queryRewrite.outputIntent === 'answer'
          ? `已生成${capability.name}分析计划，下一步将按计划取数并返回分析回答，不生成看板。`
          : `已生成${capability.name}计划，下一步将按计划解析类目/商品实体、获取真实数据并生成可视化产物。`,
    created_at: now,
  });

  return plan;
}
