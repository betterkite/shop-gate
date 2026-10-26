import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import { AuthorizationError } from '@/lib/auth/authorization';
import { getProjectAuthConfig } from '@/lib/config/auth';
import { issueDirectoryScope, issueLedgerScope, issueJobScope } from './gateway-scope';
import { BI_JOB_KINDS } from './job-signatures';

const MAX_INPUT = 64 * 1024;
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_UPLOAD = 80 * 1024 * 1024 + MAX_INPUT; // 60MiB decoded + base64 overhead + metadata.
const RESOURCES = new Set(['channels', 'stores', 'products', 'skus', 'mappings', 'fx_rates',
  'costs', 'orders', 'order_lines', 'refunds', 'expenses', 'targets']);
const MESSAGES = {
  BI_INPUT_INVALID: '请求参数无效，请检查数据集、版本和筛选条件。',
  BI_INPUT_TOO_LARGE: '请求内容过大，请减少筛选对象或使用数据导入入口。',
  BI_MEDIA_UNSUPPORTED: '此接口只接受未压缩的 JSON 请求。',
  BI_SCOPE_DENIED: '授权无效、已过期或无权访问，请重新登录后重试。',
  BI_CONFLICT: '数据或请求已变化，请刷新并重新确认；未覆盖已有记录。',
  BI_FILE_EXPIRED: '导出文件已到期，请重新导出；经营数据和任务记录仍保留。',
  BI_UNAVAILABLE: '经营数据服务尚未就绪，请联系管理员检查配置与迁移。',
  BI_TIMEOUT: '本次操作超时，请刷新检查状态；创建重试须使用原请求标识。',
  BI_INTERNAL_ERROR: '经营数据处理失败，请稍后重试并提供本次请求编号。',
  BI_SAME_ORIGIN_REQUIRED: '请从 Shop Gate 当前页面提交此操作。',
} as const;
type ErrorCode = keyof typeof MESSAGES;
const HEADERS = { 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

class BiProblem extends Error {
  constructor(readonly code: ErrorCode, readonly status: number) { super(code); }
}

export function biFailure(error: unknown) {
  const requestId = randomUUID();
  const problem = error instanceof BiProblem ? error
    : error instanceof AuthorizationError ? new BiProblem('BI_SCOPE_DENIED', error.status)
      : new BiProblem('BI_INTERNAL_ERROR', 500);
  // No arbitrary exception.message, SQL, service response or secret is sent to the browser.
  return NextResponse.json({ success: false, error: problem.code,
    message: MESSAGES[problem.code], request_id: requestId },
  { status: problem.status, headers: { ...HEADERS, 'X-Request-ID': requestId } });
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
}

function optionalWorkspace(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  return value;
}

function sameOrigin(request: NextRequest) {
  const origin = request.headers.get('origin');
  const valid = origin ? origin === request.nextUrl.origin
    || getProjectAuthConfig().trustedOrigins.includes(origin)
    : request.headers.get('x-shopgate-request') === 'same-origin';
  if (!valid) throw new BiProblem('BI_SAME_ORIGIN_REQUIRED', 403);
}

async function boundedBytes(stream: ReadableStream<Uint8Array> | null, limit: number) {
  if (!stream) throw new BiProblem('BI_INPUT_INVALID', 422);
  const reader = stream.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BiProblem('BI_INPUT_TOO_LARGE', 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

async function input(request: NextRequest, limit = MAX_INPUT) {
  sameOrigin(request);
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json'
      || (request.headers.get('content-encoding') ?? 'identity') !== 'identity') {
    throw new BiProblem('BI_MEDIA_UNSUPPORTED', 415);
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d{1,10}$/.test(declared) || Number(declared) > limit)) {
    throw new BiProblem('BI_INPUT_TOO_LARGE', 413);
  }
  const body = await boundedBytes(request.body, limit);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))); }
  catch { throw new BiProblem('BI_INPUT_INVALID', 422); }
}

