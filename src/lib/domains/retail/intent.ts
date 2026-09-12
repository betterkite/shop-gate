import {
  extractExplicitEntityRefs,
  matchKnownEntityAliases,
} from '@/lib/domains/retail/entity-aliases';

export { stripConversationalEntityReferenceSuffix } from '@/lib/domains/retail/query-rewrite';

export type RetailClarificationMissingField =
  | 'target'
  | 'analysis_goal'
  | 'comparison_scope'
  | 'action_constraints';

export interface RetailIntentClarification {
  required: boolean;
  reason: string;
  missing: RetailClarificationMissingField[];
  questions: string[];
  confidence: number;
  defaults?: string[];
}

interface AssessRetailIntentParams {
  instruction: string;
  capabilityId?: string | null;
  entities?: string[];
  timeRange?: string | null;
  hasImageAttachments?: boolean;
  semanticFocusId?: string | null;
  wholeCatalog?: boolean;
  /** 上一轮已有明确范围时，“哪个/哪些”可表示范围内排序，而非要求补充第二个对象。 */
  inheritedContext?: boolean;
}

interface PreviousClarificationPlan {
  runId: string;
  status?: string;
  capabilityId?: string | null;
  executionCapabilityId?: string | null;
  question?: string | null;
  clarification?: RetailIntentClarification;
}

export interface RetailClarificationContinuation {
  previousRunId: string;
  originalQuestion: string;
  userResponse: string;
  resolvedInstruction: string;
  displayInstruction: string;
  missing: RetailClarificationMissingField[];
}

const RETAIL_KEYWORD_PATTERN =
  /商品|类目|SKU|单品|流量|曝光|浏览|加购|收藏|购买|转化|漏斗|GMV|成交|客单价|动销|库存|库销比|滞销|畅销|销售|买家|复购|运营|经营|日报|看板|促销|活动|价格|降价|清仓|补货/i;

const GOAL_KEYWORD_PATTERN =
  /漏斗|转化|趋势|结构|排名|分布|对比|比较|环比|异动|摘要|日报|诊断|分析|怎么样|如何|怎么|看板|可视化|集中度|动销|库销比|客单价/i;

const WHOLE_CATALOG_PATTERN =
  /全库|全部类目|整体|全店|大盘|总体|所有商品|类目结构|商品池|数据窗口/i;

const COMPARISON_PATTERN = /对比|比较|相比|相对|哪个|哪些|谁更|强弱|VS|vs|versus/i;
const ACTION_RECOMMENDATION_PATTERN =
  /推荐|补货|进货|下架|清仓|调价|降价|打折|促销|要不要|该不该|值得|建议/i;
const ACTION_CONSTRAINT_PATTERN =
  /预算|周期|档期|毛利|风险|约束|上限|一周|一个月|三个月|半年|促销|库存上限|安全库存/i;
const IMAGE_CONTEXT_TARGET_PATTERN =
  /图片|截图|商品|库存|价格|订单|成本|销售|明细/i;

function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\s+/g, ' ').trim();
}

function hasRetailIntent(instruction: string, capabilityId?: string | null): boolean {
  if (RETAIL_KEYWORD_PATTERN.test(instruction)) {
    return true;
  }

  return Boolean(
    capabilityId &&
      [
        'traffic_funnel',
        'catalog_structure',
        'price_inventory',
        'daily_brief',
      ].includes(capabilityId)
  );
}

function uniqueMissing(values: RetailClarificationMissingField[]): RetailClarificationMissingField[] {
  return Array.from(new Set(values));
}

function buildQuestions(
  missing: RetailClarificationMissingField[],
  params: {
    isActionRecommendation: boolean;
    isComparison: boolean;
  },
): string[] {
  const questions: string[] = [];

  if (missing.includes('target')) {
    questions.push('你想看哪个类目或商品？（可以说名称，或用 item:/cat: 指定 ID；不指定则按全库口径分析。）');
  }

  if (missing.includes('comparison_scope')) {
    questions.push('你要对比哪些类目或商品？请给至少两个名称或 ID。');
  }

  if (missing.includes('action_constraints')) {
    questions.push(
      params.isActionRecommendation
        ? '这是运营动作建议类问题，请补充周期、类目范围或库存/毛利约束；我基于数据给分析参考，不构成操作指令。'
        : '请补充分析周期或约束条件（如类目范围、库存口径），方便口径一致地分析。'
    );
  }

  if (missing.includes('analysis_goal')) {
    questions.push(
      params.isComparison
        ? '你更想对比转化漏斗、类目结构、价格库存，还是环比异动？'
        : '你更关注转化漏斗、类目结构、价格库存，还是经营日报？'
    );
  }

  return questions.slice(0, 3);
}

function buildContinuationSupplementLabel(missing: RetailClarificationMissingField[]): string {
  if (missing.includes('comparison_scope')) {
    return '补充对比对象';
  }
  if (missing.includes('target')) {
    return '补充分析对象';
  }
  if (missing.includes('action_constraints')) {
    return '补充运营约束';
  }
  if (missing.includes('analysis_goal')) {
    return '补充分析方向';
  }
  return '补充信息';
}

