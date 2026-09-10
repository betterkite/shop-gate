/**
 * Shop Gate 零售工作空间模板（PRD §6/§8.1）。
 *
 * 约束：
 * - 生成的工作空间是零依赖 Next.js server component：直接 fs 读取
 *   data_file/final/dashboard-data.json，不引入图表库；
 * - 视觉语言使用 `data-visual-language="retail-workbench"` 标记，
 *   共享样式来自 ./scaffold-visual-language 的 workbench CSS；
 * - 金额/库存来自合成主数据，凡涉及金额的模块必须渲染“合成口径”徽标
 *   （PRD §5.3 红线）；
 * - 图表用内联 SVG，满足视觉验证的最小尺寸（≥280×140）与首屏密度。
 */

import { baseDashboardWorkbenchCss } from './scaffold-visual-language';

const HELPERS = `type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function displayNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  return number === null ? '-' : new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(number);
}

function displayMoney(value: unknown): string {
  const number = numeric(value);
  return number === null ? '-' : '¥' + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(number);
}

function displayPercent(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) return '-';
  const ratio = Math.abs(number) <= 1 ? number * 100 : number;
  return (number < 0 ? '' : '') + new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(ratio) + '%';
}

function text(value: unknown, fallback = '-'): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function behaviorLabel(value: unknown): string {
  const labels: Record<string, string> = {
    pv: '页面浏览量（PV）',
    fav: '收藏（Fav）',
    cart: '加购（Cart）',
    buy: '购买（Buy）',
  };
  return labels[String(value)] ?? text(value);
}

function metricLabel(value: unknown): string {
  const labels: Record<string, string> = {
    gmv: '成交总额（GMV）',
    pv: '页面浏览量（PV）',
    uv: '独立访客（UV）',
    fav: '收藏（Fav）',
    cart: '加购（Cart）',
    buy: '购买（Buy）',
    buyers: '购买用户数',
  };
  return labels[String(value)] ?? text(value);
}

function windowLabel(windowValue: unknown): string {
  const record = asRecord(windowValue);
  if (!record) return '数据窗口';
  return text(record.start) + ' ~ ' + text(record.end);
}

async function readDashboardData(): Promise<JsonRecord | null> {
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function svgBars(entries: Array<{ label: string; value: number }>, unitLabel: string): string {
  const width = 720;
  const height = 240;
  const max = Math.max(...entries.map((entry) => entry.value), 1);
  const barWidth = Math.floor((width - 24) / Math.max(entries.length, 1)) - 8;
  const bars = entries
    .map((entry, index) => {
      const barHeight = Math.max(2, Math.round((entry.value / max) * (height - 56)));
      const x = 16 + index * (barWidth + 8);
      const y = height - 28 - barHeight;
      return '<rect x="' + x + '" y="' + y + '" width="' + barWidth + '" height="' + barHeight +
        '" fill="#2563eb" rx="2" />' +
        '<text x="' + (x + barWidth / 2) + '" y="' + (y - 6) + '" font-size="11" text-anchor="middle" fill="#0f172a">' +
        entry.label.slice(0, 10) + '</text>';
    })
    .join('');
  return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="' + unitLabel + '" ' +
    'style="width:100%;max-width:760px;height:auto" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="8" y1="' + (height - 28) + '" x2="' + (width - 8) + '" y2="' + (height - 28) + '" stroke="#cbd5e1" />' +
    bars + '</svg>';
}

function svgDailyLines(series: Array<{ stat_date: string } & Record<string, number>>): string {
  const width = 720;
  const height = 280;
  const top = 38;
  const left = 44;
  const right = 20;
  const bottom = height - 34;
  const metrics: Array<[string, string, string]> = [
    ['pv', '#2563eb', '页面浏览量（PV）'],
    ['cart', '#f59e0b', '加购（Cart）'],
    ['buy', '#16a34a', '购买（Buy）'],
  ];
  const stepX = series.length > 1 ? (width - left - right) / (series.length - 1) : 0;
  const maxValue = Math.max(...metrics.flatMap(([key]) => series.map((point) => numeric(point[key]) ?? 0)), 1);
  const paths = metrics.map(([key, color]) => {
    const points = series.map((point, index) => {
      const value = numeric(point[key]) ?? 0;
      const x = left + index * stepX;
      const y = bottom - (value / maxValue) * (bottom - top);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    const dots = series.map((point, index) => {
      const value = numeric(point[key]) ?? 0;
      const x = left + index * stepX;
      const y = bottom - (value / maxValue) * (bottom - top);
      return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="2.5" fill="' + color + '" />';
    }).join('');
    return '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" points="' + points + '" />' + dots;
  }).join('');
  const legend = metrics.map(([key, color, label], index) => {
    const latest = numeric(series[series.length - 1]?.[key]) ?? 0;
    const x = 150 + index * 190;
    return '<circle cx="' + x + '" cy="18" r="4" fill="' + color + '" />' +
      '<text x="' + (x + 8) + '" y="22" font-size="11" fill="#334155">' + label + '：' + displayNumber(latest, 0) + '</text>';
  }).join('');
  const labels = series.map((point, index) =>
    index % Math.ceil(series.length / 9 || 1) === 0
      ? '<text x="' + (left + index * stepX) + '" y="' + (height - 8) + '" font-size="10" text-anchor="middle" fill="#475569">' +
        point.stat_date.slice(5) + '</text>'
      : '').join('');
  return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="分日趋势" ' +
    'style="width:100%;max-width:760px;height:auto" xmlns="http://www.w3.org/2000/svg">' +
    legend +
    '<line x1="' + left + '" y1="' + bottom + '" x2="' + (width - right) + '" y2="' + bottom + '" stroke="#cbd5e1" />' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + left + '" y2="' + bottom + '" stroke="#cbd5e1" />' +
    paths + labels + '</svg>';
}

function svgDonut(segments: Array<{ label: string; value: number; color: string }>, unitLabel: string): string {
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const r = 78;
  const stroke = 34;
  const circumference = 2 * Math.PI * r;
  const total = Math.max(1, segments.reduce((sum, seg) => sum + (seg.value || 0), 0));
  let cumulative = 0;
  const arcs = segments
    .map((seg) => {
      const value = seg.value || 0;
      const frac = value / total;
      const angle = (cumulative / total) * 360 - 90;
      cumulative += value;
      const dash = (frac * circumference).toFixed(2);
      const gap = (circumference - frac * circumference).toFixed(2);
      return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + seg.color +
        '" stroke-width="' + stroke + '" stroke-dasharray="' + dash + ' ' + gap +
        '" transform="rotate(' + angle.toFixed(1) + ' ' + cx + ' ' + cy + ')" />';
    })
    .join('');
  const leading = segments[0] && total > 0 ? Math.round((segments[0].value / total) * 100) : 0;
  return '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + unitLabel + '" ' +
    'style="width:100%;max-width:240px;height:auto" xmlns="http://www.w3.org/2000/svg">' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="#f1f5f9" stroke-width="' + stroke + '" />' +
    arcs +
    '<text x="' + cx + '" y="' + (cy + 5) + '" font-size="18" text-anchor="middle" fill="#0f172a">' + leading + '%</text>' +
    '<text x="' + cx + '" y="' + (cy + 22) + '" font-size="10" text-anchor="middle" fill="#64748b">' + unitLabel + '</text>' +
    '</svg>';
}

function syntheticBadge() {
  return <span className="synthetic-badge" title="商品价格、库存、渠道和成交金额使用演示数据，不代表真实订单金额">演示数据</span>;
}
`;

