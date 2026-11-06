// Display state only. Result access is still authorized by the server for each read.
import { z } from 'zod';

const uuid = z.string().uuid();
const page = z.number().int().min(1).max(1_000_000);
const entry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evidence'), run: uuid, result: uuid, page, open: z.boolean() }).strict(),
  z.object({ kind: z.literal('chart'), run: uuid, result: uuid,
    metric: z.string().regex(/^[a-z_]{1,40}$/), page }).strict(),
  z.object({ kind: z.literal('definition'), run: uuid, open: z.boolean() }).strict(),
]);
export type AssistantViewState = z.infer<typeof entry>;
export function assistantViewKey(value: AssistantViewState) {
  return value.kind === 'definition' ? `${value.run}:definition`
    : `${value.run}:${value.result}:${value.kind}${value.kind === 'chart' ? `:${value.metric}` : ''}`;
}
const states = z.array(entry).max(64).refine((values) => new Set(values.map(assistantViewKey)).size === values.length);
export function readAssistantViews(raw: string | null): AssistantViewState[] {
  if (raw === null) return [];
  try {
    if (raw.length > 12_000 || encodeURIComponent(raw).length > 6_000) throw new Error();
    return states.parse(JSON.parse(raw));
  } catch { throw new Error('助手查看链接无效或过长，请重新选择对话。'); }
}
export function updateAssistantView(current: AssistantViewState[] | undefined, next: AssistantViewState): AssistantViewState[] {
  const keep = next.kind === 'chart' ? next.page !== 1 : next.kind === 'definition' ? next.open : next.open || next.page !== 1;
  const values = [...(current ?? []).filter((value) => assistantViewKey(value) !== assistantViewKey(next)), ...(keep ? [next] : [])];
  try { return readAssistantViews(JSON.stringify(values)); }
  catch { throw new Error('已保存的查看位置过多，请关闭部分依据或开始新对话后重试。'); }
}
export function findAssistantView<T extends AssistantViewState>(values: AssistantViewState[] | undefined, fallback: T): T {
  return (values?.find((value) => assistantViewKey(value) === assistantViewKey(fallback)) ?? fallback) as T;
}
