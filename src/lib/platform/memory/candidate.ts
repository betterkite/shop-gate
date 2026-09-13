import type { PersonalMemoryPreferenceKey, PersonalMemoryScope } from './candidate-types';

export const PERSONAL_MEMORY_CANDIDATE_CONTRACT =
  'shopgate-personal-memory-candidate/v1' as const;

export interface PersonalMemoryCandidate {
  contract: typeof PERSONAL_MEMORY_CANDIDATE_CONTRACT;
  key: PersonalMemoryPreferenceKey;
  value: string;
  scope: PersonalMemoryScope;
  reason: string;
}

const STABLE_INTENT = /(?:以后|今后|后续|从现在起|每次|默认|始终|一直|总是|请记住|帮我记住|我的偏好是|我(?:更)?偏好|我(?:更)?喜欢|回答时|输出时|分析时|研究时)/;
const EPHEMERAL_ONLY = /^(?:这次|本次|这一轮|当前任务|今天|现在)(?!以后|起)/;
const CONTROL_OR_EXECUTION = /(?:授权|权限|角色|管理员|密码|口令|token|令牌|密钥|secret|绕过|忽略规则|自动调价|自动补货|自动改库存|自动下单)/i;

const CLASSIFIERS: ReadonlyArray<{
  key: PersonalMemoryPreferenceKey;
  reason: string;
  pattern: RegExp;
}> = [
  {
    key: 'analysis.risk_style',
    reason: '识别到稳定的风险表达偏好',
    pattern: /(?:风险|不确定性|回撤|风险提示|风险因素|谨慎|保守)/,
  },
  {
    key: 'analysis.evidence_style',
    reason: '识别到稳定的证据与数据时点偏好',
    pattern: /(?:证据|出处|来源|引用|数据时点|数据日期|可验证|可信度)/,
  },
  {
    key: 'output.detail_level',
    reason: '识别到稳定的回答详略偏好',
    pattern: /(?:简洁|简短|精简|详细|详尽|展开说明|篇幅|字数)/,
  },
  {
    key: 'output.visual_style',
    reason: '识别到稳定的图表与呈现偏好',
    pattern: /(?:图表|可视化|表格|趋势图|图形|仪表盘|看板呈现)/i,
  },
  {
    key: 'analysis.default_period',
    reason: '识别到稳定的分析周期偏好',
    pattern: /(?:(?:分析|经营|复盘).{0,8}(?:周期|时间范围|时间段)|日|周|月|季度).{0,8}(?:分析|查看|汇总)?/,
  },
  {
    key: 'output.answer_style',
    reason: '识别到稳定的回答结构偏好',
    pattern: /(?:先.{0,12}(?:结论|摘要)|回答.{0,12}(?:结构|格式)|分点|条列|结论先行|先说结论|先.+再.+)/,
  },
];

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Finds only high-confidence, low-risk personalization candidates. This is a
 * local UX hint: detection never writes to the independent Memory service.
 */
export function detectPersonalMemoryCandidate(instruction: string): PersonalMemoryCandidate | null {
  const value = normalizedText(instruction);
  if (
    value.length < 4
    || value.length > 1_024
    || !STABLE_INTENT.test(value)
    || EPHEMERAL_ONLY.test(value)
    || CONTROL_OR_EXECUTION.test(value)
  ) {
    return null;
  }

  const classifier = CLASSIFIERS.find((candidate) => candidate.pattern.test(value));
  if (!classifier) return null;

  return {
    contract: PERSONAL_MEMORY_CANDIDATE_CONTRACT,
    key: classifier.key,
    value,
    scope: 'project',
    reason: classifier.reason,
  };
}
