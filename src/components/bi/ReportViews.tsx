'use client';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { REPORT_NAMES, reportOptions, reportTable, restoreReport, viewChange, viewList, type ReportView } from '@/lib/bi/report-contracts';
import type { OverviewLocation } from '@/lib/bi/overview-contracts';
import { updateAssistantView } from '@/lib/bi/agent/view-location';
import { AssistantAnswer } from './BiAssistant';
import { BI_PANEL, BiNotice, BiPagination } from './BiPrimitives';

type Scope = { workspace_id: string; dataset_id: string; version: number };
type Navigate = (change: Partial<OverviewLocation>) => void;

export function ReportViews({ scope, options, table, location, navigate }: { scope: Scope; options: ReturnType<typeof reportOptions>;
  table: z.infer<typeof reportTable> | null; location: OverviewLocation; navigate: Navigate }) {
  const [list, setList] = useState<z.infer<typeof viewList> | null>(null), [saved, setSaved] = useState<ReportView | null>(null);
  const [busy, setBusy] = useState(false), [name, setName] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editing, setEditing] = useState<{ row: ReportView; action: 'rename' | 'delete' } | null>(null);
  const [reload, setReload] = useState(0);
  const intent = useRef<{ digest: string; id: string } | null>(null);
  const body = JSON.stringify({ ...scope, options: { action: 'list', page: location.viewsPage || 1 } });
  const selected = location.savedTopic ? JSON.stringify({ ...scope, options: { action: 'list', view_id: location.savedTopic } }) : null;
  useEffect(() => {
    const c = new AbortController();
    setList(null); setSaved(null); setError('');
    void Promise.all([readBi('/api/bi/reports/views', viewList, {method:'POST',body,signal:c.signal}),
      selected ? readBi('/api/bi/reports/views', viewList, {method:'POST',body:selected,signal:c.signal}) : null])
      .then(([data,item]) => { if (!c.signal.aborted) { setList(data); setSaved(item?.rows[0] ?? null);
        if (item && !item.rows.length) setNotice('此专题已删除或无法访问。'); } })
      .catch(e => { if (!c.signal.aborted) setError(dataErrorMessage(e)); });
    return () => c.abort();
  }, [body,selected,reload]);
  async function submit(action: 'create' | 'rename' | 'delete', row?: ReportView) {
    if (busy || (action !== 'delete' && !name.trim()) || (action === 'create' && !table)) return;
    setError(''); setBusy(true);
    try {
      const config = { ...options, query: { ...options.query, start: table?.range.start, end: table?.range.end }, page: 1 };
      const digest = JSON.stringify([scope,config,name]);
      if (action === 'create' && intent.current?.digest !== digest) intent.current = { digest, id: crypto.randomUUID() };
      const mutation = action === 'create' ? { action, view_id: intent.current!.id, name, options: config }
        : { action, view_id: row!.view_id, revision: row!.revision, ...(action === 'rename' && {name}) };
      await readBi('/api/bi/reports/views', viewChange, {method:'POST',body:JSON.stringify({...scope,options:mutation})});
      setNotice(action === 'delete' ? '已删除。' : '已保存。'); setEditing(null); setName(''); intent.current=null;
      if (action === 'delete' && location.savedTopic === row?.view_id) navigate({ savedTopic: undefined });
      if (action === 'delete' && list?.rows.length === 1 && list.page > 1) navigate({viewsPage:list.page-1});
      else if (action === 'create' && (location.viewsPage ?? 1) !== 1) navigate({viewsPage:1});
      setReload(v => v+1);
    } catch(e) { setError(dataErrorMessage(e)); }
    finally { setBusy(false); }
  }
  return <section className={BI_PANEL}><h2 className="text-lg font-semibold">我的报表视图与专题</h2>
    <p className="my-2 text-sm text-muted-foreground">视图保存日期、筛选、列和排序，再次打开时读取当前数据。专题同时保留提问时的回答和依据。</p>
    <form className="my-3 flex flex-wrap gap-2" onSubmit={e => {e.preventDefault(); void submit(editing?.action ?? 'create',editing?.row);}}>
      {editing?.action === 'delete' ? <span>确认删除“{editing.row.name}”？</span> :
        <Input className="max-w-sm" aria-label="报表视图名称" value={name} onChange={e => setName(e.target.value)} maxLength={120} placeholder="例如 七月各店净销售额" />}
      <Button type="submit" disabled={busy || (!editing && !table) || (editing?.action !== 'delete' && !name.trim())}>
        {editing?.action === 'rename' ? '确认改名' : editing?.action === 'delete' ? '确认删除' : '保存当前视图'}</Button>
      {editing && <Button type="button" variant="outline" onClick={() => {setEditing(null);setName('');}}>取消</Button>}</form>
    {error && <BiNotice error>{error} <Button size="sm" onClick={() => setReload(x=>x+1)}>刷新列表</Button></BiNotice>}
    {notice && <BiNotice>{notice}</BiNotice>}
    {list && <><ul>{list.rows.map(row => <li className="flex flex-wrap items-center justify-between gap-2 border-b py-3 text-sm" key={row.view_id}>
      <div><strong>{row.name}</strong><p className="text-muted-foreground">{REPORT_NAMES[row.report_type]} · {row.topic ? '专题分析' : '报表视图'} · 保存时版本 {row.saved_version}</p></div>
      <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { navigate(restoreReport(row)); setNotice('已恢复“'+row.name+'”的报表范围。'); }}>打开</Button>
      <Button size="sm" variant="ghost" onClick={() => {setName(row.name);setEditing({row,action:'rename'});}}>改名</Button>
      <Button size="sm" variant="ghost" onClick={() => {setName('');setEditing({row,action:'delete'});}}>删除</Button></div></li>)}</ul>
      {!list.total && <p className="py-3 text-sm text-muted-foreground">这个数据集还没有已保存的视图。</p>}
      <BiPagination label="已保存视图分页" total={list.total} page={list.page} change={viewsPage => navigate({viewsPage})} /></>}
    {saved?.topic && <article className="mt-5 rounded-xl border border-primary/30 p-4"><h3 className="font-semibold">{saved.name}</h3>
      <p className="my-2 text-sm">专题依据版本 {saved.topic.dataset_version} · 当前数据版本 {scope.version}
        {saved.topic.dataset_version !== scope.version && ' · 以下为提问时的历史结果'}</p>
      <AssistantAnswer key={saved.topic.run_id} workspaceId={scope.workspace_id} datasetId={scope.dataset_id} version={saved.topic.dataset_version} runId={saved.topic.run_id}
        viewStates={location.assistantViews} changeView={next => navigate({assistantViews:updateAssistantView(location.assistantViews,next)})} />
      <Button size="sm" variant="outline" onClick={() => navigate({conversationId:saved.topic!.conversation_id})}>打开原对话</Button></article>}
  </section>;
}
