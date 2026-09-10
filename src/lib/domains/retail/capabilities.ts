import {
  DATA_AGENT_ARTIFACT_CONTRACTS_RELATIVE_PATH,
  DATA_AGENT_EVENTS_RELATIVE_PATH,
  DATA_AGENT_GENERATION_QUEUE_RELATIVE_PATH,
  DATA_AGENT_GENERATION_STATE_RELATIVE_PATH,
  DATA_AGENT_PLAN_RELATIVE_PATH,
  DATA_AGENT_PROFILE_RELATIVE_PATH,
  DATA_AGENT_TASK_RELATIVE_PATH,
  DATA_AGENT_VALIDATION_RELATIVE_PATH,
  DATA_AGENT_VISUAL_VALIDATION_RELATIVE_PATH,
  DATA_AGENT_WORKSPACE_RELATIVE_PATH,
} from '@/lib/data-agent/workspace-layout';
import {
  RETAIL_QUERY_REWRITE_RELATIVE_PATH,
  RETAIL_RUN_PLAN_RELATIVE_PATH,
} from './workspace-artifacts';

export type RetailCapabilityId =
  | 'traffic_funnel'
  | 'catalog_structure'
  | 'price_inventory'
  | 'daily_brief';

export type RetailCapabilityStatus = 'ready' | 'planned';

export type RetailCapabilityGroupId = 'core_analysis' | 'operations';

export interface RetailCapabilityGroup {
  id: RetailCapabilityGroupId;
  name: string;
  description: string;
}

export interface RetailCapability {
  id: RetailCapabilityId;
  name: string;
  shortName: string;
  description: string;
  inputHint: string;
  tags: string[];
  status: RetailCapabilityStatus;
  groupId: RetailCapabilityGroupId;
  agentType: 'commerce_analysis' | 'commerce_backtest' | 'commerce_dashboard';
  subAgentKey: RetailCapabilityId;
  executionCapabilityId: RetailCapabilityId;
  requiredSkills: string[];
  dataEndpoints: string[];
  expectedArtifacts: string[];
  validationRules: string[];
  promptGuidance: string[];
}

export interface RetailProjectSettings {
  capabilityId: RetailCapabilityId;
  agentType: RetailCapability['agentType'];
  subAgentKey: RetailCapabilityId;
  executionCapabilityId: RetailCapabilityId;
  status: RetailCapabilityStatus;
  requiredSkills: string[];
  dataEndpoints: string[];
  expectedArtifacts: string[];
  validationRules: string[];
}

export const DEFAULT_RETAIL_CAPABILITY_ID: RetailCapabilityId = 'traffic_funnel';

export const RETAIL_CAPABILITY_GROUPS: RetailCapabilityGroup[] = [
  {
    id: 'core_analysis',
    name: '核心分析',
    description: '覆盖流量、转化与商品结构的真实行为数据链路。',
  },
  {
    id: 'operations',
    name: '经营运营',
    description: '面向价格库存（合成口径）与经营日报的日常运营能力。',
  },
];

const BASE_EXPECTED_ARTIFACTS = [
  DATA_AGENT_WORKSPACE_RELATIVE_PATH,
  DATA_AGENT_PROFILE_RELATIVE_PATH,
  DATA_AGENT_TASK_RELATIVE_PATH,
  DATA_AGENT_PLAN_RELATIVE_PATH,
  RETAIL_QUERY_REWRITE_RELATIVE_PATH,
  RETAIL_RUN_PLAN_RELATIVE_PATH,
  DATA_AGENT_GENERATION_STATE_RELATIVE_PATH,
  DATA_AGENT_GENERATION_QUEUE_RELATIVE_PATH,
  DATA_AGENT_EVENTS_RELATIVE_PATH,
  DATA_AGENT_ARTIFACT_CONTRACTS_RELATIVE_PATH,
  DATA_AGENT_VISUAL_VALIDATION_RELATIVE_PATH,
  DATA_AGENT_VALIDATION_RELATIVE_PATH,
  'evidence/sources.json',
  'evidence/data_quality.json',
  'data_file/final/dashboard-data.json',
  'app/page.tsx',
];

function baseExpectedArtifacts() {
  return [...BASE_EXPECTED_ARTIFACTS];
}

export const RETAIL_DATA_ENDPOINTS = {
  resolve: 'GET /api/v1/commerce/resolve',
  meta: 'GET /api/v1/commerce/meta',
  funnel: 'GET /api/v1/commerce/funnel',
  funnelDaily: 'GET /api/v1/commerce/funnel/daily',
  categoriesTop: 'GET /api/v1/commerce/categories/top',
  itemDaily: 'GET /api/v1/commerce/items/{item_id}/daily',
  inventoryRisk: 'GET /api/v1/commerce/inventory-risk',
  channels: 'GET /api/v1/commerce/channels',
  items: 'GET /api/v1/commerce/items',
  summary: 'GET /api/v1/commerce/summary',
} as const;

