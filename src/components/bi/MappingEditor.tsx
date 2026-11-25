'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { BI_SELECT, BiNotice, BiPagination } from './BiPrimitives';
import { readBi, dataErrorMessage } from '@/lib/bi/data-browser';
import type { MappingDraft } from '@/lib/bi/agent/result-contracts';
import type { Dataset } from '@/lib/bi/data-contracts';
import { mappingCommitSchema, mappingPreviewSchema, referenceDirectorySchema, scopeMatches,
  type MappingPreview, type ReferenceDirectory, type ReferenceRow } from '@/lib/bi/overview-contracts';

const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'medium' });

export function MappingEditor({ workspaceId, dataset, listingId, initialDate, draft, canManage, close, committed, restoreFocus }: {
  workspaceId: string; dataset: Dataset; listingId: string; initialDate: string | null; draft?: MappingDraft; canManage: boolean;
  close: () => void; committed: () => void; restoreFocus: (event: Event) => void;
}) {
  const [keyword, setKeyword] = useState(draft?.sku_search ?? '');
  const [search, setSearch] = useState(draft?.sku_search ?? '');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReferenceRow | null>(null);
  const [factor, setFactor] = useState(draft?.multiplier ?? '');
  const [effective, setEffective] = useState(draft ? draft.effective_local ?? '' : (initialDate || dayFormat.format(new Date())) + 'T00:00');
  const [choices, setChoices] = useState<{ body: string; data: ReferenceDirectory } | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [review, setReview] = useState<{ preview: MappingPreview; key: string } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const saving = useRef<AbortController | null>(null);
  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  const body = JSON.stringify({ ...scope, options: { kind: 'sku', sort: 'name', search, page } });
  useEffect(() => {
    if (!canManage) return;
    const c = new AbortController();
    setLoadError('');
    readBi('/api/bi/references', referenceDirectorySchema, { method: 'POST', body, signal: c.signal }).then((data) => {
      if (!scopeMatches(workspaceId, dataset, data) || data.kind !== 'sku' || data.page !== page) throw new Error('标准规格目录已更新，请重新读取。');
      if (!c.signal.aborted) setChoices({ body, data });
    }).catch((e) => { if (!c.signal.aborted) setLoadError(dataErrorMessage(e)); });
    return () => c.abort();
  }, [body, workspaceId, dataset, page, canManage, attempt]);
  useEffect(() => () => saving.current?.abort(), []);
  useEffect(() => {
    if (!review) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [review]);
  const data = choices?.body === body ? choices.data : null;
  const expired = !!review && Date.parse(review.preview.expires_at) <= now;
  async function submit(confirm: boolean) {
    if (!canManage || saving.current || !selected || !factor || !effective || (confirm && (!review || expired))) return;
    const c = new AbortController();
    saving.current = c; setBusy(true); setError('');
    try {
      if (confirm && review) {
        const result = await readBi('/api/bi/mappings/confirm', mappingCommitSchema, { method: 'POST', signal: c.signal,
          body: JSON.stringify({ ...scope, preview_id: review.preview.preview_id, idempotency_key: review.key, confirmed_by_user: true }) });
        if (result.workspace_id !== workspaceId || result.dataset_id !== dataset.dataset_id || result.accounting_revision !== result.version
          || result.version !== dataset.version + Number(review.preview.impact.changed) || result.data.proposed.listing_id !== listingId) {
          throw new Error('提交结果的范围发生变化，请刷新目录核对。');
        }
        if (!c.signal.aborted) committed();
      } else {
        setReview(null);
        const at = (effective.length === 16 ? effective + ':00' : effective) + '+08:00';
        const preview = await readBi('/api/bi/mappings/preview', mappingPreviewSchema, { method: 'POST', signal: c.signal,
          body: JSON.stringify({ ...scope, change: { listing_id: listingId, sku_id: selected.key, multiplier: factor, effective_at: at } }) });
        if (preview.workspace_id !== workspaceId || preview.dataset_id !== dataset.dataset_id || preview.version !== dataset.version
          || preview.impact.proposed.listing_id !== listingId || preview.impact.proposed.sku_id !== selected.key) throw new Error('预览的商品或数据版本发生变化，请重新选择。');
        if (!c.signal.aborted) setReview({ preview, key: crypto.randomUUID() });
      }
    } catch (e) { if (!c.signal.aborted) setError(dataErrorMessage(e)); }
    finally { if (saving.current === c) saving.current = null; if (!c.signal.aborted) setBusy(false); }
  }
  const impact = review?.preview.impact;
  return <Sheet open onOpenChange={(open) => { if (!open) close(); }}>
    <SheetContent className="w-full overflow-y-auto p-5 sm:max-w-xl sm:p-6" onCloseAutoFocus={restoreFocus}>
      <SheetHeader><SheetTitle>维护规格对应</SheetTitle><SheetDescription>平台商品编号 {listingId}。{draft ? '请核对助手建议的内容，从目录选择实际规格，补齐换算数量和生效时间后预览。' : '先选标准规格与生效时间，预览后可确认保存。'}</SheetDescription></SheetHeader>
      <div className="mt-5 grid gap-4">
        {!canManage ? <BiNotice>当前账号可查看商品目录。维护对应关系需要此工作空间的编辑权限。</BiNotice> : <>
          <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(keyword.trim()); setPage(1); }}>
            <label className="grid flex-1 gap-1 text-sm">搜索标准规格<Input value={keyword} maxLength={200} onChange={(e) => setKeyword(e.target.value)} /></label>
            <Button variant="outline" type="submit">查找规格</Button></form>
          {loadError && <BiNotice error>{loadError} <Button variant="outline" onClick={() => setAttempt(attempt + 1)}>重试</Button></BiNotice>}
          {data ? <>
            <label className="grid gap-1 text-sm">选择标准规格<select className={BI_SELECT} disabled={busy}
              value={data.rows.find((r) => r.key === selected?.key)?.key ?? ''} onChange={(e) => {
                setSelected(data.rows.find((r) => r.key === e.target.value) ?? null); setReview(null);
              }}><option value="">请选择</option>{data.rows.map((row) => <option value={row.key} key={row.key}>{row.product_name} · {row.name} · {row.key}</option>)}</select></label>
            <BiPagination page={page} total={data.total} label="选择标准规格分页" busy={busy} change={setPage} />
          </> : !loadError && <p role="status">正在读取标准规格…</p>}
          {selected && <p className="text-sm">已选 {selected.product_name} · {selected.name}（{selected.key}）</p>}
          <label className="grid gap-1 text-sm">平台售出一份，对应多少{selected?.unit ?? '标准单位'}
            <Input inputMode="decimal" value={factor} maxLength={20} disabled={busy} placeholder="例如 2" onChange={(e) => { setFactor(e.target.value); setReview(null); }} /></label>
          <label className="grid gap-1 text-sm">生效时间（北京时间）<Input type="datetime-local" step="1" disabled={busy} value={effective}
            onChange={(e) => { setEffective(e.target.value); setReview(null); }} /></label>
          <Button disabled={busy || !selected || !factor || !effective} onClick={() => submit(false)}>预览规格变更</Button>
          {impact && review && <section aria-label="规格变更预览" className="grid gap-2 rounded-xl border border-primary/30 bg-primary/5 p-4 text-sm">
            <h3 className="font-semibold">{impact.store_name} · {impact.name} · 货号 {impact.platform_sku_id}</h3>
            <p>原规则　{impact.previous ? impact.previous.sku_name + '（' + impact.previous.sku_id + '），1 ' + impact.unit + ' = ' + impact.previous.multiplier + ' ' + impact.previous.unit : '该时点尚未对应标准规格'}</p>
            <p>新规则　{impact.sku_name}（{impact.proposed.sku_id}），1 {impact.unit} = {impact.proposed.multiplier} {impact.standard_unit}</p>
            <p>从 {timeFormat.format(new Date(impact.proposed.effective_at))} 起{impact.valid_to ? '，至 ' + timeFormat.format(new Date(impact.valid_to)) + ' 前' : '持续生效'}。</p>
            <p>{impact.changed ? '同一货号和生效期间有 ' + impact.historical_paid_lines + ' 条已付款明细。保存后原订单保留付款时的核算结果，调整历史订单需另行预览并确认重算。' : '所选规格与换算数和原规则相同，保存后沿用当前版本。'}</p>
            {expired && <BiNotice>预览已过期，请重新预览。</BiNotice>}
            <Button disabled={busy || expired} onClick={() => submit(true)}>确认保存规格对应</Button>
          </section>}
        </>}
        {error && <BiNotice error>{error}</BiNotice>}
      </div>
    </SheetContent>
  </Sheet>;
}
