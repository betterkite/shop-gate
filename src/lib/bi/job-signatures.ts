// Private service protocol, shared by the exact proxy gate and authorization handler.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const BI_JOB_AUTH_PATH = '/api/internal/bi/job-authorization';
export const BI_JOB_KINDS = ['preview_import', 'prepare_demo', 'confirm_import', 'export_standard'] as const;
export type BiJobKind = typeof BI_JOB_KINDS[number];
export interface JobAuthorizationClaim {
  aud: 'shopgate-bi-job-auth-v1';
  workspace_id: string;
  dataset_id: string;
  actor_id: string;
  session_id: string;
  version: number;
  job_id: string;
  kind: BiJobKind;
  request_hash: string;
  phase: 'start' | 'commit';
  capabilities: ['job.authorize'];
  iat: number;
  exp: number;
}
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,120}$/;
const FIELDS = ['aud', 'workspace_id', 'dataset_id', 'actor_id', 'session_id', 'version',
  'job_id', 'kind', 'request_hash', 'phase', 'capabilities', 'iat', 'exp'].sort();

export function signBiServiceClaims(claims: Record<string, unknown>) {
  if (typeof window !== 'undefined') throw new Error('Private BI signing is server-only.');
  const secret = process.env.SHOPGATE_BI_SERVICE_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32) throw new Error('Private BI signing is not configured.');
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
}

/** No user cookie/actor header can enter this gate. Identity is bound by service HMAC. */
export function verifyJobAuthorizationRequest(header: string | null, now = Math.floor(Date.now() / 1000)): JobAuthorizationClaim {
  const denied = () => { throw new Error('Invalid private BI authorization.'); };
  const secret = process.env.SHOPGATE_BI_SERVICE_SECRET ?? '';
  if (Buffer.byteLength(secret) < 32 || !header?.startsWith('Bearer ') || header.length > 4096) return denied();
  const parts = header.slice(7).split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return denied();
  const expected = createHmac('sha256', secret).update(parts[0]).digest('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(parts[1]))) return denied();
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(parts[0], 'base64url')));
  } catch { return denied(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(FIELDS)
      || value.aud !== 'shopgate-bi-job-auth-v1') return denied();
  for (const key of ['workspace_id', 'dataset_id', 'actor_id', 'session_id', 'job_id']) {
    if (typeof value[key] !== 'string' || !IDENTIFIER.test(value[key])) return denied();
  }
  if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1
      || typeof value.iat !== 'number' || !Number.isSafeInteger(value.iat)
      || typeof value.exp !== 'number' || !Number.isSafeInteger(value.exp)
      || !(0 <= value.iat && value.iat <= now && now < value.exp && value.exp - value.iat <= 30)
      || !BI_JOB_KINDS.includes(value.kind as BiJobKind)
      || !['start', 'commit'].includes(value.phase as string)
      || typeof value.request_hash !== 'string' || !/^[a-f0-9]{64}$/.test(value.request_hash)
      || !Array.isArray(value.capabilities) || value.capabilities.length !== 1
      || value.capabilities[0] !== 'job.authorize') return denied();
  return value as unknown as JobAuthorizationClaim;
}
