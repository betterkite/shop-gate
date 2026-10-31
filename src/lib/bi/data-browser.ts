import type { z } from 'zod';
import { jobSchema, StableRequestKeys, UPLOAD_LIMITS, type DataJob } from './data-contracts';

export class DataRequestError extends Error {
  constructor(message: string, readonly status: number, readonly requestId?: string) { super(message); }
}

export async function readBi<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}) {
  if (!/^\/api\/bi\//.test(path)) throw new Error('经营数据只能通过当前站点访问。');
  const response = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin',
    headers: { ...(init.body ? { 'content-type': 'application/json', 'x-shopgate-request': 'same-origin' } : {}), ...init.headers } });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.success !== true) {
    const message = response.status === 401 ? '登录已过期，请重新登录后继续；后台任务和已有数据不会丢失。'
      : response.status === 403 || response.status === 404 ? '当前没有此工作空间或操作的权限，请检查账号与共享权限。'
        : response.status === 409 ? '数据版本或预览已变化，请刷新后重新预览。相同提交重试不会重复写入。'
          : response.status === 413 ? '文件或请求超出大小限制，请减少本批数据。'
            : response.status === 422 ? '提交内容未通过格式校验，请检查文件类型、名称和参数。'
              : response.status >= 500 ? '经营数据服务暂不可用，请稍后重试；不会使用演示数据代替结果。'
                : '请求未完成，请重试。';
    const requestId = typeof body?.request_id === 'string' && /^[a-f0-9-]{36}$/.test(body.request_id) ? body.request_id : undefined;
    throw new DataRequestError(message, response.status, requestId);
  }
  const parsed = schema.safeParse(body.data);
  if (!parsed.success) throw new DataRequestError('服务返回的数据格式不完整，请刷新后重试。', 502);
  return parsed.data;
}

export async function fileBase64(file: File) {
  if (!file.size || file.size > UPLOAD_LIMITS.file) throw new Error('单个文件须非空且不超过20 MB。');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength !== file.size) throw new Error('文件读取不完整，请重新选择文件。');
  const chunks: string[] = [];
  for (let index = 0; index < bytes.length; index += 16_384) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 16_384)));
  }
  return btoa(chunks.join(''));
}

export async function requestDigest(body: Record<string, unknown>) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Keep uncertain retries idempotent; an acknowledged job ends that submission intent. */
export async function submitDataJob(body: Record<string, unknown> & {
  workspace_id: string; dataset_id: string; version: number; kind: DataJob['kind'];
}, keys: StableRequestKeys, isCurrent: () => boolean = () => true) {
  const digest = await requestDigest(body);
  if (!isCurrent()) throw new Error('已切换数据范围，本次未提交。');
  const job = await readBi('/api/bi/jobs', jobSchema, { method: 'POST',
    body: JSON.stringify({ ...body, idempotency_key: keys.get(digest) }) });
  if (job.workspace_id !== body.workspace_id || job.dataset_id !== body.dataset_id
      || job.base_version !== body.version || job.kind !== body.kind) {
    throw new DataRequestError('任务的范围或版本不一致，请刷新后查看处理任务。', 502);
  }
  keys.forget(digest);
  return job;
}

export async function downloadBiFile(path: string, filename: string) {
  if (!path.startsWith('/api/bi/') || !/^shopgate-[a-z_]+-v1\.csv$/.test(filename)) throw new Error('下载路径或文件类型无效。');
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) {
    throw new DataRequestError(response.status === 401 ? '登录已过期，请重新登录后下载。'
      : response.status === 403 ? '当前无权下载此文件，请检查工作空间和任务归属。'
        : response.status === 410 ? '导出文件已到期，请重新导出；经营数据和任务记录仍保留。'
          : response.status === 409 ? '文件尚未准备好或已过期，请刷新任务。' : '下载未完成，请刷新任务后重试。', response.status);
  }
  if (!response.headers.get('content-type')?.startsWith('text/csv')) throw new DataRequestError('下载响应不是标准 CSV，请重新登录或刷新后重试。', 502);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
  } finally { window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export function dataErrorMessage(error: unknown) {
  if (error instanceof DataRequestError) return `${error.message}${error.requestId ? ` 请求编号：${error.requestId}` : ''}`;
  if (error instanceof TypeError) return '网络暂不可用，请检查连接后重试；后台任务和已有数据不会丢失。';
  return error instanceof Error ? error.message : '操作未完成，请重试。';
}
