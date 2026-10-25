// Browser-safe contracts: no Node, authentication token, model, or database imports.
import { z } from 'zod';

export const RESOURCE_LABELS = {
  channels: '销售平台', stores: '店铺', products: '商品', skus: '标准规格（SKU）',
  mappings: '平台商品与规格对应关系', fx_rates: '汇率', costs: '商品成本',
  orders: '订单', order_lines: '订单明细', refunds: '退款与售后', expenses: '经营费用', targets: '月度目标',
} as const;
export type Resource = keyof typeof RESOURCE_LABELS;
export const RESOURCES = Object.keys(RESOURCE_LABELS) as Resource[];
const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const datasetSchema = z.object({ dataset_id: id, workspace_id: id.optional(), name: z.string(),
  source_kind: z.enum(['demo', 'import']), version, reporting_currency: z.string(),
  state: z.enum(['active', 'archived']), updated_at: z.string().optional(), notice: z.string().optional() });
export type Dataset = z.infer<typeof datasetSchema>;
export const directorySchema = z.object({ workspace_id: id, rows: z.array(datasetSchema),
  total: z.number().int().nonnegative(), page: z.number().int().positive(), page_size: z.literal(20) });
export const jobSchema = z.object({ workspace_id: id, dataset_id: id, job_id: id,
  kind: z.enum(['preview_import', 'prepare_demo', 'confirm_import', 'export_standard']),
  base_version: version, state: z.enum(['queued', 'running', 'awaiting_auth', 'ready_preview',
    'rejected', 'committed', 'completed', 'failed', 'cancelled']),
  result: z.record(z.string(), z.unknown()), cancel_requested: z.boolean(), attempts: z.number().int().nonnegative(),
  error_code: z.string().nullable(), created_at: z.string(), updated_at: z.string(), expires_at: z.string(),
  expired: z.boolean(), stage_label: z.string() });
export type DataJob = z.infer<typeof jobSchema>;
export const jobsSchema = z.object({ rows: z.array(jobSchema), total: z.number().int().nonnegative(),
  page: z.number().int().positive(), page_size: z.literal(20) });
export const fieldSchema = z.object({ name: z.string(), label: z.string(), kind: z.string(),
  required: z.boolean(), choices: z.array(z.string()) });
export const catalogSchema = z.object({ metrics: z.array(z.object({ id: z.string(), name: z.string(),
  unit: z.string(), formula: z.string(), missing_policy: z.string() })),
  templates: z.array(z.object({ resource: z.enum(RESOURCES as [Resource, ...Resource[]]),
    version: z.string(), fields: z.array(fieldSchema), notice: z.string() })) });
export type DataCatalog = z.infer<typeof catalogSchema>;
export const queryResultSchema = z.object({ workspace_id: id, dataset_id: id, version,
  accounting_revision: version, data_cutoff: z.string().nullable(),
  range: z.object({ start: z.string().nullable(), end: z.string().nullable(), refund_basis: z.string() }),
  summary: z.object({ metrics: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
    quality: z.record(z.string(), z.unknown()) }) });
export type DataSnapshot = z.infer<typeof queryResultSchema>;

export type DataLocation = { workspaceId?: string; datasetId?: string; datasetPage: number; jobPage: number; jobId?: string };
export function readDataLocation(search: string): DataLocation {
  const params = new URLSearchParams(search);
  const identifier = (key: string) => { const value = params.get(key); return value && id.safeParse(value).success ? value : undefined; };
  const page = (key: string) => { const text = params.get(key) ?? '1'; return /^[1-9]\d{0,5}$/.test(text) ? Number(text) : 1; };
  return { workspaceId: identifier('workspace_id'), datasetId: identifier('dataset_id'),
    datasetPage: page('dataset_page'), jobPage: page('job_page'), jobId: identifier('job_id') };
}

/** Preserve only validated BI location fields through login, never caller URLs or identity. */
export function dataLoginReturnPath(search: Record<string, string | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const key of ['workspace_id', 'dataset_id', 'dataset_page', 'job_page', 'job_id']) {
    const value = search[key];
    if (typeof value === 'string') query.set(key, value);
  }
  return dataLocationUrl('/bi/data', readDataLocation(query.toString()));
}