const MISSING_DATA_PANEL = `function MissingDataPanel() {
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>零售经营看板</h1>
        <p>数据文件 data_file/final/dashboard-data.json 缺失或不是合法 JSON，无法生成看板。</p>
        <p>请检查 data_prefetch 产物与 evidence/data_quality.json 后重试。</p>
      </section>
    </main>
  );
}`;

function pageWrapper(body: string, defaultExportName: string): string {
  return `import fs from 'fs/promises';

${HELPERS}

${MISSING_DATA_PANEL}

export default async function ${defaultExportName}() {
  const data = await readDashboardData();
  if (!data) return <MissingDataPanel />;
  const datasets = asRecord(data.datasets) ?? {};
  ${body}
}
`;
}

/** 漏斗能力模板（retail.traffic-funnel）。 */
export function retailFunnelPageTemplate(): string {
  return pageWrapper(
    `const funnel = asRecord(datasets.funnel);
  const funnelStages = asArray(funnel?.stages).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const uniqueUsers = asRecord(funnel?.unique_users);
  const funnelDaily = asArray(asRecord(datasets.funnelDaily)?.rows);
  const meta = asRecord(datasets.meta);
  const windowText = windowLabel(data.window);
  const planned = asRecord(data.plannedEntities);
  const categoryCount = asArray(planned?.categoryIds).length;
  const itemCount = asArray(planned?.itemIds).length;
  const scopeText = categoryCount === 0 && itemCount === 0
    ? '全库口径（数据窗口内全部类目/商品）'
    : '类目 ' + categoryCount + ' 个 / 商品 ' + itemCount + ' 个';
  const funnelBars = funnelStages.map((stage) => ({
    label: behaviorLabel(stage.stage),
    value: numeric(stage.events) ?? 0,
  }));
  const stageColors: Record<string, string> = { pv: '#2563eb', fav: '#8b5cf6', cart: '#f59e0b', buy: '#16a34a' };
  const funnelDonut = funnelStages.map((stage) => ({
    label: text(stage.stage),
    value: numeric(stage.events) ?? 0,
    color: stageColors[text(stage.stage)] ?? '#94a3b8',
  }));
  const largestEventDrop = funnelStages.slice(1)
    .map((stage, index) => ({
      from: behaviorLabel(funnelStages[index].stage),
      to: behaviorLabel(stage.stage),
      drop: Math.max(0, (numeric(funnelStages[index].events) ?? 0) - (numeric(stage.events) ?? 0)),
    }))
    .sort((left, right) => right.drop - left.drop)[0];
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>流量与转化漏斗</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">口径：{scopeText}</span>
          <span className="meta-item">数据源：真实行为流</span>
        </div>
      </section>
      <section className="chart-zone">
        <h2>行为漏斗（页面浏览量（PV） → 收藏（Fav） → 加购（Cart） → 购买（Buy））</h2>
        {funnelBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(funnelBars, '事件漏斗') }} /> : <p>漏斗数据缺失。</p>}
        <table className="dense-table">
          <thead><tr><th>阶段</th><th>事件数</th><th>独立用户数</th><th>事件相对上一阶段</th><th>用户触达率（相对 PV 用户）</th></tr></thead>
          <tbody>
            {funnelStages.map((stage, index) => (
              <tr key={'stage-' + index}>
                <td>{behaviorLabel(stage.stage)}</td>
                <td>{displayNumber(stage.events, 0)}</td>
                <td>{displayNumber(uniqueUsers?.[String(stage.stage)] ?? stage.unique_users, 0)}</td>
                <td>{stage.conversion_from_previous === null || stage.conversion_from_previous === undefined ? '-' : displayPercent(stage.conversion_from_previous)}</td>
                <td>{stage.user_reach_from_pv === undefined ? '-' : displayPercent(stage.user_reach_from_pv)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">事件数允许同一用户重复计数；独立用户数按 user_id 去重。用户触达率 = 当前阶段独立用户数 / 页面浏览量（PV）独立用户数。</p>
      </section>
      <section className="insight-strip">
        <article><span>最大事件流失</span><strong>{largestEventDrop ? largestEventDrop.from + ' → ' + largestEventDrop.to + '，减少 ' + displayNumber(largestEventDrop.drop, 0) + ' 次' : '暂无足够数据'}</strong></article>
        <article><span>购买用户触达率</span><strong>{displayPercent(funnelStages.find((stage) => String(stage.stage) === 'buy')?.user_reach_from_pv)}</strong></article>
        <article><span>分析建议</span><strong>{largestEventDrop ? largestEventDrop.from + '到' + largestEventDrop.to + '的转化下降较多，建议检查商品页面、价格和优惠信息' : '至少需要两天行为数据才能比较变化'}</strong></article>
      </section>
      <section className="chart-zone">
        <h2>漏斗阶段占比</h2>
        {funnelDonut.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDonut(funnelDonut, '漏斗阶段占比') }} /> : <p>漏斗数据缺失。</p>}
      </section>
      <section className="chart-zone">
        <h2>分日趋势</h2>
        {funnelDaily.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDailyLines(funnelDaily.map(asRecord).filter(Boolean) as Array<{ stat_date: string } & Record<string, number>>) }} /> : <p>分日数据缺失。</p>}
        <p className="footnote">页面浏览量（PV）是打开商品页面的次数；购买转化率 = 购买次数 ÷ 页面浏览量。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据更新时间：{windowLabel(data.window)}（数据截至窗口末日）。</span>
        <span>行为数据：{String(meta?.behavior_source ?? "") === "synthetic" ? "演示行为数据" : "真实用户行为数据（" + String(meta?.behavior_source ?? "") + "）"}</span>
        <span>商品价格、库存、渠道、成本和毛利：演示或估算数据</span>
        <span>只统计当前数据窗口，窗口外没有数据。</span>
        {syntheticBadge()}
      </footer>
    </main>
  );`,
    'RetailFunnelDashboard',
  );
}

