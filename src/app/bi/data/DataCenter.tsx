'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { z } from 'zod';
import { ArrowLeft, Database, Download, FileCheck2, RefreshCw, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { AuthUserMenu } from '@/components/auth/AuthUserMenu';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { catalogSchema, CHOICE_LABELS, FIELD_TYPE_LABELS, dataLocationUrl, datasetSchema, decimalLabel, directorySchema,
  inferResource, JOB_ERROR_LABELS, JOB_LABELS, jobSchema, jobsSchema, previewCanCommit, queryResultSchema,
  readDataLocation, RESOURCES, RESOURCE_LABELS, sameDatasetSnapshot, scopedDataParams,
  StableRequestKeys, validateUploads, type DataCatalog, type DataJob, type Dataset,
  type DataSnapshot, type Resource } from '@/lib/bi/data-contracts';
import { dataErrorMessage, downloadBiFile, fileBase64, readBi, requestDigest } from '@/lib/bi/data-browser';
import { BatchHistory } from './BatchHistory';

const PANEL = 'rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6';
const SELECT = 'h-10 max-w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground';
const PROJECTS = z.array(z.object({ id: z.string(), name: z.string() }));
type UploadChoice = { file: File; resource: Resource | '' };
type Navigation = (change: Parameters<typeof dataLocationUrl>[1], replace?: boolean) => void;

function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p role={error ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${error
    ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-primary/20 bg-primary/5 text-foreground'}`}>{children}</p>;
}
function Pagination({ page, total, change, label }: { page: number; total: number; change: (page: number) => void; label: string }) {
  const pages = Math.max(1, Math.ceil(total / 20));
  return <nav aria-label={label} className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
    <span>共 {total.toLocaleString('zh-CN')} 项 · 每页 20 项 · 第 {page} / {pages} 页</span>
    <span className="flex gap-2"><Button variant="outline" size="sm" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</Button>
      <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => change(page + 1)}>下一页</Button></span>
  </nav>;
}

export function DataCenter({ workspaceId, canManage, demoEnabled }: { workspaceId: string; canManage: boolean; demoEnabled: boolean }) {
  const router = useRouter(); const pathname = usePathname() ?? '/bi/data'; const search = useSearchParams()?.toString() ?? '';
  const location = readDataLocation(search);
  const [directory, setDirectory] = useState<z.infer<typeof directorySchema> | null>(null);
  const [selected, setSelected] = useState<Dataset | null>(null);
  const [catalog, setCatalog] = useState<DataCatalog | null>(null);
  const [projects, setProjects] = useState<z.infer<typeof PROJECTS>>([]);
  const [error, setError] = useState(''); const [selectionError, setSelectionError] = useState('');
  const [catalogError, setCatalogError] = useState(''); const [projectError, setProjectError] = useState('');
  const [loading, setLoading] = useState(true); const [refresh, setRefresh] = useState(0);
  const [versionMessage, setVersionMessage] = useState(''); const lastVersion = useRef<number | null>(null);
  const currentHref = `${pathname}?${search}`;
  const navigate: Navigation = useCallback((change, replace = false) => {
    const href = dataLocationUrl(`${pathname}?${search}`, change);
    if (replace) router.replace(href, { scroll: false }); else router.push(href, { scroll: false });
  }, [pathname, router, search]);
  const refreshData = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const query = new URLSearchParams({ workspace_id: workspaceId, page: String(location.datasetPage) });
    readBi(`/api/bi/datasets?${query}`, directorySchema, { signal: controller.signal }).then((data) => {
      if (data.workspace_id !== workspaceId) throw new Error('服务返回的工作空间不一致，请重新选择。');
      if (!controller.signal.aborted) setDirectory(data);
    }).catch((problem) => { if (!controller.signal.aborted) { setDirectory(null); setError(dataErrorMessage(problem)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspaceId, location.datasetPage, refresh]);

  useEffect(() => {
    const controller = new AbortController(); setCatalog(null); setCatalogError('');
    readBi(`/api/bi/catalog?${new URLSearchParams({ workspace_id: workspaceId })}`, catalogSchema,
      { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) setCatalog(data); })
      .catch((problem) => { if (!controller.signal.aborted) setCatalogError(dataErrorMessage(problem)); });
    return () => controller.abort();
  }, [workspaceId, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/projects', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => { if (!response.ok) throw new Error('项目列表暂不可用'); const body = await response.json(); return PROJECTS.parse(body.data); })
      .then((data) => { if (!controller.signal.aborted) { setProjects(data); setProjectError(''); } })
      .catch(() => { if (!controller.signal.aborted) setProjectError('共享工作空间列表暂不可用；当前已授权空间不受影响。'); });
    return () => controller.abort();
  }, []);

  // Selected metadata has its own endpoint: paginating the directory never loses an off-page selection.
  useEffect(() => {
    setSelected(null); setSelectionError(''); lastVersion.current = null; setVersionMessage('');
  }, [workspaceId, location.datasetId]);
  useEffect(() => {
    if (!location.datasetId) return;
    const controller = new AbortController();
    let active = true; let inFlight = false;
    const update = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const data = await readBi(`/api/bi/datasets/${encodeURIComponent(location.datasetId!)}?${new URLSearchParams({ workspace_id: workspaceId })}`,
          datasetSchema, { signal: controller.signal });
        if (data.workspace_id !== workspaceId || data.dataset_id !== location.datasetId) throw new Error('数据集范围不一致，请重新选择。');
        if (!active) return;
        if (lastVersion.current !== null && lastVersion.current !== data.version) {
          setVersionMessage(`数据已更新至版本 ${data.version}，当前页面重新取数。旧分析仍属于原版本，不会自动调用模型。`);
        }
        lastVersion.current = data.version; setSelected(data); setSelectionError('');
      } catch (problem) {
        if (active && !controller.signal.aborted) { setSelected(null); setSelectionError(dataErrorMessage(problem)); }
      } finally { inFlight = false; }
    };
    void update(); const interval = window.setInterval(() => { void update(); }, 5000);
    return () => { active = false; controller.abort(); window.clearInterval(interval); };
  }, [workspaceId, location.datasetId, refresh]);

  return <div className="min-h-screen bg-background text-foreground">
    <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3"><Link href="/" aria-label="返回工作台" className="rounded-lg p-2 hover:bg-muted"><ArrowLeft className="h-5 w-5" /></Link>
          <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground"><Database className="h-5 w-5" /></span>
          <div><p className="text-xs font-medium text-primary">Shop Gate · 经营数据</p><h1 className="text-lg font-semibold sm:text-xl">数据集与导入中心</h1></div></div>
        <div className="flex items-center gap-2"><ThemeToggle compact /><AuthUserMenu variant="header" /></div>
      </div>
    </header>
    <main className="mx-auto grid max-w-[1440px] gap-5 px-4 py-6 sm:px-6">
      <section className="rounded-2xl border border-primary/20 bg-primary/5 p-5 sm:p-6">
        <h2 className="text-xl font-semibold">先选数据，再开始经营分析</h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-muted-foreground">订单、退款、成本与费用使用同一份经营账本。上传后先检查并预览，只有你确认后才正式写入。演示数据与正式数据分开保存，整个导入过程无需调用大模型。</p>
        <div className="mt-4 flex flex-wrap items-center gap-3"><label className="flex flex-wrap items-center gap-2 text-sm">工作空间
          <select aria-label="工作空间" className={SELECT} value={workspaceId.startsWith('account:') ? '' : workspaceId}
            onChange={(event) => navigate({ workspaceId: event.target.value || undefined })}>
            <option value="">我的个人工作空间</option>
            {!workspaceId.startsWith('account:') && !projects.some((p) => p.id === workspaceId) && <option value={workspaceId}>当前共享工作空间</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          <span className="rounded-full border border-border bg-card px-3 py-1 text-xs">{canManage ? '可查看及管理数据' : '只读 · 可查看及导出'}</span>
          <Button variant="outline" size="sm" onClick={refreshData}><RefreshCw className="h-4 w-4" />刷新数据</Button>
        </div>{projectError && <p className="mt-3 text-xs text-muted-foreground">{projectError}</p>}
      </section>

      {error && <Notice error>{error} <Button size="sm" variant="outline" onClick={refreshData}>重试</Button></Notice>}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(330px,0.8fr)]">
        <section className={PANEL} aria-label="数据集列表"><div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">可用数据集</h2><span className="text-xs text-muted-foreground">选择只切换范围，不修改数据</span></div>
          {loading && !directory && <p role="status" className="py-8 text-sm text-muted-foreground">正在读取数据集…</p>}
          {directory?.total === 0 && <p className="py-8 text-sm text-muted-foreground">此工作空间还没有数据集。{canManage ? '请在右侧创建正式导入集或演示集。' : '请联系有管理权限的成员创建。'}</p>}
          <ul className="mt-4 grid gap-2">{directory?.rows.map((dataset) => <li key={dataset.dataset_id}>
            <button type="button" aria-pressed={dataset.dataset_id === location.datasetId}
              onClick={() => navigate({ datasetId: dataset.dataset_id, jobId: undefined, jobPage: 1 })}
              className={`w-full rounded-xl border p-4 text-left transition-colors ${dataset.dataset_id === location.datasetId ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50 hover:bg-muted/50'}`}>
              <span className="flex flex-wrap items-center justify-between gap-2"><strong className="break-all text-sm">{dataset.name}</strong><span className="rounded-full bg-muted px-2 py-1 text-xs">{dataset.source_kind === 'demo' ? '演示 · 模拟经营事实' : '正式导入 · 用户提供'}</span></span>
              <span className="mt-2 block break-all text-xs text-muted-foreground">编号 {dataset.dataset_id} · 版本 {dataset.version} · 人民币核算</span>
            </button></li>)}</ul>
          {directory && <Pagination label="数据集分页" page={location.datasetPage} total={directory.total} change={(datasetPage) => navigate({ datasetPage })} />}
        </section>
        <CreateDataset workspaceId={workspaceId} canManage={canManage} demoEnabled={demoEnabled} onCreated={(dataset) => {
          refreshData(); navigate({ datasetId: dataset.dataset_id, jobId: undefined, jobPage: 1 }, true);
        }} />
      </div>
      {selectionError && <Notice error>{selectionError} 不会自动改选其他数据集。<Button size="sm" variant="outline" onClick={refreshData}>重试</Button></Notice>}
      {versionMessage && <Notice>{versionMessage}</Notice>}
      {location.datasetId && !selected && !selectionError && <p role="status" className="text-sm text-muted-foreground">正在确认所选数据集与当前版本…</p>}
      {!location.datasetId && <Notice>请先选择一个数据集，再上传文件、准备演示数据或查看处理任务。</Notice>}
      {catalogError && <Notice error>字段说明未加载：{catalogError}<Button size="sm" variant="outline" onClick={refreshData}>重试</Button></Notice>}
      {selected && <DatasetOperations key={`${workspaceId}:${selected.dataset_id}`} workspaceId={workspaceId} dataset={selected}
        canManage={canManage} demoEnabled={demoEnabled} catalog={catalog} jobPage={location.jobPage} jobId={location.jobId}
        batchPage={location.batchPage ?? 1} batchId={location.batchId}
        navigate={navigate} refreshData={refreshData} currentHref={currentHref} />}
      <footer className="border-t border-border py-4 text-xs leading-6 text-muted-foreground">这是重构中的经营数据入口。旧行为分析与历史成果暂保留原入口，不会自动转换成真实订单；八模块经营页面随后接入这份账本。</footer>
    </main>
  </div>;
}

