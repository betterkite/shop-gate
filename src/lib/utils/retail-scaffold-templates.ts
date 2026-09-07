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

function readSourcesEvidence(): Promise<string | null> {
  return fs.readFile('evidence/sources.json', 'utf8').catch(() => null);
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
  const height = 240;
  const metrics: Array<[string, string]> = [['pv', '#2563eb'], ['cart', '#f59e0b'], ['buy', '#16a34a']];
  const max = Math.max(1, ...series.flatMap((point) => metrics.map(([key]) => numeric(point[key]) ?? 0)));
  const stepX = series.length > 1 ? (width - 48) / (series.length - 1) : 0;
  const paths = metrics
    .map(([key, color]) => {
      const points = series
        .map((point, index) => {
          const value = numeric(point[key]) ?? 0;
          const x = 24 + index * stepX;
          const y = height - 30 - (value / max) * (height - 70);
          return x.toFixed(1) + ',' + y.toFixed(1);
        })
        .join(' ');
      return '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" points="' + points + '" />';
    })
    .join('');
  const labels = series
    .map((point, index) =>
      index % Math.ceil(series.length / 9 || 1) === 0
        ? '<text x="' + (24 + index * stepX) + '" y="' + (height - 8) + '" font-size="10" text-anchor="middle" fill="#475569">' +
          point.stat_date.slice(5) + '</text>'
        : '')
    .join('');
  return '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="分日趋势" ' +
    'style="width:100%;max-width:760px;height:auto" xmlns="http://www.w3.org/2000/svg">' +
    '<line x1="16" y1="' + (height - 30) + '" x2="' + (width - 16) + '" y2="' + (height - 30) + '" stroke="#cbd5e1" />' +
    paths + labels +
    '<text x="24" y="18" font-size="12" fill="#334155">蓝=曝光 橙=加购 绿=购买</text></svg>';
}