export function dataLocationUrl(current: string, change: Partial<DataLocation>): string {
  const url = new URL(current, 'http://shopgate.local');
  const fields = { workspaceId: 'workspace_id', datasetId: 'dataset_id', datasetPage: 'dataset_page', jobPage: 'job_page', jobId: 'job_id' } as const;
  if ('workspaceId' in change && change.workspaceId !== (url.searchParams.get('workspace_id') ?? undefined)) {
    // Object filters belong to the previous workspace. Never carry them into another account/project.
    url.search = '';
  } else if ('datasetId' in change && change.datasetId !== (url.searchParams.get('dataset_id') ?? undefined)) {
    for (const key of ['job_id', 'job_page', 'version', 'page', 'store_id', 'sku_id', 'product_id', 'channel_id']) url.searchParams.delete(key);
  }
  for (const [key, parameter] of Object.entries(fields)) {
    if (key in change) {
      const value = change[key as keyof DataLocation];
      if (value === undefined || value === 1) url.searchParams.delete(parameter);
      else url.searchParams.set(parameter, String(value));
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function scopedDataParams(workspaceId: string, dataset: Dataset) {
  return new URLSearchParams({ workspace_id: workspaceId, dataset_id: dataset.dataset_id, version: String(dataset.version) });
}
export function sameDatasetSnapshot(workspaceId: string, dataset: Pick<Dataset, 'dataset_id' | 'version'>, result: DataSnapshot) {
  return workspaceId === result.workspace_id && dataset.dataset_id === result.dataset_id
    && dataset.version === result.version && result.version === result.accounting_revision;
}
export function previewCanCommit(job: DataJob, dataset: Dataset, canManage: boolean, now = Date.now()) {
  const preview = job.result.preview_id;
  return canManage && job.dataset_id === dataset.dataset_id && job.base_version === dataset.version
    && (dataset.workspace_id === undefined || job.workspace_id === dataset.workspace_id)
    && job.state === 'ready_preview' && !job.expired && !job.cancel_requested
    && typeof preview === 'string' && id.safeParse(preview).success
    && now < Date.parse(job.expires_at)
    && typeof job.result.preview_expires_at === 'string' && now < Date.parse(job.result.preview_expires_at);
}
export const JOB_LABELS: Record<DataJob['kind'], string> = {
  preview_import: '文件导入预览', prepare_demo: '准备演示数据', confirm_import: '确认导入', export_standard: '标准数据导出',
};
export const JOB_ERROR_LABELS: Record<string, string> = {
  BI_JOB_CONFLICT: '数据或预览发生变化，请刷新并重新预览；已有数据未被覆盖。',
  BI_JOB_TIMEOUT: '本次处理被中断或超过时限，未提交的修改已回滚。请提供任务编号以便排查，勿重复确认同一批数据。',
  BI_JOB_INPUT_INVALID: '任务内容未通过检查，尚未写入。请检查参数或重新上传文件预览。',
  BI_JOB_FAILED: '任务未完成，请检查文件及服务状态后重新提交；没有部分写入。',
};
export const FIELD_TYPE_LABELS: Record<string, string> = {
  text: '文本', id: '标识文本，保留前导零', color: '#RRGGBB 颜色', currency: '三位原币代码，例如 CNY',
  timezone: '时区，例如 Asia/Shanghai', datetime: '带时区时间，例如 2026-01-01T10:00:00+08:00',
  date: '日期 YYYY-MM-DD', month: '月份 YYYY-MM', money: '金额，最多2位小数',
  quantity: '数量，最多4位小数', unit_cost: '单位成本，最多4位小数', fx_rate: '汇率，最多8位小数',
};
export const CHOICE_LABELS: Record<string, string> = {
  paid: '已付款', unpaid: '未付款', cancelled: '已取消', mapped: '已对应标准规格', unmapped: '尚未对应标准规格',
  unknown: '未知', unshipped: '未发货', shipped: '已发货', delivered: '已送达',
  completed: '已完成', pending: '待处理', base: '基础成本', channel: '平台成本', store: '店铺成本',
  refund_only: '仅退款', return: '退货退款', unshipped_cancel: '未发货取消',
  platform: '平台费用', packaging: '包装费用', logistics: '物流费用', advertising: '广告费用', other: '其他费用',
  direct: '直接对应订单明细', revenue: '按成交金额分摊', quantity: '按数量分摊', unallocated: '单列未分摊',
};
export const UPLOAD_LIMITS = { file: 20 * 1024 * 1024, batch: 60 * 1024 * 1024, files: 36 };
export function validateUploads(files: readonly { name: string; size: number; resource: string }[]) {
  if (!files.length || files.length > UPLOAD_LIMITS.files) throw new Error('请选择1–36个标准 CSV 文件。');
  if (files.some((file) => !RESOURCES.includes(file.resource as Resource))) throw new Error('请为每个文件选择对应的数据类型。');
  if (files.some((file) => file.size <= 0 || file.size > UPLOAD_LIMITS.file)) throw new Error('单个文件须非空且不超过20 MB。');
  if (files.some((file) => file.name.length > 200 || /[\u0000-\u001f]/.test(file.name))) throw new Error('文件名过长或包含不可见字符，请重命名后再上传。');
  if (files.reduce((sum, file) => sum + file.size, 0) > UPLOAD_LIMITS.batch) throw new Error('本批文件合计不能超过60 MB。');
}

export function inferResource(filename: string): Resource | '' {
  const candidate = filename.toLowerCase().replace(/^shopgate-/, '').replace(/-v1(?=\.csv$)/, '').replace(/\.csv$/, '');
  return RESOURCES.includes(candidate as Resource) ? candidate as Resource : '';
}

/** Formatting only. Do not convert source decimal money to floating-point for arithmetic. */
export function decimalLabel(value: unknown, percent = false): string {
  if (value === null || value === undefined) return '待核算';
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value.toLocaleString('zh-CN') : '—';
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return '—';
  if (percent) {
    const negative = value.startsWith('-');
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
    const hundredths = `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`.replace(/^0+(?=\d)/, '');
    return `${negative ? '-' : ''}${hundredths}.${fraction.slice(2, 4).padEnd(2, '0')}%`;
  }
  const [whole, fraction] = value.split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

export class StableRequestKeys {
  private keys = new Map<string, string>();
  get(digest: string, create: () => string = () => crypto.randomUUID()) {
    let key = this.keys.get(digest);
    if (!key) { key = create(); this.keys.set(digest, key); }
    return key;
  }
  forget(digest: string) { this.keys.delete(digest); }
}