/** 类目结构模板（retail.catalog-structure）。 */
export function retailCatalogPageTemplate(): string {
  return pageWrapper(
    `const categories = asArray(asRecord(asRecord(datasets.categories)?.window ? datasets.categories : datasets.categories)?.rows);
  const ranked = categories.map(asRecord).filter((record): record is JsonRecord => record !== null);
  const meta = asRecord(datasets.meta);
  const windowText = windowLabel(data.window);
  const totalGmv = ranked.reduce((sum, row) => sum + (numeric(row.gmv) ?? 0), 0);
  const totalPv = ranked.reduce((sum, row) => sum + (numeric(row.pv) ?? 0), 0);
  const totalBuy = ranked.reduce((sum, row) => sum + (numeric(row.buy) ?? 0), 0);
  const overallConversion = totalPv > 0 ? totalBuy / totalPv : 0;
  const top5Gmv = ranked.slice(0, 5).reduce((sum, row) => sum + (numeric(row.gmv) ?? 0), 0);
  const concentration = totalGmv > 0 ? top5Gmv / totalGmv : null;
  const gmvBars = ranked.slice(0, 8).map((row) => ({ label: text(row.category_name), value: numeric(row.gmv) ?? 0 }));
  const donutSegments = totalGmv > 0
    ? [{ label: 'Top-5', value: top5Gmv, color: '#2563eb' }, { label: '其他', value: totalGmv - top5Gmv, color: '#cbd5e1' }]
    : [];
  const highTrafficLowConversion = ranked
    .filter((row) => (numeric(row.pv) ?? 0) >= Math.max(1, totalPv * 0.05) && (numeric(row.buy_conversion) ?? 0) < overallConversion)
    .sort((left, right) => (numeric(right.pv) ?? 0) - (numeric(left.pv) ?? 0))
    .slice(0, 5);
  const dailySeries = asArray(asRecord(datasets.funnelDaily)?.rows)
    .map(asRecord).filter((record): record is JsonRecord => record !== null);
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>类目与商品结构</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">类目数：{ranked.length}</span>
          <span className="meta-item">集中度（Top-5 成交总额（GMV））：{concentration === null ? '-' : displayPercent(concentration, 1)}</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="chart-zone">
        <h2>类目成交总额（GMV）排名</h2>
        {gmvBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(gmvBars, '类目GMV') }} /> : <p>类目数据缺失。</p>}
        <table className="dense-table">
          <thead><tr><th>类目</th><th>页面浏览量（PV）</th><th>购买</th><th>成交总额（GMV）</th><th>转化率</th><th>客单价</th></tr></thead>
          <tbody>
            {ranked.slice(0, 12).map((row, index) => (
              <tr key={'cat-' + index}>
                <td>{text(row.category_name)}</td>
                <td>{displayNumber(row.pv, 0)}</td>
                <td>{displayNumber(row.buy, 0)}</td>
                <td>{displayMoney(row.gmv)}</td>
                <td>{displayPercent(row.buy_conversion)}</td>
                <td>{displayMoney(row.avg_price)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">类目名称和商品价格来自演示数据；成交总额（GMV）按购买次数 × 商品价格估算。</p>
      </section>
      <section className="chart-zone">
        <h2>类目集中度（Top-5 成交总额（GMV）占比）</h2>
        {donutSegments.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDonut(donutSegments, 'Top-5 占比') }} /> : <p>集中度缺数据。</p>}
        <p className="footnote">集中度 = 前 5 个类目成交总额（GMV）/ 全部类目成交总额；金额按商品价格估算。</p>
      </section>
      <section className="chart-zone">
        <h2>高浏览低购买类目</h2>
        <p className="footnote">筛选条件：类目页面浏览量（PV）至少占总浏览量 5%，但购买转化率低于整体水平 {displayPercent(overallConversion)}。</p>
        {highTrafficLowConversion.length > 0 ? (
          <table className="dense-table">
            <thead><tr><th>类目</th><th>页面浏览量（PV）</th><th>成交总额（GMV）</th><th>购买转化率</th><th>与整体差距</th><th>原因与建议</th></tr></thead>
            <tbody>{highTrafficLowConversion.map((row, index) => <tr key={'risk-' + index}><td>{text(row.category_name)}</td><td>{displayNumber(row.pv, 0)}</td><td>{displayMoney(row.gmv)}</td><td>{displayPercent(row.buy_conversion)}</td><td>{displayPercent((numeric(row.buy_conversion) ?? 0) - overallConversion)}</td><td>浏览较多但购买偏少，建议检查商品页和价格</td></tr>)}</tbody>
          </table>
        ) : <p>当前没有发现“浏览较多但购买偏少”的类目。</p>}
      </section>
      <section className="chart-zone">
        <h2>分日页面浏览量（PV）/ 加购 / 购买趋势</h2>
        {dailySeries.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDailyLines(dailySeries as Array<{ stat_date: string } & Record<string, number>>) }} /> : <p>分日数据缺失。</p>}
        <p className="footnote">行为数据用于统计浏览、加购和购买；成交总额（GMV）按商品价格估算。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据更新时间：{windowLabel(data.window)}（数据截至窗口末日）。</span>
        <span>行为数据：{String(meta?.behavior_source ?? "") === "synthetic" ? "演示行为数据" : "真实用户行为数据（" + String(meta?.behavior_source ?? "") + "）"}</span>
        <span>商品价格、库存、渠道、成本和毛利：演示或估算数据</span>
        <span>只统计当前数据窗口，窗口外没有数据。</span>
        {syntheticBadge()}
      </footer>
    </main>
  );`,
    'RetailCatalogDashboard',
  );
}