function CreateDataset({ workspaceId, canManage, demoEnabled, onCreated }: { workspaceId: string; canManage: boolean; demoEnabled: boolean; onCreated: (dataset: Dataset) => void }) {
  const [name, setName] = useState(''); const [kind, setKind] = useState<'import' | 'demo'>('import');
  const [confirmation, setConfirmation] = useState(false); const [pending, setPending] = useState(false); const [message, setMessage] = useState('');
  const keys = useRef(new StableRequestKeys()); const identifiers = useRef(new Map<string, string>());
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (pending || !canManage || !confirmation) return;
    setPending(true); setMessage('');
    try {
      if (!name.trim() || name.trim().length > 200) throw new Error('请填写1–200字的数据集名称。');
      const fingerprint = `${workspaceId}:${kind}:${name.trim()}`;
      let datasetId = identifiers.current.get(fingerprint);
      if (!datasetId) { datasetId = `data-${crypto.randomUUID()}`; identifiers.current.set(fingerprint, datasetId); }
      const data = await readBi('/api/bi/datasets', datasetSchema, { method: 'POST', body: JSON.stringify({ workspace_id: workspaceId,
        dataset_id: datasetId, name: name.trim(), source_kind: kind, confirmed_by_user: true, idempotency_key: keys.current.get(fingerprint) }) });
      if (active.current) { setName(''); setConfirmation(false); setMessage('已创建空数据集；尚未导入或生成经营记录。'); onCreated(data); }
    } catch (error) { if (active.current) setMessage(dataErrorMessage(error)); }
    finally { if (active.current) setPending(false); }
  };
  return <section className={PANEL}><h2 className="text-lg font-semibold">创建数据集</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">先建立空数据集，不会立即导入、生成或覆盖已有记录。</p>
    {!canManage ? <p className="mt-5 text-sm text-muted-foreground">当前为只读权限，创建和导入需联系工作空间管理成员。</p>
      : <form className="mt-5 grid gap-4" onSubmit={submit}>
        <label className="grid gap-2 text-sm">数据集名称<Input aria-label="数据集名称" placeholder="例如：2026年店铺经营数据" value={name} onChange={(e) => { setName(e.target.value); setConfirmation(false); }} maxLength={200} required disabled={pending} /></label>
        <label className="grid gap-2 text-sm">数据来源<select aria-label="新数据集来源" className={SELECT} value={kind} disabled={pending} onChange={(e) => { setKind(e.target.value as 'import' | 'demo'); setConfirmation(false); }}>
          <option value="import">正式导入：使用你提供的经营记录</option><option value="demo" disabled={!demoEnabled}>演示：独立模拟数据{!demoEnabled ? '（当前环境未启用）' : ''}</option></select></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={confirmation} onChange={(e) => setConfirmation(e.target.checked)} disabled={pending} />我确认创建独立空数据集，不覆盖已有数据。</label>
        <Button type="submit" disabled={pending || !confirmation || !name.trim()}>{pending ? '正在创建…' : '创建并选择数据集'}</Button>
      </form>}{message && <p role="status" className="mt-4 text-sm">{message}</p>}
  </section>;
}

