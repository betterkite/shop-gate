import fs from "node:fs/promises";
import path from "node:path";

import type { AgentGenerationJob } from "@prisma/client";

import { withPiAgentWorkspaceResourceLock } from "@/lib/agent/runtime/workspace-resource-lock";
import { DATA_AGENT_GENERATION_QUEUE_RELATIVE_PATH } from "@/lib/data-agent/workspace-layout";
import {
  appendRetailWorkspaceEvent,
  ensureRetailWorkspace,
} from "@/lib/domains/retail/workspace";
import {
  currentPiAgentGenerationDispatchFence,
  currentPiAgentGenerationDispatchSession,
  PiAgentGenerationDispatchSession,
} from "@/lib/services/pi-agent-generation-dispatch-session";
import {
  cancelPiAgentGenerationJob,
  enqueuePiAgentGenerationJob,
  finishPiAgentGenerationJob,
  listPiAgentGenerationJobs,
  listPendingPiAgentGenerationOutboxEvents,
  markPiAgentGenerationOutboxEventsPublished,
  reconcileExpiredPiAgentGenerationJobs,
  PiAgentGenerationDispatchError,
} from "@/lib/services/pi-agent-generation-dispatch-store";
import { withPiAgentGenerationLease } from "@/lib/services/pi-agent-generation-lease-session";
import type { PiAgentGenerationStage } from "@/lib/services/pi-agent-generation-lease-store";

export type GenerationQueueStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface GenerationQueueItem {
  id: string;
  projectId: string;
  requestId: string;
  status: GenerationQueueStatus;
  cliPreference: string | null;
  selectedModel: string | null;
  instructionPreview: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
}

export interface GenerationQueueState {
  schemaVersion: 1;
  projectId: string;
  activeRequestId: string | null;
  updatedAt: string;
  items: GenerationQueueItem[];
}

type QueueTask<T> = () => Promise<T>;

const MAX_QUEUE_ITEMS =
  Number.parseInt(
    process.env.SHOPGATE_GENERATION_QUEUE_HISTORY_LIMIT ?? "",
    10,
  ) || 50;

export class GenerationCancelledError extends Error {
  constructor(message = "生成任务已取消。") {
    super(message);
    this.name = "GenerationCancelledError";
  }
}

function queuePath(projectPath: string) {
  return path.join(projectPath, DATA_AGENT_GENERATION_QUEUE_RELATIVE_PATH);
}

function projectionStatus(status: string): GenerationQueueStatus {
  if (status === "pending" || status === "retry_wait") return "queued";
  if (status === "running") return "running";
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  return "failed";
}

function projectJob(job: AgentGenerationJob): GenerationQueueItem {
  return {
    id: job.id,
    projectId: job.projectId,
    requestId: job.requestId,
    status: projectionStatus(job.status),
    cliPreference: job.cliPreference,
    selectedModel: job.selectedModel,
    instructionPreview: job.instructionPreview,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
    errorMessage: job.errorMessage,
  };
}

