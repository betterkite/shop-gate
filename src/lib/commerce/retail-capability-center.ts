import {
  DEFAULT_RETAIL_CAPABILITY_ID,
  RETAIL_CAPABILITY_GROUPS,
  serializeRetailCapabilities,
} from '@/lib/domains/retail/capabilities';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { getSkillsDashboardData } from '@/lib/commerce/skills-dashboard';

type JsonRecord = Record<string, unknown>;

export interface CapabilityCenterSkillRef {
  id: string;
  name: string;
  version: string;
  status: string;
  health: string;
}

export interface CapabilityCenterItem {
  id: string;
  name: string;
  shortName: string;
  description: string;
  inputHint: string;
  tags: string[];
  status: string;
  groupId: string;
  agentType: string;
  executionCapabilityId: string;
  requiredSkills: CapabilityCenterSkillRef[];
  missingSkills: string[];
  dataEndpoints: string[];
  expectedArtifacts: string[];
  validationRules: string[];
  readiness: {
    status: 'ready' | 'warning' | 'blocked' | 'planned';
    summary: string;
    score: number;
  };
}

export interface CapabilityCenterDataProvider {
  id: string;
  name: string;
  category: string;
  status: string;
  description: string;
  endpoints: string[];
  cacheTtlSeconds: number | null;
  limitations: string[];
}

export interface CapabilityCenterData {
  generatedAt: string;
  defaultCapabilityId: string;
  groups: typeof RETAIL_CAPABILITY_GROUPS;
  summary: {
    capabilities: number;
    readyCapabilities: number;
    plannedCapabilities: number;
    blockedCapabilities: number;
    skills: number;
    skillErrors: number;
    dataProviders: number;
    availableProviders: number;
    degradedProviders: number;
    marketApiReachable: boolean;
  };
  marketApi: {
    baseUrl: string;
    reachable: boolean;
    status: string;
    checkedAt: string;
    error: string | null;
  };
  degradation: {
    mode: string;
    marketApiEnabled: boolean;
    marketApiRequired: boolean;
  };
  capabilities: CapabilityCenterItem[];
  dataProviders: CapabilityCenterDataProvider[];
}

const MARKET_API_BASE_URL =
  process.env.SHOPGATE_MARKET_API_URL ||
  process.env.SHOPGATE_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