/** 价格与库存模板（retail.price-inventory，全部合成口径）。 */
export function retailPriceInventoryPageTemplate(): string {
  return pageWrapper(
    `const risk = asRecord(datasets.inventoryRisk);
  const bi = asRecord(datasets.biOverview);
  const items = asArray(risk?.items).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const meta = asRecord(datasets.meta);
  const windowText = windowLabel(data.window);
  const kpis = asArray(bi?.kpis).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const dailySeries = asArray(bi?.daily).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const channels = asArray(bi?.channels).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const categories = asArray(bi?.categories).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const trafficItems = asArray(bi?.top_traffic_items).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const anomalies = asArray(bi?.inventory_anomalies).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const highTrafficLowConversion = asArray(bi?.high_traffic_low_conversion).map(asRecord).filter((record): record is JsonRecord => record !== null);
  const inventoryHealth = asRecord(bi?.inventory_health) ?? asRecord(risk?.health);
  const actions = asArray(bi?.actions);
  const bands = [
    { label: '0-50', min: 0, max: 50 },
    { label: '50-200', min: 50, max: 200 },
    { label: '200-500', min: 200, max: 500 },
    { label: '500-1000', min: 500, max: 1000 },
    { label: '1000+', min: 1000, max: Infinity },
  ];
  const bandCounts = bands.map((band) => ({
    label: band.label,
    value: items.filter((item) => (numeric(item.price) ?? 0) >= band.min && (numeric(item.price) ?? 0) < band.max).length,
  }));
  const movingCount = numeric(inventoryHealth?.moving_items) ?? items.filter((item) => (numeric(item.sold) ?? 0) > 0).length;
  const slowCount = numeric(inventoryHealth?.stagnant_items) ?? items.filter((item) => (numeric(item.stock) ?? 0) > 0 && (numeric(item.sold) ?? 0) <= 0).length;
  const outOfStockCount = numeric(inventoryHealth?.out_of_stock_items) ?? 0;
  const healthDonut = [
    { label: '动销', value: movingCount, color: '#16a34a' },
    { label: '滞销', value: slowCount, color: '#f59e0b' },
    { label: '无库存', value: outOfStockCount, color: '#94a3b8' },
  ];
  const channelBars = channels.map((row) => ({ label: text(row.channel), value: numeric(row.gmv) ?? 0 }));
  const categoryBars = categories.slice(0, 8).map((row) => ({ label: text(row.category_name), value: numeric(row.gmv) ?? 0 }));
  // 零销量商品的库销比会被地板值放大到数十万，直接画原始比值会导致柱子全部等高。
  // 这里用风险样本的库存金额表达规模，库销比原值仍在明细表中保留。
  const riskBars = anomalies.slice(0, 8).map((row) => ({ label: text(row.title), value: numeric(row.inventory_value) ?? 0 }));
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>电商经营 BI 看板</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">商品数：{displayNumber(meta?.master_item_count ?? items.length, 0)}</span>
          <span className="meta-item">分析路径：总览 → 趋势 → 异常 → 拆解 → 行动</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="insight-strip bi-kpi-strip">
        {kpis.slice(0, 4).map((kpi, index) => (
          <article className="metric-tile" key={'kpi-' + index}>
            <span>{text(kpi.label)}</span>
            <strong>{String(kpi.id) === 'buy_conversion' ? displayPercent(kpi.value) : String(kpi.id).includes('gmv') || String(kpi.id).includes('value') || String(kpi.id).includes('order_value') || String(kpi.id).includes('profit') ? displayMoney(kpi.value) : displayNumber(kpi.value, 0)}</strong>
            <small>{text(kpi.source)}</small>
          </article>
        ))}
      </section>
      <section className="chart-zone">
        <h2>经营趋势：流量、转化与成交（分指标趋势）</h2>
        {dailySeries.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDailyLines(dailySeries as Array<{ stat_date: string } & Record<string, number>>) }} /> : <p>分日经营数据缺失。</p>}
        <p className="footnote">蓝线是页面浏览量（PV），橙线是加购（Cart），绿线是购买（Buy）。三条线使用同一个数量刻度，所以线条高低可以直接比较；低量级指标可能贴近底部。</p>
      </section>
      <section className="insight-strip bi-kpi-strip bi-kpi-secondary">
        {kpis.slice(4, 8).map((kpi, index) => (
          <article className="metric-tile" key={'secondary-kpi-' + index}>
            <span>{text(kpi.label)}</span>
            <strong>{String(kpi.id) === 'buy_conversion' ? displayPercent(kpi.value) : String(kpi.id).includes('gmv') || String(kpi.id).includes('value') || String(kpi.id).includes('order_value') || String(kpi.id).includes('profit') ? displayMoney(kpi.value) : displayNumber(kpi.value, 0)}</strong>
            <small>{text(kpi.source)}</small>
          </article>
        ))}
      </section>
      <section className="chart-zone">
        <h2>价格区间分布（商品价格）</h2>
        <div dangerouslySetInnerHTML={{ __html: svgBars(bandCounts, '价格带') }} />
      </section>
      <section className="chart-zone bi-two-column">
        <div>
          <h2>渠道拆解：成交总额（GMV）</h2>
          {channelBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(channelBars, '渠道成交总额') }} /> : <p>渠道数据缺失。</p>}
          <table className="dense-table"><thead><tr><th>渠道</th><th>商品数</th><th>页面浏览量（PV）</th><th>购买</th><th>购买转化率</th><th>成交总额（GMV）占比</th></tr></thead><tbody>{channels.map((row, index) => <tr key={'channel-' + index}><td>{text(row.channel)}</td><td>{displayNumber(row.item_count, 0)}</td><td>{displayNumber(row.pv, 0)}</td><td>{displayNumber(row.buy, 0)}</td><td>{displayPercent(row.buy_conversion)}</td><td>{displayPercent(row.gmv_share)}</td></tr>)}</tbody></table>
        </div>
        <div>
          <h2>类目拆解：规模与转化</h2>
          {categoryBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(categoryBars, '类目成交总额') }} /> : <p>类目数据缺失。</p>}
          <table className="dense-table"><thead><tr><th>类目</th><th>浏览量占比</th><th>成交总额（GMV）占比</th><th>购买转化率</th><th>需关注库存商品数</th></tr></thead><tbody>{categories.slice(0, 8).map((row, index) => <tr key={'category-' + index}><td>{text(row.category_name)}</td><td>{displayPercent(row.traffic_share)}</td><td>{displayPercent(row.gmv_share)}</td><td>{displayPercent(row.buy_conversion)}</td><td>{displayNumber(row.inventory_risk_count, 0)}</td></tr>)}</tbody></table>
        </div>
      </section>
      <section className="chart-zone">
        <h2>需要关注的问题：库存和购买转化</h2>
        {riskBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(riskBars, '需关注商品的库存金额') }} /> : <p>库存数据缺失。</p>}
        <table className="dense-table"><thead><tr><th>商品</th><th>库存</th><th>窗口销量</th><th>页面浏览量（PV）</th><th>购买转化率</th><th>库存可售天数（估算）</th><th>关注程度</th><th>原因与建议</th></tr></thead><tbody>{anomalies.map((item, index) => <tr key={'anomaly-' + index}><td>{text(item.title)}</td><td>{displayNumber(item.stock, 0)}</td><td>{displayNumber(item.sold, 0)}</td><td>{displayNumber(item.views, 0)}</td><td>{displayPercent(item.buy_conversion)}</td><td>{displayNumber(item.sell_through_ratio, 1)}</td><td>{text(item.risk_level)}</td><td>{text(item.diagnosis)}</td></tr>)}</tbody></table>
        <h3>高浏览低购买类目</h3>
        {highTrafficLowConversion.length > 0 ? <table className="dense-table"><thead><tr><th>类目</th><th>页面浏览量（PV）</th><th>购买转化率</th><th>与整体差距</th></tr></thead><tbody>{highTrafficLowConversion.map((row, index) => <tr key={'low-conversion-' + index}><td>{text(row.category_name)}</td><td>{displayNumber(row.pv, 0)}</td><td>{displayPercent(row.buy_conversion)}</td><td>{displayPercent(row.conversion_gap)}</td></tr>)}</tbody></table> : <p>当前没有发现“浏览较多但购买偏少”的类目。</p>}
        <h3>高浏览商品表现</h3>
        <table className="dense-table"><thead><tr><th>商品</th><th>类目</th><th>页面浏览量（PV）</th><th>购买</th><th>购买转化率</th><th>浏览量占比</th><th>原因与建议</th></tr></thead><tbody>{trafficItems.map((item, index) => <tr key={'traffic-item-' + index}><td>{text(item.title)}</td><td>{text(item.category_name)}</td><td>{displayNumber(item.pv, 0)}</td><td>{displayNumber(item.buy, 0)}</td><td>{displayPercent(item.buy_conversion)}</td><td>{displayPercent(item.traffic_share)}</td><td>{(numeric(item.conversion_gap) ?? 0) < 0 ? '浏览较多但购买偏少，建议检查商品页和价格' : '购买表现正常，继续关注库存'}</td></tr>)}</tbody></table>
      </section>
      <section className="chart-zone">
        <h2>库存健康度（动销 / 滞销 / 无库存商品数）</h2>
        {healthDonut.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDonut(healthDonut, '动销占比') }} /> : <p>库存数据缺失。</p>}
        <p className="footnote">动销 = 窗口内有购买事件（Buy &gt; 0）；滞销 = 有库存但窗口内无购买；动销占比 = 动销商品数 / 有库存商品数。口径为全量商品健康汇总，非库销比 Top 10 风险样本。</p>
      </section>
      <section className="action-strip bi-action-strip">
        <article><span>运营行动</span><strong>{text(actions[0], '继续观察库存健康度。')}</strong></article>
        <article><span>转化行动</span><strong>{text(actions[1], '继续观察浏览量和购买变化。')}</strong></article>
        <article><span>口径边界</span><strong>{text(actions[2], '合成字段仅用于分析演示。')}</strong></article>
      </section>
      <footer className="data-quality-footer">
        <span>数据更新时间：{windowLabel(data.window)}（数据截至窗口末日）。</span>
        <span>行为数据：{String(meta?.behavior_source ?? "") === "synthetic" ? "演示行为数据" : "真实用户行为数据（" + String(meta?.behavior_source ?? "") + "）"}</span>
        <span>商品价格、库存、渠道、成本和毛利：演示或估算数据</span>
        <span>只统计当前数据窗口，窗口外没有数据。</span>
        {syntheticBadge()}
      </footer>
    </main>
  );`,
    'RetailPriceInventoryDashboard',
  );
}