async function writeProjection(
  projectPath: string,
  state: GenerationQueueState,
): Promise<void> {
  await ensureRetailWorkspace(projectPath);
  const filePath = queuePath(projectPath);
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

/**
 * Materialize the PostgreSQL dispatch ledger into the generated workspace.
 * The JSON file is deliberately disposable: a failed or stale write is
 * repaired from jobs/outbox on the next read or lifecycle transition.
 */
async function projectDurableQueue(
  projectPath: string,
  projectId: string,
  options: { reconcileExpired?: boolean } = {},
): Promise<GenerationQueueState> {
  if (options.reconcileExpired !== false) {
    await reconcileExpiredPiAgentGenerationJobs({ projectId });
  }
  const [jobs, pendingEvents] = await Promise.all([
    listPiAgentGenerationJobs(projectId, MAX_QUEUE_ITEMS),
    listPendingPiAgentGenerationOutboxEvents(projectId),
  ]);
  const items = jobs.map(projectJob);
  const state: GenerationQueueState = {
    schemaVersion: 1,
    projectId,
    activeRequestId:
      items.find((item) => item.status === "running")?.requestId ?? null,
    updatedAt: jobs[0]?.updatedAt.toISOString() ?? new Date().toISOString(),
    items,
  };
  await writeProjection(projectPath, state);
  if (pendingEvents.length > 0) {
    await markPiAgentGenerationOutboxEventsPublished(
      pendingEvents.map((event) => event.id),
    );
  }
  return state;
}

async function appendLifecycleEvent(params: {
  projectPath: string;
  requestId: string;
  eventType: string;
  status: "pending" | "success" | "warning" | "error";
  summary: string;
}): Promise<void> {
  await appendRetailWorkspaceEvent(params.projectPath, {
    event_type: params.eventType,
    stage: "queue",
    status: params.status,
    run_id: params.requestId,
    artifact_path: DATA_AGENT_GENERATION_QUEUE_RELATIVE_PATH,
    summary: params.summary,
    created_at: new Date().toISOString(),
  });
}

export async function runRetailGenerationStage<T>(params: {
  projectPath: string;
  projectId: string;
  requestId?: string | null;
  stage: PiAgentGenerationStage;
  lockWorkspace?: boolean;
  task: QueueTask<T>;
}): Promise<T> {
  if (params.stage === "planning_data_prefetch") {
    await reconcileExpiredPiAgentGenerationJobs({
      projectId: params.projectId,
    });
  }
  return withPiAgentGenerationLease({
    projectId: params.projectId,
    requestId: params.requestId,
    stage: params.stage,
    task: async () => {
      if (!params.lockWorkspace) return params.task();
      return withPiAgentWorkspaceResourceLock(params.projectPath, params.task, {
        metadata: {
          purpose: "platform_generation",
          projectId: params.projectId,
          requestId: params.requestId ?? "unbound",
          operationId: params.stage,
        },
      });
    },
  });
}

interface GenerationQueuedParams<T> {
  projectPath: string;
  projectId: string;
  requestId: string;
  instruction: string;
  cliPreference?: string | null;
  selectedModel?: string | null;
  executionEnvelope?: unknown;
  maxAttempts?: number;
  completeOnTaskSuccess?: boolean;
  completeOnTaskFailure?: boolean;
  task: QueueTask<T>;
}

async function prepareGenerationDispatch<T>(
  params: GenerationQueuedParams<T>,
): Promise<PiAgentGenerationDispatchSession> {
  let dispatch: PiAgentGenerationDispatchSession;
  try {
    dispatch = await PiAgentGenerationDispatchSession.enqueueAndClaim({
      projectId: params.projectId,
      requestId: params.requestId,
      instruction: params.instruction,
      cliPreference: params.cliPreference,
      selectedModel: params.selectedModel,
      executionEnvelope: params.executionEnvelope,
      maxAttempts: params.maxAttempts,
    });
  } catch (error) {
    if (
      error instanceof PiAgentGenerationDispatchError &&
      error.code === "GENERATION_DISPATCH_CANCELLED"
    ) {
      await projectDurableQueue(params.projectPath, params.projectId, {
        reconcileExpired: false,
      }).catch(() => undefined);
      throw new GenerationCancelledError(error.message);
    }
    throw error;
  }
  try {
    await projectDurableQueue(params.projectPath, params.projectId, {
      reconcileExpired: false,
    });
    await appendLifecycleEvent({
      projectPath: params.projectPath,
      requestId: params.requestId,
      eventType: "generation_queued",
      status: "pending",
      summary: "生成任务已进入 PostgreSQL durable dispatch。",
    });
    await appendLifecycleEvent({
      projectPath: params.projectPath,
      requestId: params.requestId,
      eventType: "generation_queue_started",
      status: "pending",
      summary: `生成任务由 durable worker claim（attempt ${dispatch.claim.attemptCount}）。`,
    });
    return dispatch;
  } catch (error) {
    await finishPiAgentGenerationJob({
      projectId: params.projectId,
      requestId: params.requestId,
      status: "failed",
      errorCode: "GENERATION_DISPATCH_ACCEPTANCE_FAILED",
      errorMessage: error instanceof Error ? error.message : String(error),
      fence: dispatch.fence,
    }).catch(() => undefined);
    dispatch.dispose();
    throw error;
  }
}

export async function enqueueGeneration(params: Omit<
  GenerationQueuedParams<never>,
  "task" | "completeOnTaskSuccess" | "completeOnTaskFailure"
>): Promise<void> {
  await enqueuePiAgentGenerationJob({
    projectId: params.projectId,
    requestId: params.requestId,
    instruction: params.instruction,
    cliPreference: params.cliPreference,
    selectedModel: params.selectedModel,
    executionEnvelope: params.executionEnvelope,
    maxAttempts: params.maxAttempts,
  });
  await projectDurableQueue(params.projectPath, params.projectId, {
    reconcileExpired: false,
  });
  await appendLifecycleEvent({
    projectPath: params.projectPath,
    requestId: params.requestId,
    eventType: "generation_queued",
    status: "pending",
    summary: "生成任务已进入 PostgreSQL durable dispatch，等待独立 Worker。",
  });
}

async function executeGenerationDispatch<T>(
  params: GenerationQueuedParams<T>,
  dispatch: PiAgentGenerationDispatchSession,
): Promise<T> {
  try {
    const result = await withPiAgentGenerationLease({
      projectId: params.projectId,
      requestId: params.requestId,
      stage: "agent_execution",
      task: () => dispatch.run(params.task),
    });
    // The task has already reached its own terminal boundary. A heartbeat
    // failure that arrives after the task resolves must not turn a successful
    // answer/dashboard run into a queue failure; the fenced terminal write
    // below is the authoritative dispatch decision.
    if (params.completeOnTaskSuccess !== false) {
      await (typeof dispatch.runTerminal === "function" ? dispatch.runTerminal(() =>
        finishGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "completed",
        }),
      ) : dispatch.run(() =>
        finishGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "completed",
        }),
      ));
    }
    return result;
  } catch (error) {
    await (typeof dispatch.runTerminal === "function" ? dispatch.runTerminal(() =>
        finishGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      ) : dispatch.run(() =>
        finishGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        }),
      ))
      .catch((finishError) => {
        if (
          params.completeOnTaskFailure !== false &&
          process.env.NODE_ENV !== "test"
        ) {
          console.error(
            "[GenerationDispatch] Failed to persist task failure:",
            finishError,
          );
        }
      });
    throw error;
  } finally {
    dispatch.dispose();
    await projectDurableQueue(params.projectPath, params.projectId).catch(
      () => undefined,
    );
  }
}

