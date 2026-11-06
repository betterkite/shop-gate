'use client';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { z } from 'zod';
import { RefreshCw, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BiHeader, BiNotice, BiPagination, BI_PANEL, BI_SELECT } from '@/components/bi/BiPrimitives';
import { datasetSchema, directorySchema, type Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi } from '@/lib/bi/data-browser';
import { overviewUrl, readOverviewLocation, type OverviewLocation } from '@/lib/bi/overview-contracts';
import { OverviewDashboard } from './OverviewDashboard';
import { BiAssistant } from '@/components/bi/BiAssistant';

const projectsSchema = z.array(z.object({ id: z.string(), name: z.string() }));
export type OverviewNavigate = (change: Partial<OverviewLocation>) => void;
export function OverviewWorkspace({ workspaceId, canManage }: { workspaceId: string; canManage: boolean }) {
  const router = useRouter(); const search = useSearchParams()?.toString() ?? '';
  const location = readOverviewLocation(search);
  const [directory, setDirectory] = useState<z.infer<typeof directorySchema> | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null); const [projects, setProjects] = useState<z.infer<typeof projectsSchema>>([]);
  const [error, setError] = useState(''); const [selectionError, setSelectionError] = useState(''); const [projectError, setProjectError] = useState('');
  const [refresh, setRefresh] = useState(0); const [versionNotice, setVersionNotice] = useState('');
  const [directoryOpen, setDirectoryOpen] = useState(!location.datasetId);
  const selectedVersion = useRef<number | null>(null);
  const navigate: OverviewNavigate = (change) => router.push(overviewUrl(`/bi/overview?${search}`, change), { scroll: false });
  const reload = useCallback(() => setRefresh((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setDirectory(null); setError('');
    readBi(`/api/bi/datasets?${new URLSearchParams({ workspace_id: workspaceId, page: String(location.datasetPage) })}`, directorySchema, { signal: controller.signal })
      .then((data) => { if (data.workspace_id !== workspaceId) throw new Error('数据集列表的工作空间不一致，请刷新。'); if (!controller.signal.aborted) setDirectory(data); })
      .catch((problem) => { if (!controller.signal.aborted) setError(dataErrorMessage(problem)); });
    return () => controller.abort();
  }, [workspaceId, location.datasetPage, refresh]);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/projects', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) throw new Error('No shared list'); return projectsSchema.parse((await response.json()).data);
    }).then((data) => { if (!controller.signal.aborted) setProjects(data); })
      .catch(() => { if (!controller.signal.aborted) setProjectError('共享空间列表暂不可用；当前已授权空间仍可查看。'); });
    return () => controller.abort();
  }, []);
  useEffect(() => { setDataset(null); setSelectionError(''); setVersionNotice(''); selectedVersion.current = null; }, [workspaceId, location.datasetId]);
  useEffect(() => {
    if (!location.datasetId) return;
    const controller = new AbortController(); let inFlight = false;
    const load = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const data = await readBi(`/api/bi/datasets/${encodeURIComponent(location.datasetId!)}?${new URLSearchParams({ workspace_id: workspaceId })}`, datasetSchema, { signal: controller.signal });
        if (data.workspace_id !== workspaceId || data.dataset_id !== location.datasetId) throw new Error('所选数据集的范围不一致，请重新选择。');
        if (controller.signal.aborted) return;
        if (selectedVersion.current !== null && selectedVersion.current !== data.version) setVersionNotice(`数据已更新至版本 ${data.version}，本页自动重新取数；不会自动调用模型。`);
        selectedVersion.current = data.version;
        setDataset((current) => current?.dataset_id === data.dataset_id && current.version === data.version ? current : data); setSelectionError('');
      } catch (problem) { if (!controller.signal.aborted) { setDataset(null); setSelectionError(dataErrorMessage(problem)); } }
      finally { inFlight = false; }
    };
    void load(); const timer = window.setInterval(() => { void load(); }, 5000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [workspaceId, location.datasetId, refresh]);
  const selected = dataset && dataset.dataset_id === location.datasetId && dataset.workspace_id === workspaceId ? dataset : null;
  return <div className="min-h-screen bg-background text-foreground"><BiHeader workspaceId={workspaceId} datasetId={location.datasetId} />
    <main className="mx-auto grid w-full min-w-0 max-w-[1520px] grid-cols-1 gap-5 px-4 py-6 sm:px-6">
      <section className={`${BI_PANEL} border-primary/20 bg-gradient-to-br from-primary/10 via-card to-card`}>
        <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium uppercase tracking-widest text-primary">经营概况</p><h2 className="mt-2 text-2xl font-semibold tracking-tight">看清变化，再决定下一步</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">从成交、退款、成本和费用了解当前经营情况。缺少依据的金额会说明原因，演示数据与正式导入分开显示。</p></div>
          <Button size="sm" variant="outline" onClick={reload}><RefreshCw className="h-4 w-4" />刷新数据</Button></div>
        <div className="mt-5 flex flex-wrap items-center gap-3"><label className="flex max-w-full flex-wrap items-center gap-2 text-sm">工作空间<select aria-label="经营工作空间" className={BI_SELECT} value={workspaceId.startsWith('account:') ? '' : workspaceId} onChange={(e) => navigate({ workspaceId: e.target.value || undefined })}>
          <option value="">我的个人工作空间</option>{!workspaceId.startsWith('account:') && !projects.some((p) => p.id === workspaceId) && <option value={workspaceId}>当前共享工作空间</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <span className="rounded-full border border-border bg-background/70 px-3 py-1 text-xs">{canManage ? '可查看及维护目标' : '只读 · 可查看经营数据'}</span>
          {selected && <span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs">{selected.source_kind === 'demo' ? '演示数据 · 模拟经营记录' : '正式导入 · 用户提供'} · 版本 {selected.version}</span>}
        </div>{projectError && <p className="mt-3 text-xs text-muted-foreground">{projectError}</p>}
        <details className="mt-5 rounded-xl border border-border bg-background/60 p-4" open={directoryOpen} onToggle={(event) => setDirectoryOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium"><span className="min-w-0 break-all">数据集：{selected?.name ?? (location.datasetId ? '正在读取所选数据集' : '请选择经营数据')}</span><ChevronDown className="h-4 w-4 shrink-0" /></summary>
          {error && <div className="mt-4"><BiNotice error>{error}<Button variant="outline" size="sm" onClick={reload}>重试</Button></BiNotice></div>}
          {!directory && !error && <p role="status" className="mt-4 text-sm text-muted-foreground">正在读取数据集…</p>}
          {directory?.total === 0 && <p className="mt-4 text-sm text-muted-foreground">此工作空间还没有数据集。<Link className="text-primary underline" href={`/bi/data?${new URLSearchParams({ workspace_id: workspaceId })}`}>前往数据集与导入中心</Link></p>}
          <ul className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">{directory?.rows.map((row) => <li className="min-w-0" key={row.dataset_id}><button type="button" className={`h-full w-full rounded-xl border p-3 text-left ${row.dataset_id === location.datasetId ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`} aria-pressed={row.dataset_id === location.datasetId} onClick={() => { setDirectoryOpen(false); navigate({ datasetId: row.dataset_id }); }}>
            <strong className="block break-all text-sm">{row.name}</strong><span className="mt-2 block text-xs text-muted-foreground">{row.source_kind === 'demo' ? '演示' : '正式导入'} · 版本 {row.version}</span></button></li>)}</ul>
          {directory && <BiPagination label="经营数据集分页" page={directory.page} total={directory.total} change={(datasetPage) => navigate({ datasetPage })} />}
        </details>
      </section>
      {versionNotice && <BiNotice>{versionNotice}</BiNotice>}
      {selectionError && <BiNotice error>{selectionError} 不会自动改选其他数据集。<Button variant="outline" size="sm" onClick={reload}>重试</Button></BiNotice>}
      {!location.datasetId && <BiNotice>选择数据集后即可查看经营概况、销售平台贡献和月度目标。</BiNotice>}
      {location.datasetId && !selected && !selectionError && <div role="status" className="min-h-[600px] animate-pulse rounded-2xl bg-muted/40 p-6 text-sm text-muted-foreground">正在确认所选数据集与版本…</div>}
      {selected && <OverviewDashboard key={`${workspaceId}:${selected.dataset_id}`} workspaceId={workspaceId} dataset={selected} canManage={canManage} location={location} navigate={navigate} refresh={refresh} onCommitted={reload} />}
      {selected && <BiAssistant key={`assistant:${workspaceId}:${selected.dataset_id}`} workspaceId={workspaceId} dataset={selected} location={location} navigate={navigate} />}
    </main></div>;
}
