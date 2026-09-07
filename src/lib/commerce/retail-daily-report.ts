import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';

const BASE_URL =
  process.env.SHOPGATE_MARKET_API_URL ||
  process.env.SHOPGATE_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

function inputJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const degradation = getRuntimeDegradationConfig().components.marketApi;
  if (!degradation.enabled) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isoDay(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : fallback;
}

function money(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  return Number.isFinite(parsed) ? '¥' + parsed.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '-';
}

function percent(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(parsed)) return '-';
  const ratio = Math.abs(parsed) <= 1 ? parsed * 100 : parsed;
  return ratio.toFixed(2) + '%';
}

function num(value: unknown): string {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) : '-';
}

export async function generateRetailDailyBrief(options: {
  reportDate?: string;
}): Promise<{ runId: string; reportId: string; date: string }> {
  const meta = await fetchJson<Record<string, unknown>>('/api/v1/commerce/meta');
  const window = {
    start: isoDay(meta?.first_event_ts, '2017-11-25'),
    end: isoDay(meta?.last_event_ts, '2017-12-03'),
  };
  const behaviorSource =
    typeof meta?.behavior_source === 'string' ? (meta.behavior_source as string) : 'unknown';

  const reportDate = (options.reportDate ?? window.end).slice(0, 10);
  const reportDateObj = new Date(`${reportDate}T00:00:00Z`);

  const daily = await fetchJson<Record<string, unknown>>(
    `/api/v1/commerce/summary?date=${reportDate}`,
  );
  const categories = (await fetchJson<Record<string, unknown>[]>(
    `/api/v1/commerce/categories/top?start=${window.start}&end=${window.end}&metric=gmv&limit=10`,
  )) ?? [];

  const totals = (daily?.totals ?? {}) as Record<string, unknown>;
  const dayOverDay = (daily?.day_over_day ?? {}) as Record<string, unknown>;
  const summaryText =
    `窗口末日 ${reportDate}：GMV ${money(totals.gmv)}，曝光 ${num(totals.pv)}，` +
    `购买事件 ${num(totals.buy)}，购买转化 ${percent(daily?.buy_conversion)}，` +
    `客单价 ${money(daily?.avg_price)}。`;

  const markdown = [
    `# 经营日报（${reportDate}）`,
    '',
    `> ${summaryText}`,
    '',
    '| 指标 | 值 | 日环比 |',
    '| --- | --- | --- |',
    ...Object.entries(totals)
      .filter(([key]) => ['gmv', 'pv', 'buy', 'buyers'].includes(key))
      .map(([key, value]) => `| ${key} | ${num(value)} | ${dayOverDay[key] === null ? '-' : percent(dayOverDay[key])} |`),
    '',
    '## 类目经营榜（窗口内）',
    '',
    '| 类目 | GMV | 购买 | 转化率 |',
    '| --- | --- | --- | --- |',
    ...categories.slice(0, 10).map((cat) => (
      `| ${String(cat.category_name ?? '-')} | ${money(cat.gmv)} | ${num(cat.buy)} | ${percent(cat.buy_conversion)} |`
    )),
    '',
    '> 金额/客单价为合成口径；行为事件为真实 UserBehavior。',
  ].join('\n');

  const startedAt = new Date();
  const run = await prisma.operationBriefRun.create({
    data: {
      status: 'running',
      runType: 'daily',
      startedAt,
      providerMode: 'local',
      metadata: inputJson({
        window,
        behaviorSource,
        reportDate,
        dailyStatus: daily?.status ?? 'unknown',
      }),
    },
  });

  try {
    const report = await prisma.operationBrief.create({
      data: {
        runId: run.id,
        title: `经营日报 ${reportDate}`,
        summary: summaryText,
        reportDate: reportDateObj,
        marketScope: inputJson({ window, universe: 'retail', behaviorSource }),
        score: 0,
        recommendation: '观察',
        riskLevel: 'low',
        contentMarkdown: markdown,
        structured: inputJson({
          daily: { stat_date: reportDate, status: daily?.status, totals, dayOverDay },
          categories,
        }),
        evidence: inputJson({
          source: 'local-commerce-data',
          window,
          behaviorSource,
          synthetic: ['price', 'stock', 'brand', 'shop', 'gmv'],
        }),
        source: 'local-commerce-data',
      },
    });

    await prisma.operationBriefRun.update({
      where: { id: run.id },
      data: { status: 'completed', finishedAt: new Date() },
    });

    return { runId: run.id, reportId: report.id, date: reportDate };
  } catch (error) {
    await prisma.operationBriefRun.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        finishedAt: new Date(),
        error: error instanceof Error ? error.message : String(error),
      },
    });
    throw error;
  }
}

export async function getLatestRetailDailyBrief(): Promise<{
  reportId: string;
  date: string;
} | null> {
  const report = await prisma.operationBrief.findFirst({
    where: { title: { startsWith: '经营日报' } },
    orderBy: { createdAt: 'desc' },
  });
  if (!report) return null;
  return { reportId: report.id, date: report.reportDate.toISOString().slice(0, 10) };
}
