export type QuestionMode = 'act' | 'chat';

export const QUESTION_MODE_COPY: Record<QuestionMode, {
  label: string;
  description: string;
  outputLabel: string;
}> = {
  act: {
    label: '生成看板',
    description: '获取真实数据并生成可交付看板',
    outputLabel: '生成交互看板',
  },
  chat: {
    label: '只做问答',
    description: '只回答问题，不修改当前看板',
    outputLabel: '只做分析问答',
  },
};

export const QUESTION_COMPOSER_COPY = {
  defaultPlaceholder: '向 Shop Gate 描述你的经营分析需求...',
  runningPlaceholder: '补充要求将在当前任务结束后自动执行…',
  modelRewriteTitle: '提交后由所选大模型解析',
  modelRewriteHelper: '输入阶段不做关键词预判',
  literalTarget: '标的原文保真',
  resolverVerification: 'Resolver 校验商品/类目实体',
  advancedSettings: '高级',
  advancedSettingsDescription: '执行引擎与模型设置',
} as const;

const CHAT_ONLY_EXECUTION_CONSTRAINT = "Do not modify code or generate a dashboard. Only answer the user's request with evidence.";

export function buildQuestionInstruction(question: string, mode: QuestionMode): string {
  const visibleQuestion = question.trim();
  return mode === 'chat'
    ? `${visibleQuestion}\n\n${CHAT_ONLY_EXECUTION_CONSTRAINT}`
    : visibleQuestion;
}

export function questionOutputLabel(mode: QuestionMode): string {
  return QUESTION_MODE_COPY[mode].outputLabel;
}

export function buildQuickQuestions(projectName = ''): string[] {
  const exactProjectName = projectName.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const subject = exactProjectName.length >= 2 && exactProjectName.length <= 16 &&
    !/[，,。！？?；;\n]/u.test(exactProjectName)
    ? exactProjectName
    : '当前店铺/商品';
  return [
    `分析${subject}近7天的流量、加购和购买转化`,
    `对比${subject}各类目和商品的GMV贡献及集中度`,
    `检查${subject}的价格带、库存和滞销风险`,
    `生成${subject}经营日报，指出异常并给出行动建议`,
  ];
}
