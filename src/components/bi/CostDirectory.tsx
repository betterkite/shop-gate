'use client';

import { useEffect, useRef, useState } from 'react';
import { CostOperations, RecalculateCosts } from './CostMaintenance';
import { CostChangeForm } from './CostChangeForm';
import { CostSimulation } from './CostSimulation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BiNotice, BiPagination, BI_PANEL, BI_SELECT } from './BiPrimitives';
import { decimalLabel, type Dataset } from '@/lib/bi/data-contracts';
import { dataErrorMessage, readBi, saveBiFile } from '@/lib/bi/data-browser';
import {
  costDirectorySchema,
  overviewQuery,
  scopeMatches,
  skuCostHistorySchema,
  type CostDirectoryData,
  type SkuCostHistory,
  type Overview,
  type OverviewLocation,
} from '@/lib/bi/overview-contracts';
import { csvCell } from '@/lib/bi/ranking-export';
import { z } from 'zod';

const conditions = {
  all: '全部规格',
  missing: '当前或付款时缺少成本',
  negative: '经营贡献为负',
  low_margin: '经营贡献利润率低于 10%',
  rising: '单位成本上涨超过 10%',
} as const;
const sorts = {
  key: '规格编号',
  name: '规格名称',
  unit_cost: '同币种单位成本',
  change_rate: '同层级成本变化比例',
  sales_amount: '付款成交金额',
  contribution_profit: '经营贡献利润',
} as const;
const levels = { base: '基础成本', channel: '平台成本', store: '店铺成本' };
const clock = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  dateStyle: 'medium',
  timeStyle: 'short',
});
const price = (v: CostDirectoryData['rows'][number]['applied'], unit: string) =>
  v ? v.unit_cost + ' ' + v.currency + ' / ' + unit : '未设置';
const largePage = costDirectorySchema.extend({ page_size: z.literal(100) });

