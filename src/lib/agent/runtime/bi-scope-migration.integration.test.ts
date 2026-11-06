import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { PrismaAgentRuntimeRepository } from './prisma-repository';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const migration = '20261107000100_agent_execution_scopes';

describe.skipIf(!databaseUrl)('BI execution scope migration (real PostgreSQL)', () => {
  it('upgrades populated legacy state without changing prior facts, events, keys or fences', async () => {
    // The dedicated PostgreSQL runner supplies this DSN. A unique schema keeps
    // migration rehearsal separate even from the other disposable test fixtures.
    const schema = `bi_upgrade_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(databaseUrl!);
    url.searchParams.set('schema', schema);
    const client = new PrismaClient({ datasourceUrl: url.toString() });
    const admin = new PrismaClient({ datasourceUrl: databaseUrl! });
    const directory = await mkdtemp(path.join(tmpdir(), 'shopgate-bi-upgrade-'));
    const prismaDirectory = path.join(directory, 'prisma');
    const localRequire = createRequire(import.meta.url);
    const prismaBin = path.join(path.dirname(localRequire.resolve('prisma/package.json')), 'build/index.js');
    function deploy() {
      const result = spawnSync(process.execPath,
        [prismaBin, 'migrate', 'deploy', '--schema', path.join(prismaDirectory, 'schema.prisma')],
        { cwd: directory, env: { ...process.env, DATABASE_URL: url.toString() }, encoding: 'utf8', timeout: 60_000 });
      if (result.error || result.signal || result.status !== 0) {
        throw new Error(`Owned migration rehearsal failed: ${result.error?.message ?? result.signal ?? result.status}; ${result.stderr.slice(-1500)}`);
      }
    }
    async function priorFacts() {
      const tables = await client.$queryRawUnsafe<Array<{ table_name: string }>>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = \'BASE TABLE\' ORDER BY table_name', schema);
      const snapshots: Record<string, unknown> = {};
      for (const { table_name: table } of tables) {
        if (['_prisma_migrations', 'agent_execution_scopes', 'bi_agent_conversations', 'bi_agent_requests', 'bi_agent_results', 'bi_agent_result_pages', 'bi_agent_answers'].includes(table)) continue;
        if (!/^[a-z_]+$/.test(table)) throw new Error('Unexpected rehearsal table identifier');
        const row = table === 'agent_runs' ? "to_jsonb(t) - 'execution_scope_id' - 'bi_request_id' - 'cancel_requested_at'"
          : table === 'agent_workspace_leases' ? "to_jsonb(t) - 'execution_scope_id'" : 'to_jsonb(t)';
        snapshots[table] = await client.$queryRawUnsafe(
          `SELECT coalesce(jsonb_agg(${row} ORDER BY (${row})::text), '[]'::jsonb) AS rows FROM "${schema}"."${table}" t`);
      }
      return snapshots;
    }
    try {
      await cp(path.join(process.cwd(), 'prisma'), prismaDirectory, { recursive: true,
        filter: (source) => !/^\d{14}_/.test(path.basename(source)) || path.basename(source) < migration });
      const migrations = await readdir(path.join(prismaDirectory, 'migrations'));
      expect(migrations).not.toContain(migration);
      deploy();
      await client.$connect();
      const projectId = 'legacy-project';
      const runId = 'legacy-run';
      await client.project.create({ data: { id: projectId, name: 'Unchanged legacy project' } });
      await client.userRequest.create({ data: { id: 'legacy-request', projectId, instruction: 'Existing history' } });
      const key = `sha256:${'a'.repeat(64)}`;
      await client.$executeRawUnsafe(`INSERT INTO agent_runs
        (id, run_instance_id, project_id, request_id, workspace_key, status, lease_owner, lease_expires_at,
         fencing_token, workspace_fencing_token, provider, model, framework_version, build_revision,
         profile_hash, prompt_hash, tool_hash, skill_hash, workspace_hash, version, last_event_sequence, updated_at)
        VALUES ($1, $2::uuid, $3, 'legacy-request', $4, 'running', 'previous-worker', NOW() + INTERVAL '10 minutes',
         7, 11, 'deepseek', 'deepseek-v4-flash', 'previous-framework', 'previous-build',
         $4, $4, $4, $4, $4, 9, 1, NOW())`, runId, randomUUID(), projectId, key);
      await client.$executeRawUnsafe(`INSERT INTO agent_workspace_leases
        (project_id, workspace_key, status, active_run_id, lease_owner, lease_expires_at, fencing_token, version, updated_at)
        VALUES ($1, $2, 'held', $3, 'previous-worker', NOW() + INTERVAL '10 minutes', 11, 12, NOW())`, projectId, key, runId);
      await client.agentEvent.create({ data: { eventId: 'old-event', runId, sequence: 1,
        eventType: 'analysis', payload: { note: 'Keep this evidence' }, occurredAt: new Date() } });
      await client.agentCheckpoint.create({ data: { runId, sequence: 1, turn: 1,
        boundary: 'model_turn_completed', publicState: { note: 'Keep this checkpoint' },
        stateHash: key, stateVersion: 1, fencingToken: 7 } });
      const before = await priorFacts();
      expect(Object.keys(before).length).toBeGreaterThan(50);
      for (const next of (await readdir(path.join(process.cwd(), 'prisma/migrations'))).filter((name) => name >= migration)) {
        await cp(path.join(process.cwd(), 'prisma/migrations', next),
          path.join(prismaDirectory, 'migrations', next), { recursive: true });
      }
      deploy();
      expect(await priorFacts()).toEqual(before);
      expect(await client.biAgentResult.count()).toBe(0);
      expect(await client.biAgentResultPage.count()).toBe(0);
      expect(await client.biAgentAnswer.count()).toBe(0);
      const repository = new PrismaAgentRuntimeRepository(client);
      const run = await repository.getRun(runId);
      const lease = await repository.getWorkspaceLease(projectId);
      expect(run).toMatchObject({ projectId, biRequestId: null, version: 9, fencingToken: 7, workspaceFencingToken: 11 });
      expect(lease).toMatchObject({ executionScopeId: run!.executionScopeId, activeRunId: runId, fencingToken: 11, version: 12 });
      expect(await client.agentExecutionScope.findUnique({ where: { id: run!.executionScopeId } }))
        .toMatchObject({ kind: 'project_workspace', projectId, workspaceId: projectId, ownerUserId: null });
      expect((await repository.listEventsAfter(runId, 0))[0].payload).toEqual({ note: 'Keep this evidence' });
      expect((await repository.getLatestCheckpoint(runId))?.publicState).toEqual({ note: 'Keep this checkpoint' });
      // A second normal deploy is a no-op, including all prior facts and leases.
      deploy();
      expect(await priorFacts()).toEqual(before);
    } finally {
      await client.$disconnect();
      try { await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.$disconnect(); await rm(directory, { recursive: true, force: true }); }
    }
  }, 120_000);
});