/**
 * Persist and claim before returning control to the HTTP request, then expose
 * a separately awaitable completion for the background lifecycle.
 */
export async function startGenerationQueued<T>(
  params: GenerationQueuedParams<T>,
): Promise<{ completion: Promise<T> }> {
  const dispatch = await prepareGenerationDispatch(params);
  return { completion: executeGenerationDispatch(params, dispatch) };
}

export async function runGenerationQueued<T>(
  params: GenerationQueuedParams<T>,
): Promise<T> {
  const started = await startGenerationQueued(params);
  return started.completion;
}

export async function finishGenerationQueueItem(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  status: Exclude<GenerationQueueStatus, "queued" | "running">;
  errorMessage?: string | null;
}) {
  if (params.status === "cancelled") {
    return markGenerationQueueCancelled({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      reason: params.errorMessage,
    });
  }
  const job = await finishPiAgentGenerationJob({
    projectId: params.projectId,
    requestId: params.requestId,
    status: params.status,
    errorCode: params.status === "failed" ? "GENERATION_FAILED" : null,
    errorMessage: params.errorMessage,
    fence: currentPiAgentGenerationDispatchFence(),
  });
  await projectDurableQueue(params.projectPath, params.projectId, {
    reconcileExpired: false,
  });
  await appendLifecycleEvent({
    projectPath: params.projectPath,
    requestId: params.requestId,
    eventType: "generation_queue_finished",
    status: params.status === "completed" ? "success" : "error",
    summary:
      params.status === "completed"
        ? "生成任务执行完成。"
        : `生成任务失败：${params.errorMessage ?? "未知错误"}`,
  });
  currentPiAgentGenerationDispatchSession()?.markTerminal();
  return job;
}

export async function markGenerationQueueCancelled(params: {
  projectPath: string;
  projectId: string;
  requestId: string;
  reason?: string | null;
}) {
  const job = await cancelPiAgentGenerationJob({
    projectId: params.projectId,
    requestId: params.requestId,
    reason: params.reason,
  });
  if (!job) return null;
  await projectDurableQueue(params.projectPath, params.projectId, {
    reconcileExpired: false,
  });
  await appendLifecycleEvent({
    projectPath: params.projectPath,
    requestId: params.requestId,
    eventType: "generation_queue_finished",
    status: "warning",
    summary: "生成任务已取消。",
  });
  currentPiAgentGenerationDispatchSession()?.markTerminal();
  return job;
}

export async function readGenerationQueue(
  projectPath: string,
  projectId: string,
) {
  return projectDurableQueue(projectPath, projectId);
}
