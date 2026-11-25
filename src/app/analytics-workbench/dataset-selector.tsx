'use client';

import { useRouter } from 'next/navigation';

export function buildDatasetActivationUrl(currentHref: string, datasetId: string): string {
  const url = new URL(currentHref, 'http://shopgate.local');
  url.searchParams.set('dataset_id', datasetId);
  return url.pathname + url.search + url.hash;
}

export function DatasetSelector({ contracts, selectedDatasetId }: {
  contracts: Record<string, unknown>[]; selectedDatasetId: string;
}) {
  const router = useRouter();
  const options = contracts.filter(row => typeof row.dataset_id === 'string');
  return <label className="mb-4 flex flex-wrap items-center gap-3 text-sm">
    历史数据集
    <select value={selectedDatasetId} className="max-w-full rounded-lg border bg-background px-3 py-2"
      onChange={e => router.push(buildDatasetActivationUrl(window.location.href, e.target.value), { scroll: false })}>
      {!options.some(row => row.dataset_id === selectedDatasetId) && <option value={selectedDatasetId}>{selectedDatasetId}</option>}
      {options.map(row => <option key={String(row.dataset_id)} value={String(row.dataset_id)}>{String(row.name || row.dataset_id)}</option>)}
    </select>
  </label>;
}
