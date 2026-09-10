import fs from 'fs/promises';
import path from 'path';

export type CommerceSkillStatus = 'stable' | 'planned' | 'deprecated';
export type CommerceSkillScope = 'workflow' | 'commerce' | 'input' | 'evidence' | 'platform' | 'visualization';

export interface CommerceCoreSkill {
  id: string;
  name: string;
  version: string;
  status: CommerceSkillStatus;
  scope?: CommerceSkillScope;
  boundary: string;
  inputs?: string[];
  outputs?: string[];
  scripts?: string[];
  references?: string[];
  endpoints?: string[];
  validation?: string[];
}

export interface CommerceSkillsRegistry {
  schemaVersion: 1;
  policy: {
    targetCoreSkillCount: number;
    packageFormat?: 'tgz';
    packageDir?: string;
    description: string;
  };
  coreSkills: CommerceCoreSkill[];
}

const REGISTRY_PATH = path.join(process.cwd(), '.pi', 'skills.registry.json');

const FALLBACK_CORE_SKILLS: CommerceCoreSkill[] = [
  {
    id: 'query-rewrite',
    name: '问题改写',
    version: '0.1.0',
    status: 'stable',
    scope: 'workflow',
    boundary: '把自然语言问题规范化为标的、周期、分析重点和澄清状态。',
  },
  {
    id: 'run-planner',
    name: '运行规划',
    version: '0.1.0',
    status: 'stable',
    scope: 'workflow',
    boundary: '意图澄清、任务拆解和 run_plan 生成。',
  },
  {
    id: 'commerce-data-registry',
    name: '商品数据注册与信源选择',
    version: '0.1.0',
    status: 'stable',
    scope: 'commerce',
    boundary: '查询商品、流量、订单和库存数据能力与信源选择。',
  },
  {
    id: 'commerce-entity-resolver',
    name: '商品解析',
    version: '0.1.0',
    status: 'stable',
    scope: 'commerce',
    boundary: '把商品名称、SKU 或商品编码解析为标准商品标识。',
  },
  {
    id: 'commerce-market-data',
    name: '经营数据',
    version: '0.1.0',
    status: 'stable',
    scope: 'commerce',
    boundary: '商品浏览、加购、购买、库存和 GMV 等经营数据。',
  },
  {
    id: 'data-quality',
    name: '数据质量',
    version: '0.1.0',
    status: 'stable',
    scope: 'evidence',
    boundary: '生成来源、质量和限制证据。',
  },
  {
    id: 'dashboard-visualization',
    name: '可视化看板',
    version: '0.1.0',
    status: 'stable',
    scope: 'visualization',
    boundary: '基于 final 数据生成 Next.js 看板。',
  },
];

const FALLBACK_REGISTRY: CommerceSkillsRegistry = {
  schemaVersion: 1,
  policy: {
    targetCoreSkillCount: 11,
    packageFormat: 'tgz',
    packageDir: '.pi/skill-packages',
    description: 'Fallback Shop Gate skills registry.',
  },
  coreSkills: FALLBACK_CORE_SKILLS,
};

let cachedRegistry: { mtimeMs: number; value: CommerceSkillsRegistry } | null = null;

function asRegistry(value: unknown): CommerceSkillsRegistry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const registry = value as CommerceSkillsRegistry;
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.coreSkills)) {
    return null;
  }

  return registry;
}

export async function readCommerceSkillsRegistry(): Promise<CommerceSkillsRegistry> {
  try {
    const stat = await fs.stat(REGISTRY_PATH);
    if (cachedRegistry?.mtimeMs === stat.mtimeMs) {
      return cachedRegistry.value;
    }
    const content = await fs.readFile(REGISTRY_PATH, 'utf8');
    const parsed = asRegistry(JSON.parse(content));
    if (!parsed) {
      throw new Error('registry schema is invalid');
    }
    cachedRegistry = { mtimeMs: stat.mtimeMs, value: parsed };
    return parsed;
  } catch (error) {
    if (process.env.SHOPGATE_ALLOW_SKILLS_REGISTRY_FALLBACK === '1') {
      return FALLBACK_REGISTRY;
    }
    throw new Error(
      `Skills registry 不可用，已按 fail-closed 策略停止运行：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function getCoreCommerceSkillIds(registry: CommerceSkillsRegistry): string[] {
  return registry.coreSkills.map((skill) => skill.id);
}

export function getDefaultCommerceSkillIds(registry: CommerceSkillsRegistry): string[] {
  return registry.coreSkills
    .filter((skill) => skill.status === 'stable')
    .map((skill) => skill.id);
}

export function getCommerceSkillPackagePath(registry: CommerceSkillsRegistry, skillId: string): string {
  const packageDir = registry.policy.packageDir ?? '.pi/skill-packages';
  return path.join(process.cwd(), packageDir, `${skillId}.tgz`);
}

export function describeCommerceSkillsForPrompt(registry: CommerceSkillsRegistry): string {
  const coreLines = registry.coreSkills.map((skill) => {
    const scriptText = skill.scripts?.length ? `；脚本：${skill.scripts.join(', ')}` : '';
    const referenceText = skill.references?.length ? `；参考：${skill.references.join(', ')}` : '';
    return `- ${skill.id}（${skill.name}，${skill.status}，v${skill.version}）：${skill.boundary}${scriptText}${referenceText}`;
  });

  return [
    'Shop Gate skills 治理：',
    `- 目标核心 skill 数量：${registry.policy.targetCoreSkillCount}`,
    `- 规则：${registry.policy.description}`,
    ...coreLines,
  ].join('\n');
}
