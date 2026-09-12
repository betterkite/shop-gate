import type { CommerceEvalRuntimeOption } from './types';
import {
  LOCAL_QWEN_MODEL_ID,
  PI_AGENT_MODEL_DEFINITIONS,
} from '@/lib/constants/models';

export const DEFAULT_EVALUATOR_ID = 'rule-strict';
export const DEFAULT_EVAL_CONCURRENCY = 1;
export const MAX_EVAL_CONCURRENCY = 16;

export const EVAL_RUNTIME_OPTIONS: CommerceEvalRuntimeOption[] = [
  {
    cli: 'pi',
    label: 'PI Agent',
    defaultModel: LOCAL_QWEN_MODEL_ID,
    supportsReasoningEffort: false,
    models: PI_AGENT_MODEL_DEFINITIONS.map(({ id, name, description }) => ({ id, name, description })),
  },
];

export const EVAL_CAPABILITY_LABELS: Record<string, string> = {
  traffic_funnel: '流量漏斗',
  catalog_structure: '类目结构',
  price_inventory: '价格库存',
  daily_brief: '经营日报',
  comparison: '商品对比',
};

export const EVAL_TYPE_LABELS: Record<string, string> = {
  generated_project: '生成项目',
  clarification_required: '意图澄清',
  clarification_continuation: '澄清承接',
  runtime_registry: '运行时注册',
  repair_plan: '修复计划',
  source_degradation_contract: '信源降级',
  renderer_capability_contract: '渲染能力路由',
  security_policy_contract: '安全策略',
};
