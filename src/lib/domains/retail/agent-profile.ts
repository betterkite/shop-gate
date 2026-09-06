import type { PiAgentSkillCapabilityDescriptor } from '@/lib/agent/skills';
import type {
  DataAgentCapabilityDescriptor,
  DataAgentDomainPack,
  DataAgentProfile,
} from '@/lib/data-agent';
import {
  DataAgentRegistry,
  NEXT_DASHBOARD_DELIVERY_PACK,
} from '@/lib/data-agent';
import {
  DEFAULT_RETAIL_CAPABILITY_ID,
  getRetailCapability,
  RETAIL_CAPABILITIES,
} from './capabilities';

export const RETAIL_DOMAIN_PACK_ID = 'retail.core';

/**
 * 零售默认 Profile。注意：在 P3 切换完成前，`src/lib/config/data-agent.ts`
 * 的 DEFAULT_DATA_AGENT_PROFILE_ID 仍指向 finance Profile（'shopgate.finance-research'）；
 * 两个包在切换提交前可以并存编译，运行时注册只发生在被 import 的那一侧。
 */
export const RETAIL_AGENT_PROFILE_ID = 'shopgate.retail-ops';

function operationId(endpoint: string): string {
  const normalized = endpoint
    .toLowerCase()
    .replace(/^get\s+/, '')
    .replace(/\{[^}]+\}/g, 'entity')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
  return `retail.commerce-data.${normalized}`;
}

function capabilityDescriptor(
  capability: (typeof RETAIL_CAPABILITIES)[number],
): DataAgentCapabilityDescriptor {
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    status: capability.status,
    domainPackId: RETAIL_DOMAIN_PACK_ID,
    requiredSkillIds: [...capability.requiredSkills],
    requiredConnectorOperationIds: capability.dataEndpoints.map(operationId),
    supportedOutputs: ['answer', 'dashboard', 'report'],
  };
}

const connectorOperations = Array.from(new Set(
  RETAIL_CAPABILITIES.flatMap((capability) => capability.dataEndpoints),
)).map((endpoint) => ({
  id: operationId(endpoint),
  title: endpoint,
  description: `Shop Gate commerce-data operation ${endpoint}`,
  effect: 'read' as const,
  inputSchema: { type: 'object', additionalProperties: false },
}));

export const RETAIL_DOMAIN_PACK: DataAgentDomainPack = {
  id: RETAIL_DOMAIN_PACK_ID,
  version: '1.0.0',
  name: 'Retail Commerce',
  description:
    '商品/类目实体解析、流量转化漏斗、类目结构、价格库存（合成口径）和经营日报能力。',
  capabilities: RETAIL_CAPABILITIES.map(capabilityDescriptor),
  resolverIds: ['retail.entity-resolver'],
  connectors: [{
    id: 'retail.commerce-data',
    version: '1.0.0',
    domain: RETAIL_DOMAIN_PACK_ID,
    operations: connectorOperations,
  }],
  skillIds: Array.from(new Set(
    RETAIL_CAPABILITIES.flatMap((capability) => capability.requiredSkills),
  )),
  toolNames: [
    'commerce_api_get',
    'commerce_extract_uploaded_image',
    'inspect_dashboard_contract',
    'apply_dashboard_spec',
  ],
  validatorIds: [
    'retail.entity-consistency',
    'retail.synthetic-price-transparency',
    'retail.time-window-consistency',
    'retail.answer-only-intent',
  ],
  visualizationProfileIds: [
    'funnel-analysis',
    'catalog-structure',
    'price-inventory',
    'daily-brief',
  ],
};

export const RETAIL_AGENT_PROFILE: DataAgentProfile = {
  id: RETAIL_AGENT_PROFILE_ID,
  version: '1.0.0',
  name: 'Shop Gate Retail Operations',
  domainPackIds: [RETAIL_DOMAIN_PACK_ID],
  defaultCapabilityId: DEFAULT_RETAIL_CAPABILITY_ID,
  deliveryPackId: 'workspace.next-dashboard',
  memoryPolicyId: 'shopgate.personalization',
  knowledgePolicyId: 'shopgate.governed-knowledge',
};

export function createRetailDataAgentRegistry(): DataAgentRegistry {
  return new DataAgentRegistry()
    .registerDeliveryPack(NEXT_DASHBOARD_DELIVERY_PACK)
    .registerDomainPack(RETAIL_DOMAIN_PACK)
    .registerProfile(RETAIL_AGENT_PROFILE);
}

export function resolveRetailDataAgentProfile(
  profileId = RETAIL_AGENT_PROFILE_ID,
) {
  return createRetailDataAgentRegistry().resolveProfile(profileId);
}

export function getRetailSkillCapabilityDescriptor(
  capabilityId?: string | null,
): PiAgentSkillCapabilityDescriptor {
  const capability = getRetailCapability(capabilityId);
  return {
    id: capability.id,
    status: capability.status,
    requiredSkillIds: [...capability.requiredSkills],
  };
}
