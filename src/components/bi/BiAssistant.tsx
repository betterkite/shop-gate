'use client';
import { BiDefinitionEvidence, BiEvidenceTable } from './BiAssistantEvidence';
import React, { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { BI_PANEL, BI_SELECT, BiNotice, BiPagination } from './BiPrimitives';
import { type Dataset } from '@/lib/bi/data-contracts';
import { overviewQuery, type Overview, type OverviewLocation } from '@/lib/bi/overview-contracts';
import { biAgentSubmissionSchema, type BiAgentSubmission } from '@/lib/bi/agent/contracts';
import { type BiAgentAnswerContent } from '@/lib/bi/agent/result-contracts';
import { BiAnswerMarkdown } from './BiAnswerMarkdown';
import { BiAssistantChart } from './BiAssistantChart';
import { AgentRequestError, ACTIVE_AGENT_STATUSES, AGENT_STATUS_LABELS, agentAcceptedSchema, agentAnswerSchema,
  agentAvailabilitySchema, agentConversationsSchema, agentQuestionsSchema, agentResultSchema, readAgent } from '@/lib/bi/agent/browser';

type Navigate = (change: Partial<OverviewLocation>) => void;
const message = (error: unknown) => error instanceof Error ? error.message : '请求未完成，请稍后重试。';
export function BiAssistant({ workspaceId, dataset, location, navigate, resolvedRange }: {
  workspaceId: string; dataset: Dataset; location: OverviewLocation; navigate: Navigate; resolvedRange: Overview['range'] | null;
}) {
  const [availability, setAvailability] = useState<z.infer<typeof agentAvailabilitySchema> | null>(null);
  const [directory, setDirectory] = useState<z.infer<typeof agentConversationsSchema> | null>(null);
  const [history, setHistory] = useState<z.infer<typeof agentQuestionsSchema> | null>(null);
  const [error, setError] = useState(''), [historyError, setHistoryError] = useState('');
  const [text, setText] = useState(''), [model, setModel] = useState<BiAgentSubmission['model']>('deepseek-v4-flash');
  const [intent, setIntent] = useState<BiAgentSubmission | null>(null), [sending, setSending] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const alive = useRef(true), sendingLock = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const conversationId = location.conversationId, questionPage = location.questionPage ?? 1, directoryPage = location.conversationPage ?? 1;
  useEffect(() => {
    const controller = new AbortController(); setAvailability(null);
    readAgent({ action: 'availability', workspace_id: workspaceId }, agentAvailabilitySchema, { signal: controller.signal })
      .then((data) => {
        if (data.workspace_id !== workspaceId) throw new Error('助手工作空间不一致，请刷新。');
        if (!controller.signal.aborted) { setAvailability(data); setModel((current) => data.models.some((m) => m.id === current) ? current : data.models[0]?.id ?? current); }
      }).catch((e) => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [workspaceId, refresh]);
  useEffect(() => {
    const controller = new AbortController(); setDirectory(null);
    readAgent({ action: 'conversations', workspace_id: workspaceId, dataset_id: dataset.dataset_id, page: String(directoryPage) }, agentConversationsSchema, { signal: controller.signal })
      .then((data) => {
        if (data.workspace_id !== workspaceId || data.dataset_id !== dataset.dataset_id) throw new Error('历史对话的数据集不一致，请刷新。');
        if (!controller.signal.aborted) setDirectory(data);
      }).catch((e) => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [workspaceId, dataset.dataset_id, directoryPage, refresh]);
  useEffect(() => {
    setHistory(null); setHistoryError('');
    if (!conversationId) return;
    const controller = new AbortController(); let busy = false;
    const load = async () => {
      if (busy) return; busy = true;
      try {
        const data = await readAgent({ action: 'questions', workspace_id: workspaceId,
          conversation_id: conversationId, page: String(questionPage) }, agentQuestionsSchema, { signal: controller.signal });
        if (data.conversation.id !== conversationId || data.conversation.scope.workspaceId !== workspaceId
            || data.conversation.scope.datasetId !== dataset.dataset_id) throw new Error('此对话属于其他数据范围，请选择当前数据集的对话。');
        if (!controller.signal.aborted) { setHistory(data); setHistoryError(''); }
      } catch (e) { if (!controller.signal.aborted) { setHistory(null); setHistoryError(message(e)); } }
      finally { busy = false; }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 2500);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [workspaceId, dataset.dataset_id, conversationId, questionPage, refresh]);
  async function send() {
    if (sendingLock.current || (!intent && !resolvedRange)) return; sendingLock.current = true; setSending(true); setError('');
    try {
      const submission = intent ?? biAgentSubmissionSchema.parse({ workspace_id: workspaceId, dataset_id: dataset.dataset_id,
        dataset_version: dataset.version, conversation_id: conversationId ?? crypto.randomUUID(),
        expected_conversation_version: history?.conversation.version ?? 0, idempotency_key: crypto.randomUUID(),
        instruction: text, model, page_scope: { module: 'overview', ...overviewQuery({ ...location, start: resolvedRange?.start ?? undefined, end: resolvedRange?.end ?? undefined }) } });
      setIntent(submission);
      const accepted = await readAgent({}, agentAcceptedSchema, { method: 'POST', body: JSON.stringify({ action: 'submit', question: submission }) });
      if (!alive.current) return;
      if (accepted.conversation_id !== submission.conversation_id) throw new Error('提交结果的对话不一致，请使用原问题重试。');
      setIntent(null); setText(''); setRefresh((n) => n + 1);
      navigate({ conversationId: accepted.conversation_id, questionPage: Math.max(1, Math.ceil(accepted.conversation_version / 20)) });
    } catch (e) {
      if (!alive.current) return;
      if (e instanceof AgentRequestError && ((e.status >= 400 && e.status < 500) || e.code === 'BI_AGENT_MODEL_UNAVAILABLE')) setIntent(null);
      setError(message(e));
    }
    finally { sendingLock.current = false; if (alive.current) setSending(false); }
  }
  async function cancel(runId: string) {
    try {
      await readAgent({}, z.object({ id: z.string().uuid(), status: z.string() }), { method: 'POST',
        body: JSON.stringify({ action: 'cancel', workspace_id: workspaceId, run_id: runId }) });
      setRefresh((n) => n + 1);
    } catch (e) { setError(message(e)); }
  }
  const ready = Boolean(resolvedRange) && availability?.can_run && availability.worker_available && availability.models.some((m) => m.id === model);
  return <section className={`${BI_PANEL} border-primary/25`} aria-label="经营助手">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-xl font-semibold">经营助手</h3>
      <p className="mt-2 text-sm text-muted-foreground">围绕当前数据提问，答案附上可查看的依据。对话仅自己可见。</p></div>
      <Button variant="outline" onClick={() => { setError(''); setRefresh((n) => n + 1); }}>刷新助手状态</Button></div>
    <details className="mt-4 rounded-xl border border-border p-3"><summary className="cursor-pointer text-sm">查看历史对话</summary>
      <ul className="mt-3 space-y-2">{directory?.rows.map((row) => <li key={row.id}><button disabled={sending || Boolean(intent)}
        className={`w-full rounded-lg border p-3 text-left text-sm ${row.id === conversationId ? 'border-primary bg-primary/5' : 'border-border'}`}
        onClick={() => navigate({ conversationId: row.id, questionPage: Math.max(1, Math.ceil(row.version / 20)) })}>{row.title}</button></li>)}</ul>
      {directory?.total === 0 && <p className="mt-3 text-sm text-muted-foreground">此数据集还没有你的分析对话。</p>}
      {directory && <BiPagination label="助手历史对话分页" page={directoryPage} total={directory.total} change={(conversationPage) => navigate({ conversationPage })} />}
    </details>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-medium">{history?.conversation.title ?? '新对话'}</p>
      <Button size="sm" variant="outline" disabled={sending || Boolean(intent)} onClick={() => { setText(''); navigate({ conversationId: undefined, questionPage: 1 }); }}>开始新对话</Button></div>
    {historyError && <div className="mt-3"><BiNotice error>{historyError}</BiNotice></div>}
    {conversationId && !history && !historyError && <p role="status" className="mt-4 text-sm">正在读取对话…</p>}
    <div className="mt-4 space-y-5">{history?.rows.map((q) => <article key={q.id} className="min-w-0 rounded-xl border border-border p-4">
      <p className="whitespace-pre-wrap break-words font-medium">{q.instruction}</p>
      <p className="mt-2 text-xs text-muted-foreground">提问时数据版本 {q.datasetVersion} · {q.pageScope.start ?? '按可用数据日期'} 至 {q.pageScope.end ?? '最新可用日期'} · {q.pageScope.refund_basis === 'payment' ? '按原付款日期统计退款' : '按退款发生日期统计'}{q.datasetVersion !== dataset.version ? ' · 历史答案，未随新数据重算' : ''}</p>
      {q.runs.map((r) => <div className="mt-3" key={r.id}>
        <div className="flex items-center gap-3 text-sm text-muted-foreground"><span role="status">{AGENT_STATUS_LABELS[r.status] ?? '正在确认分析状态'}</span>
          {ACTIVE_AGENT_STATUSES.includes(r.status) && <Button size="sm" variant="outline" disabled={Boolean(r.cancelRequestedAt)} onClick={() => { void cancel(r.id); }}>{r.cancelRequestedAt ? '正在取消' : '取消分析'}</Button>}</div>
        {r.status === 'completed' && <AssistantAnswer workspaceId={workspaceId} datasetId={dataset.dataset_id} version={q.datasetVersion} runId={r.id} onFollowUp={(value) => { if (!intent) setText(value); }} />}
      </div>)}
    </article>)}</div>
    {history && <BiPagination label="助手问题分页" page={questionPage} total={history.total} change={(page) => navigate({ questionPage: page })} />}
    <form className="mt-5 rounded-xl bg-primary/5 p-4" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <p className="mb-3 text-xs leading-6 text-muted-foreground">下一次提问使用：{dataset.name} · 版本 {dataset.version} · {resolvedRange ? `${resolvedRange.start ?? '暂无经营日期'} 至 ${resolvedRange.end ?? '暂无经营日期'}` : '正在确认与总览一致的日期范围'}，并继承上方已选平台、店铺和商品。仅点击发送会调用模型。</p>
      <label className="block text-sm font-medium" htmlFor="bi-assistant-question">你想了解什么？</label>
      <textarea id="bi-assistant-question" className="mt-2 min-h-28 w-full rounded-lg border border-input bg-background p-3 text-sm" maxLength={8000}
        value={text} disabled={Boolean(intent)} onChange={(e) => setText(e.target.value)} placeholder="例如：当前范围的净销售额是多少？哪些店铺贡献较多？" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><label className="text-sm">分析模型 <select className={BI_SELECT} value={model} disabled={Boolean(intent)} onChange={(e) => setModel(biAgentSubmissionSchema.shape.model.parse(e.target.value))}>
        {!availability?.models.length && <option value={model}>尚无可用模型</option>}{availability?.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <Button type="submit" disabled={sending || (!intent && (!ready || !text.trim() || Boolean(conversationId && !history) || Boolean(historyError)))}>{sending ? '正在提交…' : intent ? '重试原问题' : '发送问题'}</Button></div>
      {availability && !ready && <p className="mt-3 text-sm text-muted-foreground">{!resolvedRange ? '正在确认页面数据范围。' : !availability.can_run ? '当前账号没有发起分析的权限。' : !availability.worker_available ? '助手处理服务暂未启动。' : '尚未配置可用模型。'}经营页面和已有分析仍可查看。</p>}
      {intent && !sending && <div className="mt-3 text-xs text-muted-foreground"><p>提交结果尚未确认，原问题已保留；重试不会重复创建分析。</p><Button size="sm" variant="link" onClick={() => navigate({ conversationId: intent.conversation_id, questionPage: Math.max(1, Math.ceil((intent.expected_conversation_version + 1) / 20)) })}>查看原对话状态</Button></div>}
    </form>
    {error && <div className="mt-3"><BiNotice error>{error}</BiNotice></div>}
  </section>;
}

function AssistantAnswer({ workspaceId, datasetId, version, runId, onFollowUp }: {
  workspaceId: string; datasetId: string; version: number; runId: string; onFollowUp: (value: string) => void;
}) {
  const [answer, setAnswer] = useState<BiAgentAnswerContent | null>(null), [error, setError] = useState('');
  const [definitions, setDefinitions] = useState<z.infer<typeof agentAnswerSchema>['definitions']>(null);
  useEffect(() => {
    const controller = new AbortController();
    readAgent({ action: 'answer', workspace_id: workspaceId, run_id: runId }, agentAnswerSchema, { signal: controller.signal })
      .then((data) => { if (data.dataset_version !== version || !data.answer) throw new Error('答案版本不一致，请刷新对话。'); if (!controller.signal.aborted) { setAnswer(data.answer); setDefinitions(data.definitions); } })
      .catch((e) => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [workspaceId, version, runId]);
  if (error) return <BiNotice error>{error}</BiNotice>;
  if (!answer) return <p className="mt-3 text-sm">正在读取答案…</p>;
  return <div className="mt-4 space-y-4"><BiAnswerMarkdown text={answer.text} />
    {definitions && <BiDefinitionEvidence evidence={definitions} />}
    {answer.views.filter((view) => view.kind !== 'table').map((view, i) => <BiAssistantChart key={`${view.result_id}:${view.metric}:${i}`} workspaceId={workspaceId} datasetId={datasetId} version={version} runId={runId} view={view} />)}
    {answer.evidence_ids.map((id, i) => <AssistantEvidence key={id} workspaceId={workspaceId} datasetId={datasetId} version={version} runId={runId} resultId={id} number={i + 1} />)}
    {answer.follow_up.length > 0 && <div className="flex flex-wrap gap-2">{answer.follow_up.map((value) => <Button key={value} size="sm" variant="outline" className="h-auto whitespace-normal text-left" onClick={() => onFollowUp(value)}>{value}</Button>)}</div>}
  </div>;
}
function AssistantEvidence({ workspaceId, datasetId, version, runId, resultId, number }: {
  workspaceId: string; datasetId: string; version: number; runId: string; resultId: string; number: number;
}) {
  const [page, setPage] = useState(1), [data, setData] = useState<z.infer<typeof agentResultSchema> | null>(null), [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(); setData(null); setError('');
    readAgent({ action: 'result', workspace_id: workspaceId, run_id: runId, result_id: resultId, page: String(page) }, agentResultSchema, { signal: controller.signal })
      .then((value) => {
        if (value.evidence_id !== resultId || value.metadata.workspace_id !== workspaceId || value.metadata.dataset_id !== datasetId || value.metadata.version !== version) throw new Error('依据的范围或版本不一致，请刷新。');
        if (!controller.signal.aborted) setData(value);
      }).catch((e) => { if (!controller.signal.aborted) setError(message(e)); });
    return () => controller.abort();
  }, [workspaceId, datasetId, version, runId, resultId, page, open]);
  return <details className="min-w-0 rounded-lg border border-border p-3" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary className="cursor-pointer text-sm font-medium">查看依据 {number}{data ? ` · 共 ${data.total} 项` : ''}</summary>
    {error && <BiNotice error>{error}</BiNotice>}{!data && !error && <p className="mt-3 text-sm">正在读取依据…</p>}
    {data && <><p className="mt-3 text-xs text-muted-foreground">版本 {version} · {data.metadata.range.start ?? '无日期'} 至 {data.metadata.range.end ?? '无日期'} · {data.metadata.range.refund_basis === 'payment' ? '按原付款日期统计退款' : '按退款发生日期统计退款'}。保留提问时的查询结果。</p>
      <BiEvidenceTable data={data} />
      <BiPagination label={`分析依据 ${number} 分页`} page={page} total={data.total} change={setPage} /></>}
  </details>;
}
