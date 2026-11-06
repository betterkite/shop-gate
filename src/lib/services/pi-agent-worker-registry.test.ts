import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    agentWorkerInstance: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn(),
    },
  };
  return {
    transactionClient,
    transaction: vi.fn(async (
      callback: (tx: typeof transactionClient) => unknown,
    ) => callback(transactionClient)),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

import {
  heartbeatPiAgentWorkerInstance,
  registerPiAgentWorkerInstance,
  stopPiAgentWorkerInstance,
} from './pi-agent-worker-registry';

const now = new Date('2026-07-23T06:00:00.000Z');
const workerId = '7ac6e8c2-9bb8-4dd0-a267-91a44ca04e48';

function registrationInput() {
  return {
    id: workerId,
    poolKey: 'generation.default',
    hostname: 'worker-a',
    processId: 42,
    processConcurrency: 2,
    globalConcurrency: 4,
    leaseTtlMs: 120_000,
  };
}

function registeredWorker() {
  return {
    ...registrationInput(),
    leaseExpiresAt: new Date('2026-07-23T06:02:00.000Z'),
    lastHeartbeatAt: now,
    startedAt: now,
  };
}

describe('PI Agent Worker process registry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionClient.$queryRaw
      .mockResolvedValueOnce([{ databaseNow: now }])
      .mockResolvedValueOnce([{ pg_advisory_xact_lock: null }]);
    mocks.transactionClient.agentWorkerInstance.updateMany.mockResolvedValue({
      count: 0,
    });
    mocks.transactionClient.agentWorkerInstance.deleteMany.mockResolvedValue({
      count: 0,
    });
    mocks.transactionClient.agentWorkerInstance.findFirst.mockResolvedValue(null);
    mocks.transactionClient.agentWorkerInstance.upsert.mockResolvedValue(registeredWorker());
  });

  it('registers a live process after serializing the pool configuration', async () => {
    await expect(registerPiAgentWorkerInstance(registrationInput())).resolves.toEqual({
      id: workerId,
      workerKind: 'project_generation',
      poolKey: 'generation.default',
      hostname: 'worker-a',
      processId: 42,
      processConcurrency: 2,
      globalConcurrency: 4,
      leaseExpiresAt: '2026-07-23T06:02:00.000Z',
      lastHeartbeatAt: '2026-07-23T06:00:00.000Z',
      startedAt: '2026-07-23T06:00:00.000Z',
    });
    expect(mocks.transactionClient.$queryRaw).toHaveBeenCalledTimes(2);
    expect(mocks.transactionClient.agentWorkerInstance.upsert).toHaveBeenCalled();
  });

  it('registers BI capability explicitly without splitting the global capacity pool', async () => {
    const registered = await registerPiAgentWorkerInstance({ ...registrationInput(), workerKind: 'bi_analysis' });
    expect(registered).toMatchObject({ workerKind: 'bi_analysis', poolKey: 'generation.default' });
    expect(mocks.transactionClient.agentWorkerInstance.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ poolKey: 'generation.default', globalConcurrency: { not: 4 } }),
    }));
    const call = mocks.transactionClient.agentWorkerInstance.upsert.mock.calls[0][0];
    expect(call.create.workerKind).toBe('bi_analysis');
    expect(call.update.workerKind).toBe('bi_analysis');
  });

  it('fails closed when another live Worker advertises a different global capacity', async () => {
    mocks.transactionClient.agentWorkerInstance.findFirst.mockResolvedValue({
      id: '33e74ef8-f047-4926-b506-7952aee93ac7',
      hostname: 'worker-b',
      processId: 51,
      globalConcurrency: 8,
    });

    await expect(registerPiAgentWorkerInstance(registrationInput())).rejects.toMatchObject({
      code: 'WORKER_POOL_CONFIG_MISMATCH',
    });
    expect(mocks.transactionClient.agentWorkerInstance.upsert).not.toHaveBeenCalled();
  });

  it('heartbeats only a live matching configuration and stops idempotently', async () => {
    const claim = {
      id: workerId,
      poolKey: 'generation.default',
      hostname: 'worker-a',
      processId: 42,
      processConcurrency: 2,
      globalConcurrency: 4,
      leaseExpiresAt: '2026-07-23T06:02:00.000Z',
      lastHeartbeatAt: '2026-07-23T06:00:00.000Z',
      startedAt: '2026-07-23T06:00:00.000Z',
    };
    mocks.transactionClient.$queryRaw.mockReset();
    mocks.transactionClient.$queryRaw.mockResolvedValue([{ databaseNow: now }]);
    mocks.transactionClient.agentWorkerInstance.updateMany.mockResolvedValue({
      count: 1,
    });

    await expect(heartbeatPiAgentWorkerInstance({
      claim,
      leaseTtlMs: 120_000,
    })).resolves.toEqual({
      leaseExpiresAt: '2026-07-23T06:02:00.000Z',
    });
    await expect(stopPiAgentWorkerInstance(claim)).resolves.toBeUndefined();
    expect(mocks.transactionClient.agentWorkerInstance.updateMany)
      .toHaveBeenCalledTimes(2);
  });
});