/**
 * v1 只引用平台保留的通用 skills；零售领域 skills（实体解析、商品数据、
 * 指标口径、复盘）由 P8 以版本化发布引入后，在这里追加。skill 合同见
 * `.pi/`，不得在能力定义里凭空引用不存在的 skill id。
 */
const BASE_REQUIRED_SKILLS = [
  'query-rewrite',
  'run-planner',
  'data-quality',
  'dashboard-visualization',
];

export const RETAIL_CAPABILITIES: RetailCapability[] = [
  {
    id: 'traffic_funnel',
    name: '流量与转化漏斗',
    shortName: '漏斗',
    description: '围绕真实行为流完成 pv→fav→cart→buy 漏斗、分日趋势与分类目对比。',
    inputHint: '例如：加购未购买的行为漏斗长什么样？哪个环节流失最大？生成漏斗看板。',
    tags: ['行为流', '漏斗', '转化率', '分类目'],
    status: 'ready',
    groupId: 'core_analysis',
    agentType: 'commerce_analysis',
    subAgentKey: 'traffic_funnel',
    executionCapabilityId: 'traffic_funnel',
    requiredSkills: [...BASE_REQUIRED_SKILLS],
    dataEndpoints: [
      RETAIL_DATA_ENDPOINTS.resolve,
      RETAIL_DATA_ENDPOINTS.meta,
      RETAIL_DATA_ENDPOINTS.funnel,
      RETAIL_DATA_ENDPOINTS.funnelDaily,
      RETAIL_DATA_ENDPOINTS.categoriesTop,
    ],
    expectedArtifacts: baseExpectedArtifacts(),
    validationRules: [
      '必须先解析商品/类目实体（或明确说明是全库口径），再获取真实行为数据。',
      '必须生成数据信源渠道和质量证据文件，并说明抽样窗口。',
      '页面必须包含总漏斗、分日趋势、分类目对比和数据质量与更新时间；金额字段必须带合成口径标注。',
      '可视化必须使用 funnel-analysis 模板，首屏露出漏斗、分日转化和分类目对比，不要生成营销式大标题页。',
      '生成后需要通过 Next.js build 与预览 HTTP 200 检查。',
    ],
    promptGuidance: [
      '默认先做整体或分类目的转化漏斗诊断。',
      '如果用户提到商品或类目名称，先通过 /resolve 解析为实体 ID，并保留原文字面证据。',
      '结论区分事实数据、计算结果和推断。',
      '漏斗各阶段的转化率必须标注分母口径（事件数口径）。',
    ],
  },
  {
    id: 'catalog_structure',
    name: '类目与商品结构',
    shortName: '结构',
    description: '分析 GMV/流量的类目集中度、商品动销与高曝光低转化清单。',
    inputHint: '例如：GMV 最高的 5 个类目转化率和客单价对比如何？生成结构看板。',
    tags: ['类目', 'GMV', '集中度', '动销'],
    status: 'ready',
    groupId: 'core_analysis',
    agentType: 'commerce_analysis',
    subAgentKey: 'catalog_structure',
    executionCapabilityId: 'catalog_structure',
    requiredSkills: [...BASE_REQUIRED_SKILLS],
    dataEndpoints: [
      RETAIL_DATA_ENDPOINTS.resolve,
      RETAIL_DATA_ENDPOINTS.meta,
      RETAIL_DATA_ENDPOINTS.categoriesTop,
      RETAIL_DATA_ENDPOINTS.itemDaily,
      RETAIL_DATA_ENDPOINTS.funnelDaily,
    ],
    expectedArtifacts: baseExpectedArtifacts(),
    validationRules: [
      '类目排名必须来自真实日聚合表，并注明合成金额口径。',
      '类目名是合成映射（synthetic_name=true），页面必须保留标注。',
      '页面必须包含类目排名、集中度（top-5 占比）、高流量低转化诊断和至少一个商品动销明细。',
      '可视化必须使用 catalog-structure 模板。',
      '不得把合成金额表述为真实交易数据。',
    ],
    promptGuidance: [
      '优先把类目拆成 GMV、转化率、客单价三列。',
      '读取 data_file/final/dashboard-data.json 中的 categories 数据集。',
      '集中度必须给出计算口径（top-5 类目 GMV 占比）。',
      '高流量低转化类目要单独成表，说明流量阈值、整体转化率基线和诊断建议。',
    ],
  },
  {
    id: 'price_inventory',
    name: '价格与库存',
    shortName: '价库',
    description: '价格带分布、库销比排行与滞销清单（价格/库存为合成口径）。',
    inputHint: '例如：库销比最差的 10 个商品是哪些？它们的流量转化情况如何？',
    tags: ['价格带', '库存', '库销比', '滞销'],
    status: 'ready',
    groupId: 'operations',
    agentType: 'commerce_analysis',
    subAgentKey: 'price_inventory',
    executionCapabilityId: 'price_inventory',
    requiredSkills: [...BASE_REQUIRED_SKILLS],
    dataEndpoints: [
      RETAIL_DATA_ENDPOINTS.resolve,
      RETAIL_DATA_ENDPOINTS.meta,
      RETAIL_DATA_ENDPOINTS.funnel,
      RETAIL_DATA_ENDPOINTS.funnelDaily,
      RETAIL_DATA_ENDPOINTS.categoriesTop,
      RETAIL_DATA_ENDPOINTS.inventoryRisk,
      RETAIL_DATA_ENDPOINTS.channels,
      RETAIL_DATA_ENDPOINTS.items,
      RETAIL_DATA_ENDPOINTS.itemDaily,
    ],
    expectedArtifacts: baseExpectedArtifacts(),
    validationRules: [
      '价格、库存全部来自合成主数据，页面每个相关模块都必须带“合成口径”徽标与说明。',
      '库销比必须给出计算口径（库存 / 日均销量，销量为 0 时用地板值）。',
      '页面必须包含 KPI 总览、分日经营趋势、价格带分布、渠道/类目拆解、库销比排行、异常诊断和行动建议。',
      '可视化必须使用 price-inventory 模板。',
      '滞销建议必须说明是分析参考，不构成采购或下架指令。',
    ],
    promptGuidance: [
      '先讲清价格/库存的合成口径，再给分析。',
      '库销比排行要同时给出销量与曝光，方便判断是流量问题还是商品问题。',
      '零销量商品单独标注（库销比用地板值计算）。',
      '不要把库销比排行直接当成行动清单。',
    ],
  },
  {
    id: 'daily_brief',
    name: '经营情报日报',
    shortName: '日报',
    description: '单日经营摘要（GMV/转化/客单价）+ 环比 + 异动类目 + 观察池动态。',
    inputHint: '例如：生成 12 月 3 日的经营日报，重点看环比和异动类目。',
    tags: ['日报', '环比', '异动', '观察池'],
    status: 'ready',
    groupId: 'operations',
    agentType: 'commerce_analysis',
    subAgentKey: 'daily_brief',
    executionCapabilityId: 'daily_brief',
    requiredSkills: [...BASE_REQUIRED_SKILLS],
    dataEndpoints: [
      RETAIL_DATA_ENDPOINTS.resolve,
      RETAIL_DATA_ENDPOINTS.meta,
      RETAIL_DATA_ENDPOINTS.summary,
      RETAIL_DATA_ENDPOINTS.funnelDaily,
      RETAIL_DATA_ENDPOINTS.categoriesTop,
    ],
    expectedArtifacts: baseExpectedArtifacts(),
    validationRules: [
      '日报必须基于 summary 接口的单日快照与环比数据，不得凭空补数。',
      '异动类目必须给出环比幅度与排序口径。',
      '页面必须包含摘要卡、环比、类目异动榜和数据质量说明。',
      '可视化必须使用 daily-brief 模板。',
      '金额必须带合成口径标注。',
    ],
    promptGuidance: [
      '先给当日总量摘要，再给环比，再给异动明细。',
      '数据窗口只有 9 天时，第一天没有环比，必须明示。',
      '异动类目用环比绝对值排序，不要只看 GMV。',
      '日报结论用“当日观察”措辞，不做长期趋势推断。',
    ],
  },
];