export function CostDirectory({
  dataset,
  workspaceId,
  location,
  range,
  navigate, canManage, onSaved,
}: {
  dataset: Dataset;
  workspaceId: string;
  canManage: boolean; onSaved: () => void;
  location: OverviewLocation;
  range: Overview['range'];
  navigate: (change: Partial<OverviewLocation>) => void;
}) {
  const [selection,setSelection] = useState<string[]>([]);
  const date = location.costAsOf ?? range.end ?? '';
  const page = location.catalogPage ?? 1,
    historyPage = location.historyPage ?? 1;
  const [search, setSearch] = useState(location.catalogSearch ?? '');
  const [data, setData] = useState<{ key: string; value: CostDirectoryData }>();
  const [history, setHistory] = useState<{ key: string; value: SkuCostHistory }>();
  const [error, setError] = useState(''),
    [historyError, setHistoryError] = useState(''),
    [retry, setRetry] = useState(0);
  const [fileStatus, setFileStatus] = useState('');
  const [exporting, setExporting] = useState(false);
  const download = useRef<AbortController | null>(null);
  const area = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(520);
  const scope = { workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: dataset.version };
  const options = {
    as_of: date,
    query: { ...overviewQuery(location), start: range.start ?? undefined, end: range.end ?? undefined },
    search: location.catalogSearch ?? '',
    condition: location.catalogCondition ?? 'all',
    sort: location.catalogSort ?? 'key',
    descending: location.catalogDescending ?? false,
  };
  const body = JSON.stringify({ ...scope, options: { ...options, page } });
  const historySku = location.historySku;
  const historyBody = historySku
    ? JSON.stringify({ ...scope, options: { ...options, history_sku: historySku, page: historyPage } })
    : '';
  useEffect(() => setSearch(location.catalogSearch ?? ''), [location.catalogSearch]);
  useEffect(() => {
    if (!date) return;
    const c = new AbortController();
    setError('');
    setFileStatus('');
    setExporting(false);
    readBi('/api/bi/costs', costDirectorySchema, { method: 'POST', body, signal: c.signal })
      .then((v) => {
        if (!scopeMatches(workspaceId, dataset, v) || v.as_of !== date || v.page !== page)
          throw new Error('成本目录范围已变化，请刷新。');
        if (!c.signal.aborted) setData({ key: body, value: v });
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(dataErrorMessage(e));
      });
    return () => {
      c.abort();
      download.current?.abort();
      download.current = null;
    };
  }, [body, date, page, dataset, workspaceId, retry]);
  useEffect(() => {
    if (!historyBody) return;
    const c = new AbortController();
    setHistoryError('');
    readBi('/api/bi/costs', skuCostHistorySchema, { method: 'POST', body: historyBody, signal: c.signal })
      .then((v) => {
        if (!scopeMatches(workspaceId, dataset, v) || v.history_sku !== historySku || v.page !== historyPage)
          throw new Error('成本历史范围已变化。');
        if (!c.signal.aborted) setHistory({ key: historyBody, value: v });
      })
      .catch((e) => {
        if (!c.signal.aborted) setHistoryError(dataErrorMessage(e));
      });
    return () => c.abort();
  }, [historyBody, workspaceId, dataset, historySku, historyPage, retry]);
  const table = data?.key === body ? data.value : undefined,
    versions = history?.key === historyBody ? history.value : undefined;
  useEffect(() => {
    if (table && area.current) setHeight(area.current.getBoundingClientRect().height);
  }, [table]);
  async function exportCosts() {
    if (download.current) return;
    const c = new AbortController();
    download.current = c;
    setExporting(true);
    setFileStatus('');
    const parts = [
      '\uFEFF' +
        [
          '规格编号',
          '商品',
          '规格',
          '单位',
          '类目',
          '成本查看日期',
          '成本层级',
          '单位成本',
          '成本原币',
          '生效时间',
          '登记来源',
          '付款成交金额（元）',
          '经营贡献利润（元）',
        ]
          .map((s) => csvCell(s))
          .join(',') +
        '\r\n',
    ];
    const seen = new Set<string>();
    let total: number | undefined;
    try {
      for (let n = 1; total === undefined || seen.size < total; n++) {
        const v = await readBi('/api/bi/costs', largePage, {
          method: 'POST',
          signal: c.signal,
          body: JSON.stringify({ ...scope, options: { ...options, page: n, page_size: 100 } }),
        });
        if (
          !scopeMatches(workspaceId, dataset, v) ||
          v.page !== n ||
          v.as_of !== date ||
          (total !== undefined && total !== v.total) ||
          v.rows.length !== Math.min(100, v.total - seen.size)
        )
          throw new Error('成本数据发生变化，请重新导出。');
        total = v.total;
        for (const row of v.rows) {
          if (seen.has(row.key)) throw new Error('成本结果重复，请重新导出。');
          seen.add(row.key);
          const a = row.applied;
          parts.push(
            [
              row.key,
              row.product_name,
              row.name,
              row.unit,
              row.category,
              date,
              a ? levels[a.level] : '未设置',
              a?.unit_cost ?? '',
              a?.currency ?? '',
              a?.valid_from ?? '',
              a?.source ?? '',
            ]
              .map((s) => csvCell(s, true))
              .concat(
                [row.metrics.sales_amount, row.metrics.contribution_profit].map((v) =>
                  csvCell(v == null ? '待核算' : String(v)),
                ),
              )
              .join(',') + '\r\n',
          );
        }
      }
      c.signal.throwIfAborted();
      saveBiFile(
        new Blob(parts, { type: 'text/csv;charset=utf-8' }),
        '当前商品成本-' + date + '-v' + dataset.version + '.csv',
      );
      setFileStatus('已导出 ' + seen.size + ' 个规格。');
    } catch (e) {
      if (!c.signal.aborted) setFileStatus(dataErrorMessage(e));
    } finally {
      if (download.current === c) {
        download.current = null;
        setExporting(false);
      }
    }
  }
  if (!date)
    return (
      <BiNotice>
        请先选择成本查看日期。
        <Input
          type="date"
          aria-label="成本查看日期"
          onChange={(e) => navigate({ costAsOf: e.target.value })}
        />
      </BiNotice>
    );
  return (
    <section
      ref={area}
      aria-label="商品成本目录"
      className={BI_PANEL}
      style={!table ? { minHeight: height } : undefined}
    >
      <h3 className="font-semibold">标准规格成本</h3>
      <p className="my-3 text-sm text-muted-foreground">
        成本查看日期决定采用哪一版规则。成交和经营贡献沿用上方的经营期间。选定店铺时优先使用该店的成本，其次使用平台成本，最后使用基础成本。
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          成本查看日期
          <Input
            type="date"
            value={date}
            onChange={(e) => {
              if (e.target.value) navigate({ costAsOf: e.target.value });
            }}
          />
        </label>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            navigate({ catalogSearch: search.trim() });
          }}
        >
          <label className="text-sm">
            搜索商品或规格
            <Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={200} />
          </label>
          <Button size="sm" variant="outline">
            搜索
          </Button>
        </form>
        <label className="text-sm">
          成本情况{' '}
          <select
            className={BI_SELECT}
            value={options.condition}
            onChange={(e) =>
              navigate({ catalogCondition: e.target.value as OverviewLocation['catalogCondition'] })
            }
          >
            {Object.entries(conditions).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          目录排序{' '}
          <select
            className={BI_SELECT}
            value={options.sort}
            onChange={(e) => navigate({ catalogSort: e.target.value as OverviewLocation['catalogSort'] })}
          >
            {Object.entries(sorts).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() => navigate({ catalogDescending: !options.descending })}
        >
          {options.descending ? '降序' : '升序'}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!table || exporting}
          onClick={() => {
            void exportCosts();
          }}
        >
          导出全部当前成本
        </Button>
      </div>
      {fileStatus && <p role="status">{fileStatus}</p>}
      {error && (
        <BiNotice error>
          {error}{' '}
          <Button size="sm" onClick={() => setRetry((n) => n + 1)}>
            重新读取
          </Button>
        </BiNotice>
      )}
      {!table && !error && <p role="status">正在核对成本版本和经营记录…</p>}
      {table && (
        <>
          <p className="my-3 text-sm">
            所选目录共 {table.counts.catalog} 个标准规格，其中 {table.counts.with_cost}{' '}
            个有当日生效成本；所选经营范围的成交金额核算覆盖率为 {decimalLabel(table.sales_coverage, true)}。
          </p>
          {canManage && selection.length > 0 && <CostChangeForm scope={scope} selected={selection}
            store={location.storeId} channel={location.channelId} onSaved={onSaved} />}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[780px] text-left text-sm">
              <caption className="sr-only">商品成本和经营表现</caption>
              <thead>
                <tr>
                  {[
                    ...(canManage ? ['选择规格'] : []),
                    '商品和标准规格',
                    '当前成本及来源',
                    '基础成本',
                    '较同层上版变化',
                    '本期成交（元）',
                    '经营贡献（元）',
                    '历史',
                  ].map((v) => (
                    <th className="p-2" key={v}>
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r) => (
                  <tr key={r.key} className="border-t border-border">
                    {canManage && <td><input type="checkbox" aria-label={'选择规格 ' + r.key} checked={selection.includes(r.key)}
                      onChange={e=>setSelection(keys => e.target.checked ? [...keys, r.key].sort() : keys.filter(k=>k!==r.key))}/></td>}
                    <th className="p-2">
                      {r.product_name} · {r.name}
                      <small className="block font-normal">{r.key}</small>
                    </th>
                    <td className="p-2">
                      {price(r.applied, r.unit)}
                      {r.applied && (
                        <small className="block">
                          {levels[r.applied.level]} · {r.applied.source}
                        </small>
                      )}
                    </td>
                    <td className="p-2">{price(r.base, r.unit)}</td>
                    <td className="p-2">
                      {r.change_rate == null ? '无可比版本' : decimalLabel(r.change_rate, true)}
                    </td>
                    <td className="p-2">{decimalLabel(r.metrics.sales_amount)}</td>
                    <td className="p-2">{decimalLabel(r.metrics.contribution_profit)}</td>
                    <td>
                      <Button variant="outline" size="sm" onClick={() => navigate({ historySku: r.key })}>
                        查看 {r.key} 的版本
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!table.rows.length && <p>这一页没有符合条件的标准规格。</p>}
          <BiPagination
            page={page}
            total={table.total}
            label="成本目录分页"
            change={(catalogPage) => navigate({ catalogPage })}
          />
        </>
      )}
      {canManage && <RecalculateCosts scope={scope} query={options.query} selected={selection} onSaved={onSaved} />}
      <CostOperations scope={scope} previewId={location.costOperation} page={location.operationPage ?? 1}
        open={costOperation=>navigate({costOperation})} move={operationPage=>navigate({operationPage})} />
      {historySku && (
        <section aria-label="标准规格成本版本" className="mt-4 rounded border border-border p-3">
          <div className="flex justify-between">
            <h4>{historySku} 的成本版本</h4>
            <Button size="sm" variant="ghost" onClick={() => navigate({ historySku: undefined })}>
              收起历史
            </Button>
          </div>
          {table?.rows.find(r => r.key === historySku) && <CostSimulation key={body + historySku}
            scope={scope} sku={historySku} unit={table.rows.find(r => r.key === historySku)!.unit} query={options.query} />}
          {historyError ? (
            <BiNotice error>
              {historyError}{' '}
              <Button size="sm" onClick={() => setRetry((n) => n + 1)}>
                重新读取
              </Button>
            </BiNotice>
          ) : !versions ? (
            <p role="status">正在查找版本…</p>
          ) : (
            <>
              {versions.rows.map((v) => (
                <div key={v.cost_id} className="border-t border-border py-2 text-sm">
                  <strong>
                    {levels[v.level]} · {v.unit_cost} {v.currency}
                  </strong>{' '}
                  · {v.source}
                  <p>
                    生效于 {clock.format(new Date(v.valid_from))}，
                    {v.valid_to ? '结束于 ' + clock.format(new Date(v.valid_to)) : '尚无结束日期'}
                    。登记于数据版本 {v.created_version}。{v.superseded_version && `已由第 ${v.superseded_version} 版替代。`}
                  </p>
                </div>
              ))}
              {!versions.rows.length && <p>此规格在当前层级没有成本版本。</p>}
              <BiPagination
                page={historyPage}
                total={versions.total}
                label="成本版本分页"
                change={(historyPage) => navigate({ historyPage })}
              />
            </>
          )}
        </section>
      )}
    </section>
  );
}