/** 经营日报模板（retail.daily-brief）。 */
export function retailDailyBriefPageTemplate(): string {
  return pageWrapper(
    `const summary = asRecord(datasets.summary);
  const totals = asRecord(summary?.totals);
  const dayOverDay = asRecord(summary?.day_over_day);
  const categories = asArray(asRecord(asRecord(datasets.categories)?.window ? datasets.categories : datasets.categories)?.rows)
    .map(asRecord).filter((record): record is JsonRecord => record !== null);
  const movers = [...categories]
    .filter((row) => row.gmv !== undefined && row.gmv_day_over_day !== null && row.gmv_day_over_day !== undefined)
    .sort((left, right) => Math.abs(numeric(right.gmv_day_over_day) ?? 0) - Math.abs(numeric(left.gmv_day_over_day) ?? 0))
    .slice(0, 8);
  const moverBars = movers.map((row) => ({ label: text(row.category_name), value: numeric(row.gmv) ?? 0 }));
  const dailySeries = asArray(asRecord(datasets.funnelDaily)?.rows)
    .map(asRecord).filter((record): record is JsonRecord => record !== null);
  const negativeChanges = dayOverDay
    ? Object.entries(dayOverDay).filter(([, value]) => (numeric(value) ?? 0) < 0)
    : [];
  const topMover = movers[0];
  const actionText = negativeChanges.length > 0
    ? '优先下钻' + (topMover ? text(topMover.category_name) : '负向指标对应') + '类目与商品，复核转化和库存。'
    : '继续观察' + (topMover ? text(topMover.category_name) : '头部类目') + '，同时复核价格带和库存健康度。';
  const meta = asRecord(datasets.meta);
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>经营日报（当日观察）</h1>
        <div className="meta-row">
          <span className="meta-item">日期：{text(summary?.stat_date)}</span>
          <span className="meta-item">状态：{text(summary?.status)}</span>
          <span className="meta-item">分析路径：总览 → 趋势 → 异常 → 拆解 → 行动</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="insight-strip">
        <article className="metric-tile"><span>成交总额（GMV）</span><strong>{displayMoney(totals?.gmv)}</strong></article>
        <article className="metric-tile"><span>购买事件</span><strong>{displayNumber(totals?.buy, 0)}</strong></article>
        <article className="metric-tile"><span>页面浏览量（PV）</span><strong>{displayNumber(totals?.pv, 0)}</strong></article>
        <article className="metric-tile"><span>独立访客（UV）</span><strong>{displayNumber(totals?.uv, 0)}</strong></article>
        <article className="metric-tile"><span>购买转化率</span><strong>{displayPercent(summary?.buy_conversion)}</strong></article>
        <article className="metric-tile"><span>客单价</span><strong>{displayMoney(summary?.avg_price)}</strong></article>
      </section>
      <section className="chart-zone">
        <h2>趋势与异常</h2>
        <table className="dense-table">
          <thead><tr><th>指标</th><th>日环比</th><th>信号</th></tr></thead>
          <tbody>
            {dayOverDay ? Object.entries(dayOverDay).map(([key, value]) => (
              <tr key={'dod-' + key}><td>{metricLabel(key)}</td><td>{value === null ? '-' : displayPercent(value)}</td><td>{(numeric(value) ?? 0) < 0 ? '需要拆解' : '继续观察'}</td></tr>
            )) : <tr><td colSpan={3}>首日或前一日无数据，不计算环比。</td></tr>}
          </tbody>
        </table>
        <h2>分日流量与转化</h2>
        {dailySeries.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgDailyLines(dailySeries as Array<{ stat_date: string } & Record<string, number>>) }} /> : <p>分日趋势数据缺失。</p>}
      </section>
      <section className="action-strip">
        <article><span>异常定位</span><strong>{negativeChanges.length > 0 ? negativeChanges.map(([key]) => metricLabel(key)).join('、') : '当前无明显负向指标'}</strong></article>
        <article><span>结构拆解</span><strong>{movers.length > 0 ? '查看类目成交总额（GMV）与转化率排名' : '等待类目数据'}</strong></article>
        <article><span>建议动作</span><strong>{actionText}</strong></article>
      </section>
      <section className="chart-zone">
        <h2>类目成交总额（GMV）榜（当日观察）</h2>
        {moverBars.length > 0 ? <div dangerouslySetInnerHTML={{ __html: svgBars(moverBars, '类目GMV') }} /> : <p>类目数据缺失。</p>}
        <table className="dense-table">
          <thead><tr><th>类目</th><th>成交总额（GMV）</th><th>成交总额环比</th><th>购买</th><th>转化率</th><th>转化率环比</th></tr></thead>
          <tbody>
            {movers.map((row, index) => (
              <tr key={'mover-' + index}>
                <td>{text(row.category_name)}</td>
                <td>{displayMoney(row.gmv)}</td>
                <td>{displayPercent(row.gmv_day_over_day)}</td>
                <td>{displayNumber(row.buy, 0)}</td>
                <td>{displayPercent(row.buy_conversion)}</td>
                <td>{displayPercent(row.buy_conversion_day_over_day)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">异动榜按窗口末日成交总额环比绝对值排序；前一日无成交的类目不计算环比。日报只描述窗口内当日观察，不做长期趋势推断；金额按商品价格估算。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据更新时间：{windowLabel(data.window)}（数据截至窗口末日）。</span>
        <span>行为数据：{String(meta?.behavior_source ?? "") === "synthetic" ? "演示行为数据" : "真实用户行为数据（" + String(meta?.behavior_source ?? "") + "）"}</span>
        <span>商品价格、库存、渠道、成本和毛利：演示或估算数据</span>
        <span>只统计当前数据窗口，窗口外没有数据。</span>
        {syntheticBadge()}
      </footer>
    </main>
  );`,
    'RetailDailyBriefDashboard',
  );
}