export function getExecutionRetailCapability(id?: string | null): RetailCapability {
  const capability = getRetailCapability(id);
  if (capability.status === 'ready') {
    return capability;
  }
  return getRetailCapability(capability.executionCapabilityId);
}

export function getRetailCapability(id?: string | null): RetailCapability {
  return (
    RETAIL_CAPABILITIES.find((capability) => capability.id === id) ??
    RETAIL_CAPABILITIES.find(
      (capability) => capability.id === DEFAULT_RETAIL_CAPABILITY_ID,
    )!
  );
}

export function isRetailCapabilityId(value: unknown): value is RetailCapabilityId {
  return (
    typeof value === 'string' &&
    RETAIL_CAPABILITIES.some((capability) => capability.id === value)
  );
}

export function buildRetailProjectSettings(id?: string | null): RetailProjectSettings {
  const capability = getRetailCapability(id);
  const executionCapability = getExecutionRetailCapability(capability.id);
  return {
    capabilityId: capability.id,
    agentType: capability.agentType,
    subAgentKey: capability.subAgentKey,
    executionCapabilityId: executionCapability.id,
    status: capability.status,
    requiredSkills: capability.requiredSkills,
    dataEndpoints: executionCapability.dataEndpoints,
    expectedArtifacts: executionCapability.expectedArtifacts,
    validationRules: capability.validationRules,
  };
}

export function serializeRetailCapabilities() {
  return RETAIL_CAPABILITIES.map((capability) => ({
    id: capability.id,
    name: capability.name,
    shortName: capability.shortName,
    description: capability.description,
    inputHint: capability.inputHint,
    tags: capability.tags,
    status: capability.status,
    groupId: capability.groupId,
    agentType: capability.agentType,
    subAgentKey: capability.subAgentKey,
    executionCapabilityId: capability.executionCapabilityId,
    requiredSkills: capability.requiredSkills,
    dataEndpoints: getExecutionRetailCapability(capability.id).dataEndpoints,
    expectedArtifacts: getExecutionRetailCapability(capability.id).expectedArtifacts,
    validationRules: capability.validationRules,
  }));
}