export function assessRetailIntentForClarification(
  params: AssessRetailIntentParams
): RetailIntentClarification {
  const instruction = normalizeInstruction(params.instruction);
  const entities = Array.isArray(params.entities) ? params.entities.filter(Boolean) : [];

  if (!instruction || !hasRetailIntent(instruction, params.capabilityId)) {
    return {
      required: false,
      reason: '当前请求不是需要平台取数的零售经营分析任务。',
      missing: [],
      questions: [],
      confidence: 0.9,
    };
  }

  const explicitRefs = extractExplicitEntityRefs(instruction);
  const aliasMatches = matchKnownEntityAliases(instruction);
  const hasWholeCatalogTarget = WHOLE_CATALOG_PATTERN.test(instruction);
  // Query Rewrite 是可执行全库口径的唯一权威；澄清层不得用关键词重建该语义决策。
  const wholeCatalogRequest = params.wholeCatalog === true;
  const explicitTargetCount = new Set([
    ...entities,
    ...explicitRefs.map((ref) => `${ref.kind}:${ref.id}`),
    ...aliasMatches.map((match) => match.alias.term),
  ]).size;
  const targetCount = explicitTargetCount;
  const canInferTargetFromImage =
    params.hasImageAttachments === true &&
    (IMAGE_CONTEXT_TARGET_PATTERN.test(instruction) || params.capabilityId === 'daily_brief');
  const hasTarget =
    targetCount > 0 || hasWholeCatalogTarget || wholeCatalogRequest || canInferTargetFromImage;
  const isComparison =
    COMPARISON_PATTERN.test(instruction) || params.capabilityId === 'catalog_structure';
  const isActionRecommendation = ACTION_RECOMMENDATION_PATTERN.test(instruction);
  const hasGoal =
    GOAL_KEYWORD_PATTERN.test(instruction) ||
    Boolean(params.semanticFocusId && params.semanticFocusId !== 'comprehensive');
  const hasActionConstraints = ACTION_CONSTRAINT_PATTERN.test(instruction);
  const missing: RetailClarificationMissingField[] = [];

  if (!hasTarget && !isComparison && (instruction.length <= 18 || isActionRecommendation || hasGoal)) {
    missing.push('target');
  }

  if (isComparison && targetCount < 2 && !wholeCatalogRequest && !params.inheritedContext) {
    missing.push('comparison_scope');
  }

  if (isActionRecommendation && !hasActionConstraints && !canInferTargetFromImage && !wholeCatalogRequest) {
    missing.push('action_constraints');
  }

  if (hasTarget && !hasGoal && !isActionRecommendation) {
    missing.push('analysis_goal');
  }

  const unique = uniqueMissing(missing);
  const required = unique.length > 0;

  return {
    required,
    reason: required
      ? `任务缺少关键输入：${unique.join(', ')}。`
      : '任务意图足够明确，可进入取数、证据和看板生成流程。',
    missing: unique,
    questions: buildQuestions(unique, { isActionRecommendation, isComparison }),
    confidence: required ? 0.82 : 0.86,
    defaults: required
      ? undefined
      : [
          ...(wholeCatalogRequest
            ? [
                '未给具体类目/商品时默认使用数据窗口内全库口径。',
                '运营动作建议默认只输出分析参考，不作为操作指令。',
              ]
            : []),
          params.timeRange
            ? `使用时间范围：${params.timeRange}`
            : '未指定时间范围时默认使用数据窗口内最近 9 天（首日无环比会明示）。',
          '未指定输出形式时默认生成可验证的零售经营看板。',
          ...(canInferTargetFromImage
            ? ['图片/截图任务会先识别附件中的商品、库存与销售字段，再进入取数分析；识别不确定的字段必须在结果中标注。']
            : []),
        ],
  };
}

export function buildRetailClarificationMessage(
  clarification: RetailIntentClarification,
  outputIntent: 'dashboard' | 'answer' = 'dashboard',
): string {
  const questions = clarification.questions.length
    ? clarification.questions
    : ['请补充你想分析的对象、时间范围和关注方向。'];

  return [
    outputIntent === 'answer'
      ? '我需要先补充几个关键信息，再开始取数和整理分析回答：'
      : '我需要先补充几个关键信息，再开始取数和生成看板：',
    '',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    outputIntent === 'answer'
      ? '补充后我会先生成 run_plan，再获取真实数据、写入证据文件，最后只返回中文分析结论，不生成看板。'
      : '补充后我会先生成 run_plan，再获取真实数据、写入证据文件，最后生成可验证的可视化看板。',
  ].join('\n');
}

export function buildClarificationContinuation(params: {
  previousPlan: PreviousClarificationPlan | null | undefined;
  instruction: string;
  displayInstruction?: string | null;
  capabilityId?: string | null;
  reset?: boolean;
}): RetailClarificationContinuation | null {
  if (params.reset) return null;
  const previousPlan = params.previousPlan;
  const originalQuestion = normalizeInstruction(previousPlan?.question ?? '');
  const userResponse = normalizeInstruction(params.instruction);

  if (
    !previousPlan ||
    previousPlan.status !== 'needs_clarification' ||
    !previousPlan.clarification?.required ||
    !originalQuestion ||
    !userResponse
  ) {
    return null;
  }

  const displayResponse = normalizeInstruction(params.displayInstruction || params.instruction);
  const missing = previousPlan.clarification.missing;
  const supplementLabel = buildContinuationSupplementLabel(missing);
  const resolvedInstruction = [
    originalQuestion,
    `${supplementLabel}：${userResponse}`,
  ].join('\n');
  return {
    previousRunId: previousPlan.runId,
    originalQuestion,
    userResponse,
    resolvedInstruction,
    displayInstruction: [
      '承接上一轮澄清',
      `原始问题：${originalQuestion}`,
      `补充信息：${displayResponse}`,
    ].join('\n'),
    missing,
  };
}
