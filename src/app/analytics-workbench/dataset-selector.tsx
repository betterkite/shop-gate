'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function asArray(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    : [];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function number(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function text(value: unknown, fallback = '-'): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function datasetRowCount(contract: JsonRecord): number {
  const counts = asRecord(contract.row_counts);
  return Object.values(counts ?? {}).reduce<number>((total, value) => total + number(value), 0);
}

function datasetSignature(contracts: JsonRecord[]): string {
  return JSON.stringify(contracts.map((contract) => ({
    dataset_id: contract.dataset_id,
    version: contract.version,
    created_at: contract.created_at,
    row_counts: contract.row_counts,
  })));
}

export function DatasetSelector({
  contracts,
  selectedDatasetId,
  view,
  dimension,
  value,
  apiBaseUrl,
}: {
  contracts: JsonRecord[];
  selectedDatasetId: string;
  view: string;
  dimension?: string;
  value?: string;
  apiBaseUrl: string;
}) {
  const router = useRouter();
  const signatureRef = useRef(datasetSignature(contracts));
  const [syncMessage, setSyncMessage] = useState('自动检查已开启');
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [jobs, setJobs] = useState<JsonRecord[]>([]);
  const selected = contracts.find((contract) => text(contract.dataset_id) === selectedDatasetId);

  const handleImport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setImporting(true);
    setImportMessage('正在生成数据集并执行质量扫描…');
    const form = new FormData(event.currentTarget);
    const payload = {
      dataset_id: String(form.get('dataset_id') || '').trim(),
      users: Number(form.get('users') || 1_000),
      items: Number(form.get('items') || 1_000),
      days: Number(form.get('days') || 30),
      seed: Number(form.get('seed') || 20251203),
      end_day: String(form.get('end_day') || '2025-12-03'),
    };
    try {
      const response = await fetch(`${apiBaseUrl}/api/v1/commerce/datasets/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const created = await response.json().catch(() => ({}));
      if (!response.ok || typeof created.job_id !== 'string') {
        throw new Error(typeof created.detail === 'string' ? created.detail : '数据集导入任务创建失败。');
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        const statusResponse = await fetch(`${apiBaseUrl}/api/v1/commerce/datasets/import/${encodeURIComponent(created.job_id)}`, { cache: 'no-store' });
        const status = await statusResponse.json().catch(() => ({}));
        if (status.status === 'completed') {
          setImportMessage(`数据集 ${payload.dataset_id} 已导入并通过质量扫描；已加入选择器。`);
          signatureRef.current = '';
          router.refresh();
          return;
        }
        if (status.status === 'failed') {
          throw new Error(typeof status.error === 'string' ? status.error : '数据集质量扫描未通过。');
        }
        if (attempt % 5 === 4) setImportMessage(`数据集导入进行中（${status.progress ?? 0}%）…`);
      }
      throw new Error('数据集导入等待超时，请到任务状态或日志中继续核查。');
    } catch (error) {
      setImportMessage(error instanceof Error ? error.message : '数据集导入失败。');
    } finally {
      setImporting(false);
    }
  };

  useEffect(() => {
    signatureRef.current = datasetSignature(contracts);
  }, [contracts]);

  useEffect(() => {
    let active = true;
    const checkForDatasetRefresh = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/commerce/datasets`, { cache: 'no-store' });
        if (!response.ok || !active) return;
        const nextContracts = asArray(await response.json());
        const nextSignature = datasetSignature(nextContracts);
        if (nextSignature !== signatureRef.current) {
          signatureRef.current = nextSignature;
          setSyncMessage('发现数据集更新，正在刷新分析…');
          router.refresh();
        }
      } catch {
        if (active) setSyncMessage('自动检查暂时不可用，当前分析仍可继续查看');
      }
    };

    const interval = window.setInterval(checkForDatasetRefresh, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [apiBaseUrl, router]);

  useEffect(() => {
    let active = true;
    const loadJobs = async () => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/v1/commerce/datasets/import?limit=8`, { cache: 'no-store' });
        if (!response.ok || !active) return;
        setJobs(asArray(await response.json()));
      } catch {
        // The dataset selector remains usable when the optional task history is unavailable.
      }
    };
    void loadJobs();
    const interval = window.setInterval(loadJobs, 15_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [apiBaseUrl]);

  return (
    <section className="mb-5 rounded-2xl border border-border/70 bg-card/90 p-4 shadow-sm" aria-label="经营分析数据集">
      <form method="get" className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <input type="hidden" name="view" value={view} />
        {view === 'drilldown' && dimension ? <input type="hidden" name="dimension" value={dimension} /> : null}
        {view === 'drilldown' && value ? <input type="hidden" name="value" value={value} /> : null}
        <label className="min-w-0 flex-1">
          <span className="text-sm font-semibold">分析数据集</span>
          <span className="mt-1 block text-xs leading-5 text-muted-foreground">切换后会重新读取当前视图的全部分析结果；不会把其他数据集的数据混入当前页面。</span>
          <select name="dataset_id" defaultValue={selectedDatasetId} className="mt-2 w-full rounded-xl border border-border/70 bg-background px-3 py-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20" disabled={!contracts.length}>
            {contracts.length ? contracts.map((contract) => {
              const id = text(contract.dataset_id);
              return <option key={id} value={id}>{id} · {text(contract.source_kind, '未标注来源')}</option>;
            }) : <option value={selectedDatasetId}>{selectedDatasetId} · 数据集列表暂不可用</option>}
          </select>
        </label>
        <button type="submit" className="rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" disabled={!contracts.length}>切换并刷新分析</button>
      </form>
      {selected ? (
        <div className="mt-3 grid gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
          <span>数据窗口：{text(selected.window_start)} ~ {text(selected.window_end)}</span>
          <span>来源：{text(selected.source_name, text(selected.source_kind, '未标注'))}</span>
          <span>契约版本：{text(selected.version, '未标注')}</span>
          <span>记录数：{new Intl.NumberFormat('zh-CN').format(datasetRowCount(selected))}</span>
          <span className="sm:col-span-2 lg:col-span-4">合成字段：{asStringArray(selected.synthetic_fields).join('、') || '无特别标注'}</span>
        </div>
      ) : (
        <p className="mt-3 border-t border-border/60 pt-3 text-xs text-amber-700">当前数据集未出现在契约列表中，请先确认 commerce-data 已启动且数据集已注册。</p>
      )}
      <details className="mt-4 border-t border-border/60 pt-3">
        <summary className="cursor-pointer text-sm font-semibold">导入新的合成经营分析数据集</summary>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">这里只生成隔离的合成演示数据，并自动执行质量扫描；真实 CSV 和第三方数据仍需走离线连接器，不会在网页端绕过数据来源审核。</p>
        <form onSubmit={handleImport} className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label className="lg:col-span-2"><span className="text-xs font-medium">数据集编号</span><input name="dataset_id" defaultValue="retail-demo-new" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,119}" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <label><span className="text-xs font-medium">用户数</span><input name="users" type="number" min="1" max="5000" defaultValue="1000" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <label><span className="text-xs font-medium">商品数</span><input name="items" type="number" min="1" max="5000" defaultValue="1000" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <label><span className="text-xs font-medium">天数</span><input name="days" type="number" min="1" max="180" defaultValue="30" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <label><span className="text-xs font-medium">窗口结束日</span><input name="end_day" type="date" defaultValue="2025-12-03" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <label><span className="text-xs font-medium">随机种子</span><input name="seed" type="number" defaultValue="20251203" className="mt-1 w-full rounded-lg border border-border/70 bg-background px-2.5 py-2 text-sm" /></label>
          <div className="flex items-end lg:col-span-2"><button type="submit" disabled={importing} className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">{importing ? '正在导入…' : '开始导入并扫描'}</button></div>
        </form>
        {importMessage ? <p className="mt-2 text-xs leading-5 text-muted-foreground" role="status">{importMessage}</p> : null}
      </details>
      {jobs.length ? (
        <div className="mt-4 border-t border-border/60 pt-3">
          <p className="text-sm font-semibold">最近的数据集任务</p>
          <div className="mt-2 grid gap-2">
            {jobs.map((job) => {
              const payload = asRecord(job.payload);
              const result = asRecord(job.result);
              const status = text(job.status, 'unknown');
              const statusLabel = status === 'completed' ? '已完成' : status === 'failed' ? '失败' : status === 'running' ? '进行中' : '排队中';
              return <div key={text(job.id)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/30 px-3 py-2 text-xs"><span className="font-medium">{text(payload?.dataset_id, '未命名数据集')}</span><span className={status === 'failed' ? 'text-destructive' : status === 'completed' ? 'text-emerald-700' : 'text-amber-700'}>{statusLabel} · {Math.round(number(job.progress) * 100)}%</span><span className="text-muted-foreground">{status === 'failed' ? text(job.error, '未记录失败原因') : result ? '已生成并完成质量扫描' : '任务状态已记录'}</span></div>;
            })}
          </div>
        </div>
      ) : null}
      <p className="mt-3 text-[11px] text-muted-foreground" role="status">{syncMessage}（每 15 秒检查一次导入或注册结果）</p>
    </section>
  );
}