/** 零售基础模板：不绑定能力的通用骨架（含数据缺失兜底与合成徽标）。 */
export function retailBaseDashboardPageTemplate(): string {
  return pageWrapper(
    `const windowText = windowLabel(data.window);
  const meta = asRecord(datasets.meta);
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>零售经营看板</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">事件：{displayNumber(meta?.event_count, 0)}</span>
          <span className="meta-item">商品：{displayNumber(meta?.item_count, 0)}</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="chart-zone">
        <h2>数据集覆盖</h2>
        <table className="dense-table">
          <thead><tr><th>数据集</th><th>状态</th></tr></thead>
          <tbody>
            {['funnel', 'funnelDaily', 'categories', 'itemDaily', 'inventoryRisk', 'summary'].map((key) => (
              <tr key={'ds-' + key}>
                <td>{key}</td>
                <td>{datasets[key] ? '已就绪' : '缺失'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <footer className="data-quality-footer">
        <span>数据更新时间：{windowLabel(data.window)}（数据截至窗口末日）。</span>
        <span>行为数据：{String(meta?.behavior_source ?? "") === "synthetic" ? "演示行为数据" : "真实用户行为数据（" + String(meta?.behavior_source ?? "") + "）"}</span>
        <span>商品价格、库存、渠道、成本和毛利：演示或估算数据</span>
        <span>只统计当前数据窗口，窗口外没有数据。</span>
        {syntheticBadge()}
      </footer>
    </main>
  );`,
    'RetailBaseDashboard',
  );
}

