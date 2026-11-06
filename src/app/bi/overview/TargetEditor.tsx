'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { BiNotice } from '@/components/bi/BiPrimitives';
import { decimalLabel, StableRequestKeys, type Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { overviewSchema, scopeMatches, targetCommitSchema, targetPreviewSchema, type TargetPreview, type TargetRow } from '@/lib/bi/overview-contracts';

/** Parent keys this editor by dataset version, store and month; a new scope ends the old draft. */
export function TargetEditor({ workspaceId, dataset, storeId, month, initial, canManage, close, committed }: {
  workspaceId: string; dataset: Dataset; storeId: string; month: string; initial?: TargetRow;
  canManage: boolean; close: () => void; committed: () => void;
}) {
  const [row, setRow] = useState<TargetRow | null>(initial ?? null);
  const [sales, setSales] = useState(initial?.sales_target ?? ''); const [profit, setProfit] = useState(initial?.profit_target ?? '');
  const [preview, setPreview] = useState<TargetPreview | null>(null); const [confirmation, setConfirmation] = useState(false);
  const [problem, setProblem] = useState(''); const [pending, setPending] = useState(false); const [clock, setClock] = useState(Date.now());
  const keys = useRef(new StableRequestKeys()); const active = useRef(true); const inFlight = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (initial) return;
    const abort = new AbortController();
    readBi('/api/bi/overview', overviewSchema, { method: 'POST', signal: abort.signal,
      body: JSON.stringify({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version,
        options: { query: { store_ids: [storeId] }, target_month: month } }) }).then((data) => {
      if (!scopeMatches(workspaceId, dataset, data)) throw new Error('目标的范围或版本已变化，请刷新。');
      const selected = data.targets?.rows.find((item) => item.store_id === storeId && item.month === month);
      if (!selected) throw new Error('当前数据集没有这家店铺，请重新选择。');
      if (!abort.signal.aborted) { setRow(selected); setSales(selected.sales_target ?? ''); setProfit(selected.profit_target ?? ''); }
    }).catch((error) => { if (!abort.signal.aborted) setProblem(dataErrorMessage(error)); });
    return () => abort.abort();
  }, [workspaceId, dataset, storeId, month, initial]);
  const previewChange = async () => {
    if (!canManage || !row || inFlight.current) return;
    inFlight.current = true; setPending(true); setProblem(''); setPreview(null);
    controller.current = new AbortController();
    try {
      const result = await readBi('/api/bi/targets/preview', targetPreviewSchema, { method: 'POST', signal: controller.current.signal,
        body: JSON.stringify({ ...scope, change: { store_id: storeId, month, sales_target: sales.trim(), profit_target: profit.trim() || null } }) });
      if (result.workspace_id !== workspaceId || result.dataset_id !== dataset.dataset_id || result.version !== dataset.version
          || result.impact.store_id !== storeId || result.impact.month !== month || result.impact.version_before !== dataset.version
          || result.impact.expected_version_after !== dataset.version + Number(result.impact.changed)) throw new Error('目标预览的范围或版本不一致，请刷新。');
      if (active.current) setPreview(result);
    } catch (error) { if (active.current) setProblem(dataErrorMessage(error)); }
    finally { inFlight.current = false; if (active.current) setPending(false); }
  };
  const allowed = canManage && preview !== null && preview.version === dataset.version && Date.parse(preview.expires_at) > clock;
  const confirm = async () => {
    if (!allowed || !preview || inFlight.current) return;
    inFlight.current = true; setPending(true); setProblem('');
    controller.current = new AbortController();
    try {
      const result = await readBi('/api/bi/targets/confirm', targetCommitSchema, { method: 'POST', signal: controller.current.signal,
        body: JSON.stringify({ ...scope, preview_id: preview.preview_id, idempotency_key: keys.current.get(preview.preview_id), confirmed_by_user: true }) });
      if (result.workspace_id !== workspaceId || result.dataset_id !== dataset.dataset_id || result.version !== result.accounting_revision
          || result.version !== preview.impact.expected_version_after || result.changed !== preview.impact.changed
          || result.data.target.store_id !== storeId || result.data.target.month !== month) throw new Error('提交结果的范围或版本不一致，请先刷新目标检查状态。');
      if (active.current) { committed(); close(); }
    } catch (error) { if (active.current) { setConfirmation(false); setProblem(`${dataErrorMessage(error)} 若提交结果不确定，请先刷新目标检查；重试本次确认会使用原提交标识。`); } }
    finally { inFlight.current = false; if (active.current) setPending(false); }
  };
  return <Sheet open onOpenChange={(open) => { if (!open && !pending) close(); }}><SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
    <SheetHeader className="border-b border-border p-6 pr-12"><SheetTitle>月度经营目标</SheetTitle><SheetDescription>{row?.store_name ?? '正在读取所选店铺'} · {month.slice(0, 7)} · 数据版本 {dataset.version}</SheetDescription></SheetHeader>
    <div className="flex-1 space-y-5 overflow-y-auto p-6">
      {problem && <BiNotice error>{problem}</BiNotice>}
      {!row && !problem && <p role="status" className="text-sm text-muted-foreground">正在读取这家店铺的原目标…</p>}
      {row && <><div className="rounded-xl bg-muted/50 p-4 text-sm leading-6"><p>整月净销售额：<strong>{row.actual_state === 'no_records' ? '尚无经营记录' : `${decimalLabel(row.net_sales)}${row.net_sales !== null ? ' 元' : ''}`}</strong></p>
        <p>原净销售额目标：{row.sales_target === null ? '未设定' : `${decimalLabel(row.sales_target)} 元`}</p><p>原经营贡献目标：{row.profit_target === null ? '未填写' : `${decimalLabel(row.profit_target)} 元`}</p>
        <p className="mt-2 text-xs text-muted-foreground">按店铺完整自然月统计，不沿用当前商品或部分日期筛选。</p></div>
        {!canManage ? <BiNotice>当前为只读权限，可查看目标；修改需由具备管理权限的成员处理。</BiNotice>
          : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void previewChange(); }}>
            <label className="grid gap-2 text-sm">净销售额目标（元）<Input aria-label="净销售额目标" inputMode="decimal" value={sales} maxLength={22} placeholder="例如 50000.00" required disabled={pending} onChange={(event) => { setSales(event.target.value); setPreview(null); }} /><span className="text-xs text-muted-foreground">填写非负金额，最多2位小数；明确填0与未设定不同。</span></label>
            <label className="grid gap-2 text-sm">经营贡献目标（元，可不填）<Input aria-label="经营贡献目标" inputMode="decimal" value={profit} maxLength={22} placeholder="按经营计划填写" disabled={pending} onChange={(event) => { setProfit(event.target.value); setPreview(null); }} /><span className="text-xs text-muted-foreground">可按计划填写负数；留空表示未设定该项。</span></label>
            <Button type="submit" disabled={pending}>{pending ? '正在处理…' : '预览目标变更'}</Button>
          </form>}
        {preview && <section aria-label="目标变更预览" className="rounded-xl border border-primary/30 bg-primary/5 p-4"><h3 className="font-semibold">确认前，请检查这次变更</h3>
          <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">目标</th><th className="p-2">原值（元）</th><th className="p-2">新值（元）</th></tr></thead><tbody>{[['sales_target', '净销售额'], ['profit_target', '经营贡献']].map(([key, label]) => {
            const metric = key as 'sales_target' | 'profit_target'; const before = preview.impact.previous?.[metric], after = preview.impact.proposed[metric];
            return <tr className="border-t border-border" key={key}><th className="p-2 font-normal">{label}</th><td className="p-2 tabular-nums">{before == null ? '未设定' : decimalLabel(before)}</td><td className="p-2 tabular-nums">{after == null ? '未设定' : decimalLabel(after)}</td></tr>;
          })}</tbody></table></div><p className="mt-3 text-xs leading-6 text-muted-foreground">{preview.impact.notice} {preview.impact.changed ? `确认后预计变为版本 ${preview.impact.expected_version_after}。` : '目标与原值相同，确认不会增加数据版本。'}</p>
          <p className="mt-2 text-xs text-muted-foreground">预览有效至 {new Date(preview.expires_at).toLocaleTimeString('zh-CN')}。{!allowed && '预览已失效或无修改权限，请重新预览。'}</p>
          <Button className="mt-4" disabled={pending || !allowed} onClick={() => setConfirmation(true)}>检查完成，确认修改</Button>
        </section>}
      </>}
    </div>
    <AlertDialog open={confirmation} onOpenChange={(open) => { if (!pending) setConfirmation(open); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认保存这次目标变更？</AlertDialogTitle><AlertDialogDescription>修改{row?.store_name} {month.slice(0, 7)}的目标。提交前会再次检查当前权限、数据版本与预览期限；订单和历史成本不变。</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>返回检查</AlertDialogCancel><Button disabled={pending || !allowed} onClick={() => { void confirm(); }}>{pending ? '正在保存…' : '确认保存目标'}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </SheetContent></Sheet>;
}