const FALLBACK_DATA_PROVIDERS: CapabilityCenterDataProvider[] = [
  {
    id: 'commerce-meta',
    name: 'commerce-data 数据窗口口径',
    category: 'dataset',
    status: 'available',
    description: '当前数据窗口、事件量、用户/商品/类目数量和数据来源。',
    endpoints: ['/api/v1/commerce/meta'],
    cacheTtlSeconds: 300,
    limitations: ['只统计当前数据窗口；第一天没有前一天可比较。'],
  },
  {
    id: 'tianchi-userbehavior',
    name: '天池淘宝用户行为数据集（抽样）',
    category: 'primary-dataset',
    status: 'available',
    description: '用户浏览、收藏、加购和购买记录，按用户抽样导入数据仓库。',
    endpoints: ['commerce.user_behavior_events'],
    cacheTtlSeconds: null,
    limitations: ['这里只有行为记录，没有订单或支付金额；成交总额按购买次数 × 商品价格估算。'],
  },
  {
    id: 'commerce-synthetic-master',
    name: '演示商品主数据',
    category: 'synthetic-dataset',
    status: 'available',
    description: '商品价格、库存、品牌和店铺是稳定的演示数据；商品和类目编号与行为数据保持一致。',
    endpoints: ['commerce.items', 'commerce.categories', 'commerce.brands', 'commerce.shops'],
    cacheTtlSeconds: null,
    limitations: ['用于分析演示，不代表真实交易数据。'],
  },
  {
    id: 'commerce-daily-aggregates',
    name: '商品/类目日聚合',
    category: 'derived-dataset',
    status: 'available',
    description: '导入后 SQL 生成的日聚合（pv/fav/cart/buy/gmv/转化）。',
    endpoints: ['commerce.daily_item_metrics', 'commerce.daily_category_metrics'],
    cacheTtlSeconds: null,
    limitations: ['成交总额依赖商品价格，属于估算金额。'],
  },
  {
    id: 'commerce-expanded-analytics',
    name: '经营分析扩展数据集',
    category: 'synthetic-dataset',
    status: 'available',
    description: '按 dataset_id 隔离的用户、会话、渠道、活动、订单、成本和库存快照，供 P28 分析能力使用。',
    endpoints: [
      '/api/v1/commerce/datasets',
      '/api/v1/commerce/analytics/rfm',
      '/api/v1/commerce/analytics/retention',
      '/api/v1/commerce/analytics/channel-campaign',
      '/api/v1/commerce/analytics/profit',
      '/api/v1/commerce/analytics/inventory',
      '/api/v1/commerce/analytics/replenishment',
      '/api/v1/commerce/analytics/lifecycle',
      '/api/v1/commerce/analytics/price-elasticity',
      '/api/v1/commerce/analytics/trend',
      '/api/v1/commerce/analytics/drilldown',
      '/analytics-workbench',
    ],
    cacheTtlSeconds: null,
    limitations: ['当前演示数据为合成数据；渠道归因、成本、利润和库存快照不能代表真实业务事实。'],
  },
  {
    id: 'ecommerce-open-api',
    name: '电商平台开放 API（淘宝/京东/抖店）',
    category: 'licensed-provider',
    status: 'planned',
    description: '二期接入的真实订单/商品/库存来源，保持 Connector 可插拔。',
    endpoints: ['平台开放 API（二期）'],
    cacheTtlSeconds: null,
    limitations: ['需要商家授权与凭据；当前未配置。'],
  },
  {
    id: 'erp-crawler-sources',
    name: 'ERP / 合规爬虫数据源',
    category: 'enrichment-provider',
    status: 'planned',
    description: '二期补齐库存深度、营销活动与履约口径的可选来源。',
    endpoints: ['ERP 导出 / 合规采集（二期）'],
    cacheTtlSeconds: null,
    limitations: ['需评估数据合规与字段质量。'],
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeProvider(value: unknown): CapabilityCenterDataProvider | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const name = typeof value.name === 'string' ? value.name : id;
  if (!id || !name) return null;
  return {
    id,
    name,
    category: typeof value.category === 'string' ? value.category : 'unknown',
    status: typeof value.status === 'string' ? value.status : 'unknown',
    description: typeof value.description === 'string' ? value.description : '',
    endpoints: asStringArray(value.endpoints),
    cacheTtlSeconds: typeof value.cache_ttl_seconds === 'number'
      ? value.cache_ttl_seconds
      : typeof value.cacheTtlSeconds === 'number'
      ? value.cacheTtlSeconds
      : null,
    limitations: asStringArray(value.limitations),
  };
}

async function fetchMarketRegistry(): Promise<{
  reachable: boolean;
  status: string;
  error: string | null;
  providers: CapabilityCenterDataProvider[];
}> {
  const degradation = getRuntimeDegradationConfig();
  if (!degradation.components.marketApi.enabled) {
    return {
      reachable: false,
      status: 'disabled-fallback',
      error: 'market API 已按降级配置停用，展示内置数据源注册表。',
      providers: FALLBACK_DATA_PROVIDERS,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const healthResponse = await fetch(`${MARKET_API_BASE_URL}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const registryResponse = await fetch(`${MARKET_API_BASE_URL}/api/v1/registry`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    const registry = await registryResponse.json().catch((): JsonRecord => ({}));
    const providerValues = isRecord(registry) && Array.isArray(registry.providers) ? registry.providers : [];
    const providers = providerValues.length
      ? providerValues.map(normalizeProvider).filter((provider): provider is CapabilityCenterDataProvider => Boolean(provider))
      : [];

    return {
      reachable: healthResponse.ok && registryResponse.ok,
      status: healthResponse.ok && registryResponse.ok ? 'online' : 'degraded',
      error: healthResponse.ok && registryResponse.ok ? null : `market API returned ${healthResponse.status}/${registryResponse.status}`,
      providers: providers.length ? providers : FALLBACK_DATA_PROVIDERS,
    };
  } catch (error) {
    return {
      reachable: false,
      status: 'offline',
      error: error instanceof Error ? error.message : String(error),
      providers: FALLBACK_DATA_PROVIDERS,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildReadiness(params: {
  status: string;
  missingSkills: string[];
  skillErrors: number;
  endpointCount: number;
}): CapabilityCenterItem['readiness'] {
  if (params.status === 'planned') {
    return {
      status: 'planned',
      score: Math.max(30, 70 - params.missingSkills.length * 8 - params.skillErrors * 6),
      summary: '规划能力，会降级到已验证执行能力。',
    };
  }
  if (params.missingSkills.length || params.skillErrors) {
    return {
      status: params.missingSkills.length ? 'blocked' : 'warning',
      score: Math.max(0, 88 - params.missingSkills.length * 14 - params.skillErrors * 7),
      summary: params.missingSkills.length
        ? `缺少 ${params.missingSkills.length} 个依赖 Skill。`
        : `${params.skillErrors} 个依赖 Skill 健康异常。`,
    };
  }
  if (!params.endpointCount) {
    return {
      status: 'warning',
      score: 78,
      summary: '能力可用，但未声明数据端点。',
    };
  }
  return {
    status: 'ready',
    score: 100,
    summary: '依赖 Skill、数据端点和产物契约已声明。',
  };
}

export async function getCapabilityCenterData(): Promise<CapabilityCenterData> {
  const degradation = getRuntimeDegradationConfig();
  const [skillsData, market] = await Promise.all([
    getSkillsDashboardData(),
    fetchMarketRegistry(),
  ]);
  const skillMap = new Map(skillsData.skills.map((skill) => [skill.id, skill]));
  const capabilities = serializeRetailCapabilities().map((capability): CapabilityCenterItem => {
    const requiredSkillIds = asStringArray(capability.requiredSkills);
    const requiredSkills = requiredSkillIds.flatMap((skillId) => {
      const skill = skillMap.get(skillId);
      if (!skill) return [];
      return [{
        id: skill.id,
        name: skill.name,
        version: skill.version,
        status: skill.status,
        health: skill.health.status,
      }];
    });
    const missingSkills = requiredSkillIds.filter((skillId) => !skillMap.has(skillId));
    const skillErrors = requiredSkills.filter((skill) => skill.health === 'error').length;
    const dataEndpoints = asStringArray(capability.dataEndpoints);
    return {
      id: capability.id,
      name: capability.name,
      shortName: capability.shortName,
      description: capability.description,
      inputHint: capability.inputHint,
      tags: capability.tags,
      status: capability.status,
      groupId: capability.groupId,
      agentType: capability.agentType,
      executionCapabilityId: capability.executionCapabilityId,
      requiredSkills,
      missingSkills,
      dataEndpoints,
      expectedArtifacts: asStringArray(capability.expectedArtifacts),
      validationRules: asStringArray(capability.validationRules),
      readiness: buildReadiness({
        status: capability.status,
        missingSkills,
        skillErrors,
        endpointCount: dataEndpoints.length,
      }),
    };
  });

  const summary = capabilities.reduce(
    (acc, capability) => {
      acc.capabilities += 1;
      if (capability.status === 'ready') acc.readyCapabilities += 1;
      if (capability.status === 'planned') acc.plannedCapabilities += 1;
      if (capability.readiness.status === 'blocked') acc.blockedCapabilities += 1;
      return acc;
    },
    {
      capabilities: 0,
      readyCapabilities: 0,
      plannedCapabilities: 0,
      blockedCapabilities: 0,
      skills: skillsData.totals.total,
      skillErrors: skillsData.totals.error,
      dataProviders: market.providers.length,
      availableProviders: market.providers.filter((provider) => provider.status === 'available').length,
      degradedProviders: market.providers.filter((provider) => provider.status === 'degraded').length,
      marketApiReachable: market.reachable,
    },
  );

  return {
    generatedAt: new Date().toISOString(),
    defaultCapabilityId: DEFAULT_RETAIL_CAPABILITY_ID,
    groups: RETAIL_CAPABILITY_GROUPS,
    summary,
    marketApi: {
      baseUrl: MARKET_API_BASE_URL,
      reachable: market.reachable,
      status: market.status,
      checkedAt: new Date().toISOString(),
      error: market.error,
    },
    degradation: {
      mode: degradation.mode,
      marketApiEnabled: degradation.components.marketApi.enabled,
      marketApiRequired: degradation.components.marketApi.required,
    },
    capabilities,
    dataProviders: market.providers,
  };
}