/** 共享 CSS：workbench 视觉语言 + 零售板块样式。 */
export function retailBaseDashboardCssTemplate(): string {
  return `${baseDashboardWorkbenchCss()}

/* Shop Gate 零售板块（合成口径徽标、指标带、密集表格、图表区） */

*, *::before, *::after {
  box-sizing: border-box;
}

html, body {
  margin: 0;
  padding: 0;
  overflow-x: hidden;
}
.dashboard-shell[data-visual-language="retail-workbench"] .synthetic-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid #f59e0b;
  color: #92400e;
  background: #fef3c7;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
}

.dashboard-shell[data-visual-language="retail-workbench"] .hero-panel h1 {
  margin: 0 0 8px;
  color: #0f172a;
  font-size: clamp(22px, 3vw, 32px);
  letter-spacing: -0.03em;
}

.dashboard-shell[data-visual-language="retail-workbench"] .hero-panel {
  background: linear-gradient(135deg, #fff7ed 0%, #ffffff 58%, #eff6ff 100%);
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin-top: 12px;
  color: #475569;
  font-size: 12px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row .meta-item {
  padding: 8px 12px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .insight-strip,
.dashboard-shell[data-visual-language="retail-workbench"] .action-strip {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  border-bottom: 1px solid #e2e8f0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .metric-tile,
.dashboard-shell[data-visual-language="retail-workbench"] .action-strip article {
  min-width: 0;
  padding: 16px;
  border-right: 1px solid #e2e8f0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .metric-tile span,
.dashboard-shell[data-visual-language="retail-workbench"] .action-strip article span {
  display: block;
  color: #64748b;
  font-size: 12px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .metric-tile strong,
.dashboard-shell[data-visual-language="retail-workbench"] .action-strip article strong {
  display: block;
  margin-top: 8px;
  color: #0f172a;
  font-size: 18px;
  line-height: 1.45;
}

.dashboard-shell[data-visual-language="retail-workbench"] .action-strip {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  background: #f8fafc;
}

.dashboard-shell[data-visual-language="retail-workbench"] .bi-two-column {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .bi-two-column > div {
  min-width: 0;
  padding: 16px 18px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .bi-two-column > div + div {
  border-left: 1px solid #e2e8f0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .bi-kpi-strip small {
  display: block;
  margin-top: 6px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.4;
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone {
  border-bottom: 1px solid #e2e8f0;
  padding: 16px 0;
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone h2 {
  margin: 0 0 12px;
  color: #0f172a;
  font-size: 16px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .dense-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .dense-table th,
.dashboard-shell[data-visual-language="retail-workbench"] .dense-table td {
  border-bottom: 1px solid #e2e8f0;
  padding: 6px 10px;
  text-align: left;
  white-space: nowrap;
}

.dashboard-shell[data-visual-language="retail-workbench"] .footnote {
  color: #64748b;
  font-size: 12px;
  margin-top: 8px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .data-quality-footer {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  color: #64748b;
  font-size: 12px;
  padding: 12px 0 32px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row {
  flex-wrap: wrap;
  row-gap: 4px;
}

.dashboard-shell[data-visual-language="retail-workbench"] .meta-row .meta-item {
  white-space: normal;
  word-break: break-word;
}

.dashboard-shell[data-visual-language="retail-workbench"] .hero-panel h1,
.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone h2 {
  overflow-wrap: anywhere;
}

.dashboard-shell[data-visual-language="retail-workbench"],
.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone,
.dashboard-shell[data-visual-language="retail-workbench"] .insight-strip {
  min-width: 0;
  max-width: 100%;
}

.dashboard-shell[data-visual-language="retail-workbench"] {
  max-width: 100%;
  overflow-x: hidden;
}

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone svg,
.dashboard-shell[data-visual-language="retail-workbench"] .dense-table {
  max-width: 100%;
}

.dashboard-shell[data-visual-language="retail-workbench"] .dense-table {
  display: block;
  overflow-x: auto;
}

@media (max-width: 800px) {
  .dashboard-shell[data-visual-language="retail-workbench"] .insight-strip,
  .dashboard-shell[data-visual-language="retail-workbench"] .action-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .dashboard-shell[data-visual-language="retail-workbench"] .metric-tile,
  .dashboard-shell[data-visual-language="retail-workbench"] .action-strip article {
    border-bottom: 1px solid #e2e8f0;
  }

  /* 移动端首屏优先露出趋势主图；其余 KPI 仍保留在桌面端和数据文件中，
     但不让摘要带把主分析内容推出 390px 首屏。 */
  .dashboard-shell[data-visual-language="retail-workbench"] .bi-kpi-strip .metric-tile:nth-child(n + 3) {
    display: none;
  }

  .dashboard-shell[data-visual-language="retail-workbench"] .bi-two-column {
    display: block;
  }

  .dashboard-shell[data-visual-language="retail-workbench"] .bi-two-column > div + div {
    border-left: 0;
    border-top: 1px solid #e2e8f0;
  }
}
`;
}