function params(request: NextRequest, allowed: readonly string[]) {
  const result: Record<string, string> = {};
  for (const [key, value] of request.nextUrl.searchParams) {
    if (!allowed.includes(key) || key in result) throw new BiProblem('BI_INPUT_INVALID', 422);
    result[key] = value;
  }
  return result;
}

function serviceUrl(path: string) {
  try {
    const base = new URL(process.env.SHOPGATE_COMMERCE_API_URL ?? '');
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password
        || base.search || base.hash || base.pathname !== '/') throw new Error('invalid');
    return new URL(`/api/v1/bi/${path}`, base);
  } catch { throw new BiProblem('BI_UNAVAILABLE', 503); }
}

async function upstream(path: string, token: string, body?: Record<string, unknown>, maxOutput = MAX_OUTPUT) {
  const url = serviceUrl(path); // Only fixed routes below; never a browser-provided URL.
  try {
    const response = await fetch(url, {
      method: body ? 'POST' : 'GET', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(75_000),
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let bytes: Buffer;
    try { bytes = await boundedBytes(response.body, maxOutput); }
    catch (error) {
      if (error instanceof BiProblem && error.code === 'BI_INPUT_TOO_LARGE') throw new BiProblem('BI_UNAVAILABLE', 503);
      throw error;
    }
    if (!response.ok) {
      // Status mapping only: do not expose unknown upstream messages or raw error payloads.
      const errors: Record<number, ErrorCode> = { 401: 'BI_SCOPE_DENIED', 403: 'BI_SCOPE_DENIED',
        409: 'BI_CONFLICT', 410: 'BI_FILE_EXPIRED', 413: 'BI_INPUT_TOO_LARGE', 415: 'BI_MEDIA_UNSUPPORTED',
        422: 'BI_INPUT_INVALID', 504: 'BI_TIMEOUT' };
      const code = errors[response.status] ?? 'BI_UNAVAILABLE';
      throw new BiProblem(code, errors[response.status] ? response.status : 503);
    }
    return { bytes, contentType: response.headers.get('content-type') ?? '' };
  } catch (error) {
    if (error instanceof BiProblem) {
      throw error;
    }
    throw new BiProblem(error instanceof Error && error.name === 'TimeoutError'
      ? 'BI_TIMEOUT' : 'BI_UNAVAILABLE', error instanceof Error && error.name === 'TimeoutError' ? 504 : 503);
  }
}

function decoded(bytes: Buffer) {
  try {
    const envelope = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (envelope.success !== true) throw new Error('invalid');
    return object(envelope.data);
  } catch { throw new BiProblem('BI_UNAVAILABLE', 503); }
}

function picked(value: Record<string, unknown>, allowed: readonly string[]) {
  return Object.fromEntries(allowed.filter((key) => key in value).map((key) => [key, value[key]]));
}

function success(data: Record<string, unknown>, status = 200) {
  return NextResponse.json({ success: true, data }, { status, headers: HEADERS });
}

const DATASET_FIELDS = ['workspace_id', 'dataset_id', 'name', 'source_kind', 'version',
  'reporting_currency', 'state', 'updated_at', 'notice'];

export async function getDatasets(request: NextRequest) {
  const options = params(request, ['workspace_id', 'page', 'page_size', 'source_kind']);
  const scope = await issueDirectoryScope({ headers: request.headers,
    workspaceId: optionalWorkspace(options.workspace_id) });
  const query = new URLSearchParams(Object.entries(options).filter(([key]) => key !== 'workspace_id'));
  const data = decoded((await upstream(`datasets?${query}`, scope.token)).bytes);
  if (data.workspace_id !== scope.workspaceId || !Array.isArray(data.rows)) {
    throw new BiProblem('BI_UNAVAILABLE', 503);
  }
  return success({ ...picked(data, ['workspace_id', 'total', 'page', 'page_size']),
    rows: data.rows.map((row) => picked(object(row), DATASET_FIELDS)) });
}

export async function postDataset(request: NextRequest) {
  const body = await input(request);
  keys(body, ['workspace_id', 'dataset_id', 'name', 'source_kind', 'idempotency_key', 'confirmed_by_user']);
  if (body.confirmed_by_user !== true || typeof body.name !== 'string'
      || typeof body.dataset_id !== 'string' || typeof body.idempotency_key !== 'string'
      || !['demo', 'import'].includes(body.source_kind as string)) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  const scope = await issueDirectoryScope({ headers: request.headers,
    workspaceId: optionalWorkspace(body.workspace_id), write: true });
  const data = decoded((await upstream('datasets', scope.token,
    picked(body, ['dataset_id', 'name', 'source_kind', 'idempotency_key', 'confirmed_by_user']))).bytes);
  if (data.workspace_id !== scope.workspaceId || data.dataset_id !== body.dataset_id) {
    throw new BiProblem('BI_UNAVAILABLE', 503);
  }
  return success(picked(data, DATASET_FIELDS));
}

export async function getDataset(request: NextRequest, datasetId: string) {
  jobIdentifier(datasetId);
  const options = params(request, ['workspace_id']);
  const scope = await issueDirectoryScope({ headers: request.headers,
    workspaceId: optionalWorkspace(options.workspace_id) });
  const data = decoded((await upstream(`datasets/${encodeURIComponent(datasetId)}`, scope.token)).bytes);
  if (data.workspace_id !== scope.workspaceId || data.dataset_id !== datasetId) {
    throw new BiProblem('BI_UNAVAILABLE', 503);
  }
  return success(picked(data, DATASET_FIELDS));
}

export async function postQuery(request: NextRequest) {
  const body = await input(request);
  keys(body, ['workspace_id', 'dataset_id', 'version', 'query']);
  if (typeof body.dataset_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(body.dataset_id)
      || typeof body.version !== 'number' || !Number.isSafeInteger(body.version) || body.version < 1) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  const query = object(body.query);
  const scope = await issueLedgerScope({ headers: request.headers, datasetId: body.dataset_id,
    version: body.version, workspaceId: optionalWorkspace(body.workspace_id) });
  const data = decoded((await upstream('query', scope.token, query)).bytes);
  if (data.workspace_id !== scope.workspaceId || data.dataset_id !== scope.datasetId
      || data.version !== scope.version || data.accounting_revision !== scope.version) {
    throw new BiProblem('BI_UNAVAILABLE', 503);
  }
  return success(picked(data, ['workspace_id', 'dataset_id', 'version', 'accounting_revision',
    'algorithm_version', 'cache_key', 'range', 'data_cutoff', 'summary', 'rows', 'total',
    'page', 'page_size', 'query']));
}

export async function getCatalog(request: NextRequest) {
  const options = params(request, ['workspace_id']);
  const scope = await issueDirectoryScope({ headers: request.headers,
    workspaceId: optionalWorkspace(options.workspace_id) });
  const data = decoded((await upstream('catalog', scope.token)).bytes);
  return success(picked(data, ['metrics', 'templates']));
}

export async function getTemplate(request: NextRequest, resource: string) {
  if (!RESOURCES.has(resource)) throw new BiProblem('BI_INPUT_INVALID', 422);
  const options = params(request, ['workspace_id']);
  const scope = await issueDirectoryScope({ headers: request.headers,
    workspaceId: optionalWorkspace(options.workspace_id) });
  const result = await upstream(`templates/${resource}`, scope.token);
  if (!result.contentType.startsWith('text/csv')) throw new BiProblem('BI_UNAVAILABLE', 503);
  return new NextResponse(new Uint8Array(result.bytes), { headers: { ...HEADERS,
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="shopgate-${resource}-v1.csv"` } });
}

const JOB_FIELDS = ['workspace_id', 'dataset_id', 'job_id', 'kind', 'base_version', 'state',
  'result', 'cancel_requested', 'attempts', 'error_code', 'created_at', 'updated_at', 'expires_at', 'expired', 'stage_label'];

function jobInputScope(value: Record<string, unknown>) {
  if (typeof value.dataset_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(value.dataset_id)
      || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  return { datasetId: value.dataset_id, version: value.version,
    workspaceId: optionalWorkspace(value.workspace_id) };
}

function jobQueryScope(request: NextRequest, extra: string[] = []) {
  const options = params(request, ['workspace_id', 'dataset_id', 'version', ...extra]);
  if (!/^[1-9]\d{0,15}$/.test(options.version ?? '')) throw new BiProblem('BI_INPUT_INVALID', 422);
  return { scope: jobInputScope({ ...options, version: Number(options.version) }), options };
}

function checkedJob(value: unknown, scope: { workspaceId: string; datasetId: string }, jobId?: string) {
  const job = object(value);
  if (job.workspace_id !== scope.workspaceId || job.dataset_id !== scope.datasetId
      || (jobId !== undefined && job.job_id !== jobId)) throw new BiProblem('BI_UNAVAILABLE', 503);
  return picked(job, JOB_FIELDS);
}

function jobIdentifier(value: string) {
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(value)) throw new BiProblem('BI_INPUT_INVALID', 422);
  return value;
}

export async function postJob(request: NextRequest) {
  const body = await input(request, MAX_UPLOAD);
  keys(body, ['workspace_id', 'dataset_id', 'version', 'kind', 'parameters', 'idempotency_key', 'files']);
  if (!BI_JOB_KINDS.includes(body.kind as typeof BI_JOB_KINDS[number])
      || typeof body.idempotency_key !== 'string' || (body.files !== undefined && !Array.isArray(body.files))) {
    throw new BiProblem('BI_INPUT_INVALID', 422);
  }
  object(body.parameters);
  const scope = await issueJobScope({ headers: request.headers, ...jobInputScope(body), write: body.kind !== 'export_standard' });
  const data = decoded((await upstream('jobs', scope.token, picked(body, ['kind', 'parameters', 'idempotency_key', 'files']))).bytes);
  return success(checkedJob(data, scope), 202);
}

export async function getJobs(request: NextRequest, jobId?: string) {
  if (jobId !== undefined) jobIdentifier(jobId);
  const { scope: wanted, options } = jobQueryScope(request, jobId === undefined ? ['page'] : []);
  const scope = await issueJobScope({ headers: request.headers, ...wanted });
  const path = jobId === undefined ? `jobs?${new URLSearchParams(options.page ? { page: options.page } : {})}` : `jobs/${jobId}`;
  const data = decoded((await upstream(path, scope.token)).bytes);
  if (jobId !== undefined) return success(checkedJob(data, scope, jobId));
  if (!Array.isArray(data.rows)) throw new BiProblem('BI_UNAVAILABLE', 503);
  return success({ ...picked(data, ['page', 'page_size', 'total']), rows: data.rows.map((job) => checkedJob(job, scope)) });
}

export async function postJobAction(request: NextRequest, jobId: string, action: string) {
  jobIdentifier(jobId);
  if (!['cancel', 'reauthorize'].includes(action)) throw new BiProblem('BI_INPUT_INVALID', 422);
  const body = await input(request);
  keys(body, ['workspace_id', 'dataset_id', 'version']);
  const wanted = jobInputScope(body);
  const readScope = await issueJobScope({ headers: request.headers, ...wanted });
  const existing = checkedJob(decoded((await upstream(`jobs/${jobId}`, readScope.token)).bytes), readScope, jobId);
  const scope = existing.kind === 'export_standard' ? readScope
    : await issueJobScope({ headers: request.headers, ...wanted, write: true });
  const data = decoded((await upstream(`jobs/${jobId}/${action}`, scope.token, {})).bytes);
  return success(checkedJob(data, scope, jobId));
}

export async function getJobFile(request: NextRequest, jobId: string, resource: string) {
  jobIdentifier(jobId);
  if (!RESOURCES.has(resource) && resource !== 'errors') throw new BiProblem('BI_INPUT_INVALID', 422);
  const { scope: wanted } = jobQueryScope(request);
  const scope = await issueJobScope({ headers: request.headers, ...wanted });
  const result = await upstream(`jobs/${jobId}/files/${resource}`, scope.token, undefined, 256 * 1024 * 1024);
  if (!result.contentType.startsWith('text/csv')) throw new BiProblem('BI_UNAVAILABLE', 503);
  return new NextResponse(new Uint8Array(result.bytes), { headers: { ...HEADERS,
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="shopgate-${resource}-v1.csv"` } });
}

const BATCH_FIELDS = ['workspace_id', 'dataset_id', 'batch_id', 'resource_type', 'state',
  'row_count', 'error_count', 'version', 'based_on_version', 'created_at', 'expires_at',
  'expired', 'owned_by_current_user'];

function checkedBatch(value: unknown, scope: { workspaceId: string; datasetId: string }, batchId?: string) {
  const batch = object(value);
  if (batch.workspace_id !== scope.workspaceId || batch.dataset_id !== scope.datasetId
      || (batchId !== undefined && batch.batch_id !== batchId)) throw new BiProblem('BI_UNAVAILABLE', 503);
  const result = picked(batch, BATCH_FIELDS);
  if (batchId !== undefined) {
    result.can_confirm = batch.can_confirm === true && batch.owned_by_current_user === true;
    if (batch.owned_by_current_user === true) {
      Object.assign(result, picked(batch, ['preview_id', 'preview_expires_at', 'result', 'errors']));
      if (batch.evidence !== undefined) result.evidence = picked(object(batch.evidence), ['resources', 'files', 'template_version', 'impact']);
    }
  }
  return result;
}

export async function getBatchHistory(request: NextRequest, batchId?: string) {
  if (batchId !== undefined) jobIdentifier(batchId);
  const { scope: wanted, options } = jobQueryScope(request, batchId === undefined ? ['page'] : []);
  const scope = await issueLedgerScope({ headers: request.headers, ...wanted });
  const path = batchId === undefined ? `batches?${new URLSearchParams(options.page ? { page: options.page } : {})}` : `batches/${batchId}`;
  const data = decoded((await upstream(path, scope.token)).bytes);
  if (data.workspace_id !== scope.workspaceId || data.dataset_id !== scope.datasetId || data.version !== scope.version) {
    throw new BiProblem('BI_UNAVAILABLE', 503);
  }
  const envelope = picked(data, ['workspace_id', 'dataset_id', 'version']);
  if (batchId !== undefined) return success({ ...envelope, batch: checkedBatch(data.batch, scope, batchId) });
  if (!Array.isArray(data.rows)) throw new BiProblem('BI_UNAVAILABLE', 503);
  return success({ ...envelope, ...picked(data, ['total', 'page', 'page_size']), rows: data.rows.map((row) => checkedBatch(row, scope)) });
}

export async function getBatchErrors(request: NextRequest, batchId: string) {
  jobIdentifier(batchId);
  const { scope: wanted } = jobQueryScope(request);
  const scope = await issueLedgerScope({ headers: request.headers, ...wanted });
  const result = await upstream(`batches/${batchId}/errors`, scope.token, undefined, 256 * 1024 * 1024);
  if (!result.contentType.startsWith('text/csv')) throw new BiProblem('BI_UNAVAILABLE', 503);
  return new NextResponse(new Uint8Array(result.bytes), { headers: { ...HEADERS,
    'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="shopgate-errors-v1.csv"' } });
}