function syntheticBadge(): string {
  return '<span class="synthetic-badge" title="价格/库存/品牌/店铺与 GMV 金额来自合成主数据，不代表真实交易数据">合成口径</span>';
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
  const funnelStages = asArray(funnel?.stages).map(asRecord).filter(Boolean);
  const funnelDaily = asArray(asRecord(datasets.funnelDaily)?.rows);
  const windowText = windowLabel(data.window);
  const planned = asRecord(data.plannedEntities);
  const categoryCount = asArray(planned?.categoryIds).length;
  const itemCount = asArray(planned?.itemIds).length;
  const scopeText = categoryCount === 0 && itemCount === 0
    ? '全库口径（数据窗口内全部类目/商品）'
    : '类目 ' + categoryCount + ' 个 / 商品 ' + itemCount + ' 个';
  const funnelBars = funnelStages.map((stage) => ({
    label: text(stage.stage),
    value: numeric(stage.events) ?? 0,
  }));
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
        <h2>事件漏斗（pv → fav → cart → buy）</h2>
        {funnelBars.length > 0 ? svgBars(funnelBars, '事件漏斗') : <p>漏斗数据缺失。</p>}
        <table className="dense-table">
          <thead><tr><th>阶段</th><th>事件数</th><th>相对上一阶段</th></tr></thead>
          <tbody>
            {funnelStages.map((stage, index) => (
              <tr key={'stage-' + index}>
                <td>{text(stage.stage)}</td>
                <td>{displayNumber(stage.events, 0)}</td>
                <td>{stage.conversion_from_previous === null || stage.conversion_from_previous === undefined ? '-' : displayPercent(stage.conversion_from_previous)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="chart-zone">
        <h2>分日趋势</h2>
        {funnelDaily.length > 0 ? svgDailyLines(funnelDaily.map(asRecord).filter(Boolean) as Array<{ stat_date: string } & Record<string, number>>) : <p>分日数据缺失。</p>}
      </section>
      <footer className="data-quality-footer">
        <span>数据质量与来源见 evidence/data_quality.json、evidence/sources.json。</span>
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
  const ranked = categories.map(asRecord).filter(Boolean);
  const windowText = windowLabel(data.window);
  const totalGmv = ranked.reduce((sum, row) => sum + (numeric(row.gmv) ?? 0), 0);
  const top5Gmv = ranked.slice(0, 5).reduce((sum, row) => sum + (numeric(row.gmv) ?? 0), 0);
  const concentration = totalGmv > 0 ? top5Gmv / totalGmv : null;
  const gmvBars = ranked.slice(0, 8).map((row) => ({ label: text(row.category_name), value: numeric(row.gmv) ?? 0 }));
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>类目与商品结构</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">类目数：{ranked.length}</span>
          <span className="meta-item">集中度（top-5 GMV）：{concentration === null ? '-' : displayPercent(concentration, 1)}</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="chart-zone">
        <h2>类目 GMV 排名</h2>
        {gmvBars.length > 0 ? svgBars(gmvBars, '类目GMV') : <p>类目数据缺失。</p>}
        <table className="dense-table">
          <thead><tr><th>类目</th><th>曝光</th><th>购买</th><th>GMV</th><th>转化率</th><th>客单价</th></tr></thead>
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
        <p className="footnote">类目名为合成映射（synthetic_name）；GMV = 购买事件 × 合成价格。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据质量与来源见 evidence/data_quality.json、evidence/sources.json。</span>
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
  const items = asArray(risk?.items).map(asRecord).filter(Boolean);
  const windowText = windowLabel(data.window);
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
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>价格与库存（合成口径）</h1>
        <div className="meta-row">
          <span className="meta-item">窗口：{windowText}</span>
          <span className="meta-item">商品数：{items.length}</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="chart-zone">
        <h2>价格带分布（合成价格）</h2>
        {svgBars(bandCounts, '价格带')}
        <h2>库销比排行（库存 / 日均销量）</h2>
        <table className="dense-table">
          <thead><tr><th>商品</th><th>价格</th><th>库存</th><th>窗口销量</th><th>曝光</th><th>库销比</th></tr></thead>
          <tbody>
            {items.slice(0, 12).map((item, index) => (
              <tr key={'inv-' + index}>
                <td>{text(item.title)}</td>
                <td>{displayMoney(item.price)}</td>
                <td>{displayNumber(item.stock, 0)}</td>
                <td>{displayNumber(item.sold, 0)}</td>
                <td>{displayNumber(item.views, 0)}</td>
                <td>{displayNumber(item.sell_through_ratio, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">价格/库存为合成主数据；库销比越大越滞销，零销量商品用地板值计算，仅作分析参考，不构成采购或下架指令。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据质量与来源见 evidence/data_quality.json、evidence/sources.json。</span>
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
    .map(asRecord).filter(Boolean);
  const movers = [...categories]
    .filter((row) => row.gmv !== undefined)
    .sort((left, right) => (numeric(right.gmv) ?? 0) - (numeric(left.gmv) ?? 0))
    .slice(0, 8);
  return (
    <main className="dashboard-shell" data-visual-language="retail-workbench">
      <section className="hero-panel">
        <h1>经营日报（当日观察）</h1>
        <div className="meta-row">
          <span className="meta-item">日期：{text(summary?.stat_date)}</span>
          <span className="meta-item">状态：{text(summary?.status)}</span>
          {syntheticBadge()}
        </div>
      </section>
      <section className="insight-strip">
        <article className="metric-tile"><span>GMV</span><strong>{displayMoney(totals?.gmv)}</strong></article>
        <article className="metric-tile"><span>购买事件</span><strong>{displayNumber(totals?.buy, 0)}</strong></article>
        <article className="metric-tile"><span>曝光</span><strong>{displayNumber(totals?.pv, 0)}</strong></article>
        <article className="metric-tile"><span>购买转化</span><strong>{displayPercent(summary?.buy_conversion)}</strong></article>
        <article className="metric-tile"><span>客单价</span><strong>{displayMoney(summary?.avg_price)}</strong></article>
      </section>
      <section className="chart-zone">
        <h2>环比</h2>
        <table className="dense-table">
          <thead><tr><th>指标</th><th>环比</th></tr></thead>
          <tbody>
            {dayOverDay ? Object.entries(dayOverDay).map(([key, value]) => (
              <tr key={'dod-' + key}><td>{key}</td><td>{value === null ? '-' : displayPercent(value)}</td></tr>
            )) : <tr><td colSpan={2}>首日或前一日无数据，不计算环比。</td></tr>}
          </tbody>
        </table>
        <h2>类目 GMV 榜（当日观察）</h2>
        <table className="dense-table">
          <thead><tr><th>类目</th><th>GMV</th><th>购买</th><th>转化率</th></tr></thead>
          <tbody>
            {movers.map((row, index) => (
              <tr key={'mover-' + index}>
                <td>{text(row.category_name)}</td>
                <td>{displayMoney(row.gmv)}</td>
                <td>{displayNumber(row.buy, 0)}</td>
                <td>{displayPercent(row.buy_conversion)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="footnote">日报只描述窗口内当日观察，不做长期趋势推断；金额为合成口径。</p>
      </section>
      <footer className="data-quality-footer">
        <span>数据质量与来源见 evidence/data_quality.json、evidence/sources.json。</span>
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
        <span>数据质量与来源见 evidence/data_quality.json、evidence/sources.json。</span>
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

/* Shop Gate 零售板块（合成口径徽标、密集表格、图表区） */
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

.dashboard-shell[data-visual-language="retail-workbench"] .chart-zone {
  border-bottom: 1px solid #e2e8f0;
  padding: 16px 0;
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
  gap: 12px;
  align-items: center;
  color: #64748b;
  font-size: 12px;
  padding: 12px 0 32px;
}
`;
}
