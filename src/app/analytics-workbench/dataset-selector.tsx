'use client';

import { useEffect, useRef, useState } from 'react';
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
  const selected = contracts.find((contract) => text(contract.dataset_id) === selectedDatasetId);

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
      <p className="mt-3 text-[11px] text-muted-foreground" role="status">{syncMessage}（每 15 秒检查一次导入或注册结果）</p>
    </section>
  );
}
