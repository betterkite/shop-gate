'use client';
import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { batchCanCommit, batchDetailSchema, batchesSchema, BATCH_LABELS, decimalLabel, scopedDataParams,
  RESOURCE_LABELS, RESOURCES, type ImportBatch, type Dataset, type DataLocation } from '@/lib/bi/data-contracts';
import { dataErrorMessage, downloadBiFile, readBi } from '@/lib/bi/data-browser';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
type History = ReturnType<typeof batchesSchema.parse>;
export function BatchHistory({ workspaceId, dataset, page, batchId, canManage, pending, navigate, confirm, refresh }: {
  workspaceId: string; dataset: Dataset; page: number; batchId?: string; canManage: boolean; pending: boolean;
  navigate: (change: Partial<DataLocation>) => void; confirm: (previewId: string) => Promise<void>; refresh: number;
}) {
  const [history, setHistory] = useState<History | null>(null); const [detail, setDetail] = useState<ImportBatch | null>(null);
  const [error, setError] = useState(''); const [dialog, setDialog] = useState(false);
  const [clock, setClock] = useState(Date.now()); const [retry, setRetry] = useState(0);
  const params = scopedDataParams(workspaceId, dataset).toString();
  useEffect(() => { const tick = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(tick); }, []);
  useEffect(() => {
    const controller = new AbortController(); let inFlight = false;
    setHistory(null); setDetail(null); setDialog(false); setError('');
    const update = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const expected = (data: { workspace_id: string; dataset_id: string; version: number }) => {
          if (data.workspace_id !== workspaceId || data.dataset_id !== dataset.dataset_id || data.version !== dataset.version)
            throw new Error('批次历史的范围或版本已变化，请刷新。');
        };
        const listing = await readBi(`/api/bi/batches?${params}&page=${page}`, batchesSchema, { signal: controller.signal });
        expected(listing);
        if (listing.rows.some((row) => row.workspace_id !== workspaceId || row.dataset_id !== dataset.dataset_id)) throw new Error('批次范围不一致，请刷新。');
        if (controller.signal.aborted) return;
        setHistory(listing);
        if (batchId) {
          const selected = await readBi(`/api/bi/batches/${encodeURIComponent(batchId)}?${params}`, batchDetailSchema, { signal: controller.signal });
          expected(selected);
          if (selected.batch.workspace_id !== workspaceId || selected.batch.dataset_id !== dataset.dataset_id || selected.batch.batch_id !== batchId) throw new Error('所选批次范围不一致，请重新选择。');
          if (!controller.signal.aborted) setDetail(selected.batch);
        } else setDetail(null);
        if (!controller.signal.aborted) setError('');
      } catch (problem) {
        if (!controller.signal.aborted) { setError(dataErrorMessage(problem)); setDetail(null); }
      } finally { inFlight = false; }
    };
    void update(); const interval = window.setInterval(() => { void update(); }, 5000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [params, workspaceId, dataset.dataset_id, dataset.version, page, batchId, refresh, retry]);
  const allowed = detail ? batchCanCommit(detail, dataset, canManage, clock) : false;
  const summary = object(detail?.evidence?.resources); const impact = object(detail?.evidence?.impact);
  const before = object(object(impact.before).metrics); const after = object(object(impact.after).metrics);
  const files = Array.isArray(detail?.evidence?.files) ? detail.evidence.files.map(object) : [];
  return <section className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6" aria-label="全部导入批次">
    <div className="flex flex-wrap justify-between gap-3"><div><h2 className="text-lg font-semibold">全部导入批次</h2>
      <p className="mt-2 text-sm text-muted-foreground">包括早期导入和后台任务产生的批次。预览完成不表示已写入；共享成员可查看状态，文件与校验明细由提交人查看。</p></div>
      <Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>刷新批次</Button></div>
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
    {!history && !error && <p role="status" className="py-5 text-sm text-muted-foreground">正在读取导入历史…</p>}
    {history?.total === 0 && <p className="py-5 text-sm text-muted-foreground">尚无导入批次。提交文件或演示预览后即可查看。</p>}
    {history && history.total > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[660px] text-left text-sm"><caption className="sr-only">此数据集完整导入历史，可分页访问</caption>
      <thead><tr className="border-b border-border text-xs text-muted-foreground">{['状态', '记录数', '问题数', '批次版本', '创建时间', '详情'].map((label) => <th className="p-3" key={label}>{label}</th>)}</tr></thead>
      <tbody>{history.rows.map((batch) => <tr key={batch.batch_id} className={`border-b border-border/60 ${batch.batch_id === batchId ? 'bg-primary/5' : ''}`}>
        <td className="p-3">{BATCH_LABELS[batch.state]}{batch.state === 'preview' && batch.expired ? ' · 已过期' : ''}</td><td className="p-3">{decimalLabel(batch.row_count)}</td><td className="p-3">{decimalLabel(batch.error_count)}</td>
        <td className="p-3">{batch.based_on_version ?? '原版本未记录'}{batch.state === 'committed' ? ` → ${batch.version}` : ''}</td><td className="p-3 text-xs">{new Date(batch.created_at).toLocaleString('zh-CN')}</td>
        <td className="p-3"><Button variant="ghost" size="sm" onClick={() => navigate({ batchId: batch.batch_id })}>查看批次</Button></td></tr>)}</tbody></table></div>}
    {history && <nav aria-label="导入批次分页" className="mt-4 flex flex-wrap justify-between gap-3 text-sm text-muted-foreground"><span>共 {history.total} 批 · 每页 20 批 · 第 {page} / {Math.max(1, Math.ceil(history.total / 20))} 页</span>
      <span className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => navigate({ batchPage: page - 1 })}>上一页</Button><Button variant="outline" size="sm" disabled={page * 20 >= history.total} onClick={() => navigate({ batchPage: page + 1 })}>下一页</Button></span></nav>}
    {detail && <article aria-label="所选导入批次详情" className="mt-6 rounded-xl border border-primary/25 bg-primary/[0.025] p-4 sm:p-5">
      <h3 className="font-semibold">{BATCH_LABELS[detail.state]}</h3><p className="mt-2 break-all text-xs text-muted-foreground">批次编号 {detail.batch_id} · {detail.based_on_version === null ? '原预览版本未记录' : `基于版本 ${detail.based_on_version}`}{detail.state === 'committed' ? ` · 处理结果版本 ${detail.version}` : ''} · 当前数据版本 {dataset.version}</p>
      {!detail.owned_by_current_user ? <p className="mt-4 text-sm text-muted-foreground">这是其他成员提交的批次。文件、校验明细和确认操作由原提交人查看及处理。</p> : <>
        <p className="mt-4 text-sm">本批共有 {detail.row_count} 条标准记录、{detail.error_count} 项问题。{detail.state === 'committed' ? '已确认的处理结果保留原版本记录。' : '经营事实尚未写入。'}</p>
        {detail.state === 'committed' && detail.based_on_version !== null && detail.version === detail.based_on_version && <p className="mt-3 text-sm text-primary">本批内容与已有数据相同，没有新增记录，数据版本保持 {detail.version}。</p>}
        {files.length > 0 && <details className="mt-4"><summary className="cursor-pointer text-sm font-medium">来源文件与校验摘要 · 模板版本 {String(detail.evidence?.template_version ?? '—')}</summary>
          <ul className="mt-3 grid gap-3">{files.map((file, index) => <li className="break-all text-xs" key={index}>{String(file.filename ?? '文件')}<p className="mt-1 font-mono text-muted-foreground">SHA-256：{String(file.sha256 ?? '—')}</p></li>)}</ul></details>}
        {Object.keys(summary).length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left">{detail.state === 'committed' ? '原预览检查记录' : '记录检查'}</caption><thead><tr className="border-b border-border"><th className="p-2">数据类型</th><th className="p-2">新增</th><th className="p-2">完全重复</th></tr></thead>
          <tbody>{RESOURCES.map((resource) => <tr key={resource} className="border-b border-border/50"><td className="p-2">{RESOURCE_LABELS[resource]}</td><td className="p-2">{decimalLabel(object(summary[resource]).inserted)}</td><td className="p-2">{decimalLabel(object(summary[resource]).duplicates)}</td></tr>)}</tbody></table></div>}
        {Object.keys(after).length > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left">原预览试算 · 全部源事实期间</caption><thead><tr className="border-b border-border"><th className="p-2">指标</th><th className="p-2">导入前</th><th className="p-2">预计导入后</th></tr></thead><tbody>{[
          ['net_sales', '净销售额（元）'], ['accounted_contribution', '已核算范围贡献金额（元）'], ['order_count', '付款订单数'],
        ].map(([metric, label]) => <tr key={metric} className="border-b border-border/50"><td className="p-2">{label}</td><td className="p-2">{decimalLabel(before[metric])}</td><td className="p-2">{decimalLabel(after[metric])}</td></tr>)}</tbody></table><p className="mt-2 text-xs text-muted-foreground">保留原预览范围和版本，待核算不等于零。</p></div>}
        {(detail.errors?.length ?? 0) > 0 && <ul className="mt-4 grid gap-2 text-xs">{detail.errors!.map((row, index) => <li key={index}>{String(row.filename ?? '文件')} · 第 {String(row.row ?? '—')} 行 · {String(row.field ?? '')}：{String(row.message ?? '请检查格式或关联')}</li>)}</ul>}
        <div className="mt-4 flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" onClick={async () => {
          try { await downloadBiFile(`/api/bi/batches/${encodeURIComponent(detail.batch_id)}/errors?${params}`, 'shopgate-errors-v1.csv'); }
          catch (problem) { setError(dataErrorMessage(problem)); }
        }}>下载全部校验结果</Button>
          {detail.state === 'preview' && <Button disabled={pending || !allowed} onClick={() => setDialog(true)}>检查此批次并确认导入</Button>}</div>
        {detail.state === 'preview' && <p className="mt-3 text-xs text-muted-foreground">{allowed ? `预览有效至 ${new Date(detail.preview_expires_at!).toLocaleString('zh-CN')}，确认前会再次检查权限和版本。` : !canManage ? '当前只读权限不能确认导入。' : '原预览已过期、已提交或数据版本已变化，请重新上传并预览。'}</p>}
        {(detail.errors?.length ?? 0) > 0 && <p className="mt-2 text-xs text-muted-foreground">显示前 {detail.errors!.length} 项，全部问题可下载查看。</p>}
      </>}
    </article>}
    <AlertDialog open={dialog} onOpenChange={setDialog}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认导入此历史批次？</AlertDialogTitle><AlertDialogDescription>使用当前查看的原预览写入“{dataset.name}”。权限、数据版本或预览期限变化时不会部分写入；不会自动更新原预览。</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>返回检查</AlertDialogCancel><Button disabled={pending || !allowed} onClick={async () => {
        if (!detail || !batchCanCommit(detail, dataset, canManage)) { setDialog(false); setError('预览已失效，请重新预览。'); return; }
        await confirm(detail.preview_id!); setDialog(false); setRetry((n) => n + 1);
      }}>{pending ? '正在提交…' : '确认导入并查看任务'}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </section>;
}
