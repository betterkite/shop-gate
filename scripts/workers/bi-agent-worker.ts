#!/usr/bin/env node
import './worker-environment';
import { prisma } from '../../src/lib/db/client';
import { assertPiAgentSchemaReady } from '../../src/lib/db/pi-agent-schema-readiness';
import { PiAgentWorkerRegistrySession } from '../../src/lib/services/pi-agent-worker-registry';
import { PiAgentWorkerCapacitySession } from '../../src/lib/services/pi-agent-worker-capacity';
import { executeBiAgentRun, failPendingBiAgentRun } from '../../src/lib/bi/agent/execution';
import { recoverBiAgentExecutions } from '../../src/lib/bi/agent/recovery';
import { AuthorizationError } from '../../src/lib/auth/authorization';
import { BiAgentProblem } from '../../src/lib/bi/agent/contracts';

function positiveInteger(name: string, fallback: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const concurrency = positiveInteger('PI_AGENT_WORKER_CONCURRENCY', 1, 16);
const globalConcurrency = positiveInteger('PI_AGENT_WORKER_GLOBAL_CONCURRENCY', concurrency, 256);
const pollMs = positiveInteger('PI_AGENT_WORKER_POLL_INTERVAL_MS', 1000, 60_000);
const ttl = positiveInteger('PI_AGENT_WORKER_SLOT_LEASE_TTL_MS', 120_000, 86_400_000);
const heartbeat = positiveInteger('PI_AGENT_WORKER_SLOT_HEARTBEAT_INTERVAL_MS', 30_000, 86_400_000);
const stopping = new AbortController();
for (const event of ['SIGINT', 'SIGTERM'] as const) process.once(event, () => stopping.abort());

async function main() {
  if (concurrency > globalConcurrency || heartbeat >= ttl) throw new Error('Invalid shared worker capacity configuration');
  await assertPiAgentSchemaReady(prisma);
  const registry = await PiAgentWorkerRegistrySession.start({ workerKind: 'bi_analysis',
    processConcurrency: concurrency, globalConcurrency, leaseTtlMs: ttl, heartbeatIntervalMs: heartbeat });
  const active = new Map<string, Promise<void>>();
  let nextMaintenance = 0;
  const once = process.argv.includes('--once');
  try {
    while (!stopping.signal.aborted) {
      registry.assertHealthy();
      if (Date.now() >= nextMaintenance) {
        await recoverBiAgentExecutions();
        nextMaintenance = Date.now() + 15_000;
      }
      const pending = await prisma.agentRun.findMany({ where: { biRequestId: { not: null }, status: 'pending',
        cancelRequestedAt: null, fencingToken: 0, startedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, version: true } });
      for (const row of pending) {
        if (stopping.signal.aborted || active.size >= concurrency) break;
        if (active.has(row.id)) continue;
        const slot = await PiAgentWorkerCapacitySession.tryClaim({ capacity: globalConcurrency,
          activeRunId: row.id, leaseOwner: registry.leaseOwner, leaseTtlMs: ttl, heartbeatIntervalMs: heartbeat });
        if (!slot) continue;
        const execution = (async () => {
          try {
            await executeBiAgentRun({ runId: row.id, expectedVersion: row.version, leaseOwner: registry.leaseOwner,
              signal: stopping.signal, assertCapacity: () => { registry.assertHealthy(); slot.assertHealthy(); } });
          } catch (error) {
            const code = error instanceof AuthorizationError ? 'BI_AGENT_AUTH_REVOKED'
              : error instanceof BiAgentProblem && ['BI_AGENT_NOT_FOUND', 'BI_AGENT_CANCELLED'].includes(error.code)
                ? 'BI_AGENT_REQUEST_INVALID'
                : error instanceof Error && ['BI_AGENT_MODEL_UNAVAILABLE', 'BI_AGENT_RUNTIME_CHANGED'].includes(error.message)
                  ? error.message : null;
            if (code) await failPendingBiAgentRun(row.id, row.version, code);
            // Do not log prompts, provider response bodies, session references or SQL errors.
            console.warn('[bi-agent-worker] execution ended; inspect authenticated run status');
          } finally {
            await slot.release().catch(() => console.warn('[bi-agent-worker] slot lease already lost'));
            active.delete(row.id);
          }
        })().catch(() => console.warn('[bi-agent-worker] persistence unavailable; maintenance will retry'));
        active.set(row.id, execution);
      }
      if (once) break;
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); stopping.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, pollMs);
        stopping.signal.addEventListener('abort', done, { once: true });
        if (stopping.signal.aborted) done();
      });
    }
    await Promise.allSettled(active.values());
    await recoverBiAgentExecutions();
  } finally {
    stopping.abort();
    await Promise.allSettled(active.values());
    await registry.stop();
  }
}
main().catch(() => { console.error('[bi-agent-worker] stopped; check database readiness and worker configuration'); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
