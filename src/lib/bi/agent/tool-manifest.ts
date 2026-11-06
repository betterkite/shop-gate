import { z } from 'zod';
import { biAgentAnswerSchema, biAgentQuerySchema } from './result-contracts';

export const resultPage = z.object({ evidence_id: z.string().uuid(), page: z.number().int().min(1).max(1_000_000).default(1) }).strict();
export const empty = z.object({}).strict();

export const BI_AGENT_TOOL_DEFINITIONS = [
    { name: 'metric_dictionary', schema: empty,
      description: '读取当前账本的指标中文名称、公式、单位和缺失处理；以它说明口径，不自行发明利润公式。' },
    { name: 'query_ledger', schema: biAgentQuerySchema,
      description: '分析当前页面的固定数据集/版本/对象范围。返回全范围合计、完整证据和前20行预览，display字段与页面格式一致；全表已保存。上一周期使用period="previous"由系统计算紧邻等长期间；自定义日期提供start/end/reason。其他页面筛选保持。' },
    { name: 'read_result_page', schema: resultPage,
      description: '按每页20行读取本次分析已保存的完整查询结果。预览不是全量；超过20个对象可继续查看其他页。' },
    { name: 'submit_answer', schema: biAgentAnswerSchema,
      description: '提交面向用户的中文回答。事实必须引用本轮实际返回的evidence_ids。表格/图表只能引用这些证据和已查询指标。缺数据或必要歧义可明确说明；不可把缺失值当0，不改写经营页面。' },
  ] as const;