function DatasetOperations({ workspaceId, dataset, canManage, demoEnabled, catalog, jobPage, jobId, batchPage, batchId, navigate, refreshData, currentHref }: {
  workspaceId: string; dataset: Dataset; canManage: boolean; demoEnabled: boolean; catalog: DataCatalog | null;
  jobPage: number; jobId?: string; navigate: Navigation; refreshData: () => void; currentHref: string;
  batchPage: number; batchId?: string;
}) {
  const [files, setFiles] = useState<UploadChoice[]>([]); const [pending, setPending] = useState(false);
  const [message, setMessage] = useState(''); const [problem, setProblem] = useState('');
  const [jobs, setJobs] = useState<z.infer<typeof jobsSchema> | null>(null); const [detail, setDetail] = useState<DataJob | null>(null);
  const [snapshot, setSnapshot] = useState<DataSnapshot | null>(null); const [snapshotError, setSnapshotError] = useState('');
  const [reload, setReload] = useState(0); const [dialog, setDialog] = useState(false); const [clock, setClock] = useState(Date.now());
  const [template, setTemplate] = useState<Resource>('orders'); const [exportResources, setExportResources] = useState<Resource[]>([...RESOURCES]);
  const [demoDate, setDemoDate] = useState(''); const [demoSeed, setDemoSeed] = useState('1729'); const [demoConfirmed, setDemoConfirmed] = useState(false);
  const keys = useRef(new StableRequestKeys()); const sequence = useRef(0); const active = useRef(true);
  const params = scopedDataParams(workspaceId, dataset).toString();
  const currentScope = useRef(params); currentScope.current = params;
  const handledCommit = useRef(new Set<string>());
  const scopeBody = useMemo(() => ({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version }), [workspaceId, dataset.dataset_id, dataset.version]);
  useEffect(() => { active.current = true; return () => { active.current = false; sequence.current += 1; }; }, []);
  useEffect(() => { setFiles([]); setDemoConfirmed(false); setDialog(false); setDetail(null); setSnapshot(null); }, [dataset.version]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  useEffect(() => {
    const controller = new AbortController(); setSnapshot(null); setSnapshotError('');
    const expected = { dataset_id: dataset.dataset_id, version: dataset.version };
    readBi('/api/bi/query', queryResultSchema, { method: 'POST', signal: controller.signal,
      body: JSON.stringify({ ...scopeBody, query: { dimension: 'overall' } }) }).then((data) => {
      if (!sameDatasetSnapshot(workspaceId, expected, data)) throw new Error('本次结果的版本不一致，请刷新。');
      if (!controller.signal.aborted) setSnapshot(data);
    }).catch((error) => { if (!controller.signal.aborted) setSnapshotError(dataErrorMessage(error)); });
    return () => controller.abort();
  }, [workspaceId, dataset.dataset_id, dataset.version, scopeBody, reload]);

  useEffect(() => {
    const controller = new AbortController(); const request = ++sequence.current;
    let inFlight = false;
    const update = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const result = await readBi(`/api/bi/jobs?${params}&page=${jobPage}`, jobsSchema, { signal: controller.signal });
        if (controller.signal.aborted || request !== sequence.current) return;
        if (result.rows.some((job) => job.workspace_id !== workspaceId || job.dataset_id !== dataset.dataset_id)) throw new Error('任务范围不一致，请刷新。');
        setJobs(result);
        // Also refresh when a completed import is off the selected detail or another page.
        for (const job of result.rows) {
          if (job.state === 'committed' && typeof job.result.version === 'number'
              && job.result.version > dataset.version && !handledCommit.current.has(job.job_id)) {
            handledCommit.current.add(job.job_id); refreshData();
          }
        }
        if (jobId) {
          const selectedJob = await readBi(`/api/bi/jobs/${encodeURIComponent(jobId)}?${params}`, jobSchema, { signal: controller.signal });
          if (controller.signal.aborted || request !== sequence.current) return;
          if (selectedJob.workspace_id !== workspaceId || selectedJob.dataset_id !== dataset.dataset_id) throw new Error('任务范围不一致，请刷新。');
          setDetail(selectedJob);
          if (selectedJob.state === 'committed' && !handledCommit.current.has(selectedJob.job_id)) {
            handledCommit.current.add(selectedJob.job_id); setMessage('导入已提交，正在刷新数据集版本；不会自动调用模型。'); refreshData();
          }
        } else setDetail(null);
      } catch (error) { if (!controller.signal.aborted && request === sequence.current) { setProblem(dataErrorMessage(error)); setJobs(null); setDetail(null); } }
      finally { inFlight = false; }
    };
    void update(); const interval = window.setInterval(() => { void update(); }, 3000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [params, jobPage, jobId, workspaceId, dataset.dataset_id, dataset.version, reload, refreshData]);

  const execute = async (kind: DataJob['kind'], parameters: Record<string, unknown>, source?: UploadChoice[]) => {
    if (pending || (kind !== 'export_standard' && !canManage)) return;
    const startScope = params; setPending(true); setProblem(''); setMessage('正在准备提交…');
    try {
      const upload: { resource: Resource | ''; filename: string; content_base64: string }[] = [];
      if (source) {
        validateUploads(source.map(({ file, resource }) => ({ name: file.name, size: file.size, resource })));
        for (const choice of source) {
          if (!active.current || currentScope.current !== startScope) return;
          upload.push({ resource: choice.resource, filename: choice.file.name, content_base64: await fileBase64(choice.file) });
        }
      }
      const body = { ...scopeBody, kind, parameters, ...(source ? { files: upload } : {}) };
      const digest = await requestDigest(body);
      if (!active.current || currentScope.current !== startScope) return;
      const job = await readBi('/api/bi/jobs', jobSchema, { method: 'POST', body: JSON.stringify({ ...body, idempotency_key: keys.current.get(digest) }) });
      if (!active.current || currentScope.current !== startScope) return;
      setMessage('任务已提交，关闭页面后仍可在处理任务中查看。'); setFiles([]); setDialog(false); setDemoConfirmed(false);
      navigate({ jobId: job.job_id, jobPage: 1 }); setReload((value) => value + 1);
    } catch (error) { if (active.current && currentScope.current === startScope) { setProblem(dataErrorMessage(error)); setMessage('提交结果不确定时，请先查看处理任务；再次提交相同内容将复用原请求标识。'); } }
    finally { if (active.current) setPending(false); }
  };

  const action = async (job: DataJob, choice: 'cancel' | 'reauthorize') => {
    if (pending) return; const startScope = params; setPending(true); setProblem('');
    try {
      await readBi(`/api/bi/jobs/${encodeURIComponent(job.job_id)}/${choice}`, jobSchema, { method: 'POST', body: JSON.stringify(scopeBody) });
      if (active.current && currentScope.current === startScope) { setReload((value) => value + 1); setMessage(choice === 'cancel' ? '取消请求已提交，请以最终任务状态为准；已写入的数据不会被撤销。' : '已使用当前登录身份重新授权，等待处理。'); }
    } catch (error) { if (active.current && currentScope.current === startScope) setProblem(dataErrorMessage(error)); }
    finally { if (active.current) setPending(false); }
  };
  const canCommit = detail ? previewCanCommit(detail, dataset, canManage, clock) : false;
  const download = async (path: string, resource: string) => {
    setProblem('');
    try { await downloadBiFile(path, `shopgate-${resource}-v1.csv`); }
    catch (error) { if (active.current) setProblem(dataErrorMessage(error)); }
  };
  const selectedTemplate = catalog?.templates.find((entry) => entry.resource === template);
  const addFiles = (selected: FileList | null) => {
    if (!selected) return;
    const choices = [...files, ...Array.from(selected, (file) => ({ file, resource: inferResource(file.name) }))];
    if (choices.length > 36) { setProblem('每批最多36个文件，请分批导入。'); return; }
    setFiles(choices); setProblem('');
  };

  return <>
    <section className={PANEL} aria-label="当前数据集"><div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-medium text-primary">当前选择</p><h2 className="mt-1 break-all text-xl font-semibold">{dataset.name}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{dataset.source_kind === 'demo' ? '演示数据 · 独立模拟，不代表真实店铺' : '正式数据 · 仅使用你确认导入的记录'} · 当前版本 {dataset.version}</p></div>
      <span className="rounded-full bg-primary/10 px-3 py-1 text-xs text-primary">{dataset.reporting_currency} · 人民币核算</span></div>
      {snapshotError && <div className="mt-4"><Notice error>{snapshotError}</Notice></div>}
      {snapshot?.data_cutoff === null && <p className="mt-4 text-sm text-muted-foreground">尚无经营记录。空账本不表示真实营业额为零，请先导入或准备演示数据。</p>}
      {snapshot?.data_cutoff && <div className="mt-5"><p className="text-xs text-muted-foreground">最近可用业务日 {snapshot.data_cutoff} · 默认期间 {snapshot.range.start} 至 {snapshot.range.end} · 核算版本 {snapshot.accounting_revision}</p>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">{[
          ['净销售额', snapshot.summary.metrics.net_sales], ['已核算范围贡献金额', snapshot.summary.metrics.accounted_contribution],
          ['付款订单数', snapshot.summary.metrics.order_count], ['成交金额核算覆盖率', snapshot.summary.metrics.coverage_ratio],
        ].map(([label, value]) => <div key={String(label)} className="rounded-xl bg-muted/50 p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 break-all text-xl font-semibold tabular-nums">{decimalLabel(value, label === '成交金额核算覆盖率')}{label !== '付款订单数' && label !== '成交金额核算覆盖率' && value !== null ? <span className="ml-1 text-xs font-normal">元</span> : ''}</p></div>)}</div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">缺成本、规格对应关系或汇率的记录仍为待核算。贡献金额不等于包含房租、人员等全部支出的净利润。</p>
      </div>}
    </section>
    {problem && <Notice error>{problem}<Button size="sm" variant="outline" onClick={() => { setProblem(''); setReload((value) => value + 1); refreshData(); }}>刷新重试</Button>
      <Link className="ml-3 underline" href={`/login?next=${encodeURIComponent(currentHref)}`}>重新登录</Link></Notice>}
    {message && <Notice>{message}</Notice>}

    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
      <section className={PANEL}><h2 className="flex items-center gap-2 text-lg font-semibold"><Upload className="h-5 w-5 text-primary" />上传标准经营数据</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">支持十二类 CSV，可一次选择多个文件。先预览检查，整批通过并经你确认后才写入。单文件20 MB、每批60 MB，最多36个文件和10万行。</p>
        {!canManage && <p className="mt-4 text-sm text-muted-foreground">只读权限不可上传或确认，可使用右侧模板与下方导出。</p>}
        {canManage && <><label className="mt-5 grid gap-2 text-sm">选择 CSV 文件<input aria-label="选择标准经营CSV文件" type="file" accept=".csv,text/csv" multiple disabled={pending} className="block w-full max-w-full rounded-lg border border-dashed border-primary/40 bg-primary/5 p-4 text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-2 file:text-primary-foreground" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} /></label>
          <ul className="mt-4 grid gap-3">{files.map((choice, index) => <li key={`${index}:${choice.file.name}`} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto]">
            <div className="min-w-0"><p className="break-all text-sm font-medium">{choice.file.name}</p><p className="mt-1 text-xs text-muted-foreground">{(choice.file.size / 1024).toFixed(1)} KB</p>
              <select aria-label={`${choice.file.name}的数据类型`} className={`${SELECT} mt-2 w-full`} disabled={pending} value={choice.resource} onChange={(e) => setFiles((current) => current.map((item, position) => position === index ? { ...item, resource: e.target.value as Resource } : item))}>
                <option value="">请选择对应的数据类型</option>{RESOURCES.map((resource) => <option key={resource} value={resource}>{RESOURCE_LABELS[resource]}</option>)}</select></div>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}>移除文件</Button>
          </li>)}</ul>
          <Button className="mt-4" disabled={pending || !files.length || files.some((choice) => !choice.resource)} onClick={() => { void execute('preview_import', {}, files); }}><FileCheck2 className="h-4 w-4" />{pending ? '正在提交…' : '检查并生成导入预览'}</Button>
        </>}
      </section>
      <section className={PANEL}><h2 className="text-lg font-semibold">模板与字段说明</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">先按模板整理源数据。商品与标准规格、订单与明细分别提供；前导零编号不会转为数字。</p>
        <label className="mt-4 grid gap-2 text-sm">数据类型<select aria-label="查看模板类型" className={SELECT} value={template} onChange={(e) => setTemplate(e.target.value as Resource)}>{RESOURCES.map((resource) => <option key={resource} value={resource}>{RESOURCE_LABELS[resource]}</option>)}</select></label>
        <Button className="mt-3" variant="outline" onClick={() => { void download(`/api/bi/templates/${template}?${new URLSearchParams({ workspace_id: workspaceId })}`, template); }}><Download className="h-4 w-4" />下载空白模板</Button>
        {selectedTemplate ? <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-xs"><caption className="sr-only">{RESOURCE_LABELS[template]}字段说明</caption><thead><tr className="border-b border-border"><th className="p-2">字段</th><th className="p-2">要求</th><th className="p-2">可选值</th></tr></thead>
          <tbody>{selectedTemplate.fields.map((field) => <tr key={field.name} className="border-b border-border/60"><td className="p-2"><span className="font-medium">{field.label}</span><code className="mt-1 block text-muted-foreground">{field.name}</code></td><td className="p-2">{field.required ? '必填' : '可空'}</td><td className="break-words p-2 text-muted-foreground">{field.choices.length ? field.choices.map((value) => `${CHOICE_LABELS[value] ?? value}（${value}）`).join('、') : FIELD_TYPE_LABELS[field.kind] ?? '见字段名称与模板要求'}</td></tr>)}</tbody></table></div>
          : <p className="mt-4 text-sm text-muted-foreground">字段说明正在加载，或服务暂不可用；请刷新重试。</p>}
        <p className="mt-4 text-xs leading-5 text-muted-foreground">首列 template_version 固定填 1。模板用于本系统的精确导入导出，请把文本编码按原样保留；不要在表格软件中执行来源不明的公式。</p>
      </section>
    </div>

    <div className="grid items-start gap-5 lg:grid-cols-2">
      <section className={PANEL}><h2 className="text-lg font-semibold">准备独立演示数据</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">约1,000个标准规格、500个商品，覆盖3个平台、9家店铺和180天。包含活动起伏、长尾商品、成本变化、退款与待核算记录；先生成预览，不直接写入。</p>
        {dataset.source_kind !== 'demo' ? <p className="mt-4 text-sm text-muted-foreground">当前是正式导入集，不允许添加演示事实。请创建并选择新的演示集。</p>
          : !demoEnabled ? <p className="mt-4 text-sm text-muted-foreground">当前环境未启用演示生成。</p>
            : dataset.version !== 1 ? <p className="mt-4 text-sm text-muted-foreground">此演示集已更新，不会重置。需要新场景时请创建新的演示集。</p>
              : !canManage ? <p className="mt-4 text-sm text-muted-foreground">生成演示源事实需要管理权限。</p>
                : <form className="mt-4 grid gap-4" onSubmit={(event) => { event.preventDefault(); if (demoConfirmed && demoDate) void execute('prepare_demo', { start_date: demoDate, days: 180, sku_count: 1000, order_count: 12000, seed: Number(demoSeed), confirmed_by_user: true }); }}>
                  <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-2 text-sm">业务开始日期<Input aria-label="演示业务开始日期" type="date" value={demoDate} min="2000-01-01" max="2100-01-01" required disabled={pending} onChange={(e) => { setDemoDate(e.target.value); setDemoConfirmed(false); }} /></label>
                    <label className="grid gap-2 text-sm">随机种子<Input aria-label="演示随机种子" type="number" min={0} max={4294967295} step={1} value={demoSeed} required disabled={pending} onChange={(e) => { setDemoSeed(e.target.value); setDemoConfirmed(false); }} /></label></div>
                  <p className="text-xs leading-5 text-muted-foreground">日期决定业务期间。随机种子只控制抽样：相同参数可以复现同一份演示数据，不代表日期。</p>
                  <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={demoConfirmed} onChange={(e) => setDemoConfirmed(e.target.checked)} disabled={pending} />我确认仅为此空演示集准备模拟源数据，稍后另行确认是否导入。</label>
                  <Button type="submit" disabled={pending || !demoConfirmed || !demoDate}>准备演示预览</Button>
                </form>}
      </section>
      <section className={PANEL}><h2 className="text-lg font-semibold">完整标准数据导出</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">导出所选版本的全部源记录，不限于当前页；每类生成一个可重新导入的 CSV 文件。大数据由后台处理。</p>
        <fieldset className="mt-4 grid grid-cols-2 gap-2"><legend className="mb-2 text-sm">选择导出内容</legend>{RESOURCES.map((resource) => <label key={resource} className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5 accent-primary" disabled={pending} checked={exportResources.includes(resource)} onChange={(e) => setExportResources((current) => e.target.checked ? [...current, resource] : current.filter((item) => item !== resource))} />{RESOURCE_LABELS[resource]}</label>)}</fieldset>
        <Button variant="outline" className="mt-5" disabled={pending || !exportResources.length} onClick={() => { void execute('export_standard', { resources: exportResources }); }}><Download className="h-4 w-4" />创建完整导出任务</Button>
      </section>
    </div>

    <section className={PANEL} aria-label="处理任务"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-semibold">处理任务与导入记录</h2><p className="mt-2 text-sm text-muted-foreground">仅显示你在当前数据集提交的任务。自动检查进度，关闭页面后可重新进入。</p></div>
      <Button variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}><RefreshCw className="h-4 w-4" />刷新任务</Button></div>
      {!jobs && <p role="status" className="py-6 text-sm text-muted-foreground">正在读取任务…</p>}
      {jobs?.total === 0 && <p className="py-6 text-sm text-muted-foreground">还没有提交任务。上传文件、准备演示数据或导出后，会在这里记录。</p>}
      {jobs && jobs.total > 0 && <div className="mt-4 overflow-x-auto"><table className="w-full min-w-[620px] text-left text-sm"><caption className="sr-only">当前数据集的全部处理任务，可分页查看</caption><thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="p-3">操作</th><th className="p-3">状态</th><th className="p-3">数据版本</th><th className="p-3">提交时间</th><th className="p-3">详情</th></tr></thead><tbody>
        {jobs.rows.map((job) => <tr key={job.job_id} className={`border-b border-border/60 ${job.job_id === jobId ? 'bg-primary/5' : ''}`}><td className="p-3 font-medium">{JOB_LABELS[job.kind]}</td><td className="p-3">{job.stage_label}</td><td className="p-3 tabular-nums">{job.base_version}</td><td className="p-3 text-xs text-muted-foreground">{new Date(job.created_at).toLocaleString('zh-CN')}</td><td className="p-3"><Button variant="ghost" size="sm" onClick={() => navigate({ jobId: job.job_id })}>查看详情</Button></td></tr>)}
      </tbody></table></div>}
      {jobs && <Pagination label="处理任务分页" page={jobPage} total={jobs.total} change={(page) => navigate({ jobPage: page })} />}
      {detail && <JobDetail job={detail} dataset={dataset} params={params} canManage={canManage} canCommit={canCommit} pending={pending}
        openConfirmation={() => setDialog(true)} action={(choice) => { void action(detail, choice); }} download={(path, resource) => { void download(path, resource); }} />}
    </section>

    <BatchHistory key={params} workspaceId={workspaceId} dataset={dataset} page={batchPage} batchId={batchId}
      canManage={canManage} pending={pending} navigate={navigate} refresh={reload}
      confirm={async (previewId) => { await execute('confirm_import', { preview_id: previewId, confirmed_by_user: true }); }} />

    <AlertDialog open={dialog} onOpenChange={setDialog}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认写入这批经营数据？</AlertDialogTitle>
      <AlertDialogDescription>将使用你刚查看的预览写入“{dataset.name}”（版本 {dataset.version}）。提交前会再次检查权限、预览期限和数据版本；任一检查失败都不会部分写入。相同请求重复提交不会重复增加版本。</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel disabled={pending}>返回检查</AlertDialogCancel><Button disabled={pending || !canCommit} onClick={() => {
        if (!detail || !previewCanCommit(detail, dataset, canManage)) { setDialog(false); setProblem('预览已过期或版本已变化，请重新预览。'); return; }
        void execute('confirm_import', { preview_id: detail.result.preview_id, confirmed_by_user: true });
      }}>{pending ? '正在提交…' : '确认导入并更新版本'}</Button></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </>;
}

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function JobDetail({ job, dataset, params, canManage, canCommit, pending, openConfirmation, action, download }: {
  job: DataJob; dataset: Dataset; params: string; canManage: boolean; canCommit: boolean; pending: boolean;
  openConfirmation: () => void; action: (choice: 'cancel' | 'reauthorize') => void;
  download: (path: string, resource: string) => void;
}) {
  const summary = object(job.result.summary); const impact = object(job.result.impact);
  const before = object(object(impact?.before)?.metrics); const after = object(object(impact?.after)?.metrics);
  const errors = Array.isArray(job.result.errors) ? job.result.errors.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
  const sourceFiles = Array.isArray(job.result.source_files) ? job.result.source_files.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
  const exported = Array.isArray(job.result.files) ? job.result.files.map(object).filter((row): row is Record<string, unknown> => row !== null) : [];
  const stale = dataset.version !== job.base_version;
  const resultVersion = typeof job.result.version === 'number' ? job.result.version : job.base_version;
  return <article className="mt-6 rounded-xl border border-primary/25 bg-primary/[0.025] p-4 sm:p-5" aria-label="所选任务详情">
    <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">{JOB_LABELS[job.kind]} · {job.stage_label}</h3><p className="mt-2 break-all text-xs text-muted-foreground">任务编号 {job.job_id} · 原数据版本 {job.base_version}</p></div>
      {['queued', 'running', 'awaiting_auth'].includes(job.state) && (canManage || job.kind === 'export_standard') && <Button variant="outline" size="sm" disabled={pending || job.cancel_requested} onClick={() => action('cancel')}>取消任务</Button>}
    </div>
    {stale && job.state !== 'committed' && <p className="mt-3 text-sm text-muted-foreground">当前数据已是版本 {dataset.version}；本任务仍保留原版本 {job.base_version}，不会拼接新数据。需要正式修改时请重新预览。</p>}
    {job.state === 'awaiting_auth' && <div className="mt-4"><Notice error>任务权限或登录会话已失效，尚未提交的修改已回滚。请重新登录并确认当前权限后继续。</Notice>
      {!stale && (canManage || job.kind === 'export_standard') && <Button className="mt-3" disabled={pending || job.expired} onClick={() => action('reauthorize')}>使用当前登录身份重新授权</Button>}</div>}
    {job.state === 'failed' && <p className="mt-4 text-sm text-destructive">{JOB_ERROR_LABELS[job.error_code ?? ''] ?? JOB_ERROR_LABELS.BI_JOB_FAILED}</p>}
    {job.state === 'cancelled' && <p className="mt-4 text-sm text-muted-foreground">此任务已取消，没有因本任务写入经营事实。</p>}
    {job.state === 'committed' && <p role="status" className="mt-4 text-sm text-primary">{job.result.changed === false ? `此次内容与已有数据相同，未重复写入，数据仍为版本 ${resultVersion}。` : `已写入完成，结果版本为 ${resultVersion}。当前数据会自动刷新，不会自动调用模型。`}</p>}
    {sourceFiles.length > 0 && <details className="mt-4 rounded-lg border border-border p-3"><summary className="cursor-pointer text-sm font-medium">本批文件与校验摘要 · 模板版本 {typeof job.result.template_version === 'string' ? job.result.template_version : '—'}</summary>
      <ul className="mt-3 grid gap-3">{sourceFiles.map((file, index) => <li key={index} className="text-xs"><p className="break-all font-medium">{typeof file.filename === 'string' ? file.filename : '文件'}</p><p className="mt-1 break-all font-mono text-muted-foreground">SHA-256：{typeof file.sha256 === 'string' ? file.sha256 : '—'}</p></li>)}</ul></details>}
    {summary && <div className="mt-4 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-medium">本批记录检查</caption><thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="p-2">数据类型</th><th className="p-2">待新增</th><th className="p-2">完全重复</th></tr></thead><tbody>{RESOURCES.map((resource) => {
      const row = object(summary[resource]); return row ? <tr key={resource} className="border-b border-border/50"><td className="p-2">{RESOURCE_LABELS[resource]}</td><td className="p-2 tabular-nums">{decimalLabel(row.inserted)}</td><td className="p-2 tabular-nums">{decimalLabel(row.duplicates)}</td></tr> : null;
    })}</tbody></table></div>}
    {before && after && <div className="mt-5 overflow-x-auto"><table className="w-full text-left text-sm"><caption className="mb-2 text-left font-medium">导入前后试算 · 全部源事实期间</caption><thead><tr className="border-b border-border text-xs text-muted-foreground"><th className="p-2">指标</th><th className="p-2">导入前</th><th className="p-2">预计导入后</th></tr></thead><tbody>{[
      ['sales_amount', '付款成交金额'], ['refund_amount', '已完成退款金额'], ['net_sales', '净销售额'],
      ['product_cost', '商品成本净额'], ['expense_amount', '经营费用'], ['contribution_profit', '经营贡献利润'],
      ['accounted_contribution', '已核算范围贡献金额'], ['order_count', '付款订单数'], ['coverage_ratio', '成交金额核算覆盖率'],
    ].map(([metric, label]) => <tr key={metric} className="border-b border-border/50"><td className="p-2">{label}{metric !== 'order_count' && metric !== 'coverage_ratio' ? '（元）' : ''}</td><td className="p-2 tabular-nums">{decimalLabel(before[metric], metric === 'coverage_ratio')}</td><td className="p-2 tabular-nums">{decimalLabel(after[metric], metric === 'coverage_ratio')}</td></tr>)}</tbody></table>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">这只是预览，尚未写入。待核算不等于0；贡献利润不包含尚未接入的全部固定支出。</p></div>}
    {(job.state === 'ready_preview' || job.state === 'rejected') && <div className="mt-4 flex flex-wrap items-center gap-3"><Button variant="outline" size="sm" onClick={() => download(`/api/bi/jobs/${encodeURIComponent(job.job_id)}/files/errors?${params}`, 'errors')}>下载全部校验结果</Button>
      {job.state === 'ready_preview' && <><Button disabled={pending || !canCommit} onClick={openConfirmation}>检查完成，确认导入</Button>
        <span className="text-xs text-muted-foreground">{typeof job.result.preview_expires_at === 'string' ? `预览有效至 ${new Date(job.result.preview_expires_at).toLocaleString('zh-CN')}` : '预览期限暂不可确认，请重新预览'}</span></>}
      {job.state === 'ready_preview' && !canCommit && <p className="w-full text-xs text-muted-foreground">{!canManage ? '只读权限不能确认导入。' : stale ? '数据版本已变化，请重新预览。' : '预览已过期或不完整，请重新预览。'}</p>}
    </div>}
    {errors.length > 0 && <div className="mt-4 overflow-x-auto"><p className="mb-2 text-sm font-medium">发现 {typeof job.result.error_count === 'number' ? job.result.error_count : errors.length} 项问题，以下显示前 {errors.length} 项；全部问题可下载查看。</p>
      <table className="w-full text-left text-xs"><thead><tr className="border-b border-border"><th className="p-2">文件</th><th className="p-2">行</th><th className="p-2">字段</th><th className="p-2">需要修正</th></tr></thead><tbody>{errors.map((row, index) => <tr key={index} className="border-b border-border/50"><td className="break-all p-2">{typeof row.filename === 'string' ? row.filename : '—'}</td><td className="p-2">{typeof row.row === 'number' ? row.row : '—'}</td><td className="p-2">{typeof row.field === 'string' ? row.field : '—'}</td><td className="p-2">{typeof row.message === 'string' ? row.message : '请检查格式或关联关系'}</td></tr>)}</tbody></table></div>}
    {job.state === 'completed' && exported.length > 0 && <div className="mt-4"><p className="text-sm">已准备版本 {resultVersion} 的完整标准文件：</p>{job.expired && <p className="mt-2 text-sm text-muted-foreground">导出文件已到期，请重新导出；经营数据和任务记录仍保留。</p>}<ul className="mt-3 grid gap-2 sm:grid-cols-2">{exported.map((file) => typeof file.resource === 'string' && RESOURCES.includes(file.resource as Resource) ? <li key={file.resource}><Button variant="outline" size="sm" disabled={job.expired} onClick={() => download(`/api/bi/jobs/${encodeURIComponent(job.job_id)}/files/${file.resource}?${params}`, String(file.resource))}><Download className="h-4 w-4" />{RESOURCE_LABELS[file.resource as Resource]}</Button></li> : null)}</ul></div>}
  </article>;
}
