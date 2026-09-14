import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { createMessage } from "@/lib/services/message";
import { streamManager } from "@/lib/services/stream";
import { serializeMessage } from "@/lib/serializers/chat";
import type { writeInitialRunPlan } from "@/lib/domains/retail/workspace";
import { resolveManagedWorkspacePath } from "@/lib/data-agent";

export async function loadRetailValidation() {
  return import("@/lib/commerce/retail-validation");
}

export async function ensureRetailDashboardTemplateForAct(projectPath: string) {
  const { ensureRetailDashboardTemplate } = await import("@/lib/utils/scaffold");
  return ensureRetailDashboardTemplate(projectPath);
}

const REQUIRED_AGENT_INPUT_ARTIFACTS = [
  "data_file/final/dashboard-data.json",
  "evidence/sources.json",
  "evidence/data_quality.json",
] as const;

export async function missingAgentInputArtifacts(
  projectPath: string,
): Promise<string[]> {
  const checks = await Promise.all(
    REQUIRED_AGENT_INPUT_ARTIFACTS.map(async (relativePath) => {
      try {
        const stat = await fs.stat(
          path.join(/* turbopackIgnore: true */ projectPath, relativePath),
        );
        return stat.isFile() && stat.size > 2 ? null : relativePath;
      } catch {
        return relativePath;
      }
    }),
  );
  return checks.flatMap((value) => (value === null ? [] : [value]));
}

export function resolveProjectRoot(
  projectId: string,
  repoPath?: string | null,
): string {
  return resolveManagedWorkspacePath(projectId, repoPath);
}

export function canUsePrefetchedDashboard(params: {
  instruction: string;
  runPlan: Awaited<ReturnType<typeof writeInitialRunPlan>>;
  prefetchSkipped: boolean;
}): boolean {
  if (params.prefetchSkipped) {
    return false;
  }
  // 零售确定性看板门槛：计划 planned、模板已声明、预取成功即可。
  // 全库口径（无实体）或显式实体范围都允许——模板渲染只依赖最终数据文件。
  return (
    params.runPlan.status === "planned" &&
    params.runPlan.routeStatus === "dashboard" &&
    Boolean(params.runPlan.visualization?.templateId) &&
    params.runPlan.visualization?.required === true
  );
}

function retailPipelineToolAction(toolName: string) {
  return toolName === "run-planner"
    ? "Generated"
    : toolName === "dashboard-visualization"
      ? "Created"
      : "Read";
}

function stringifyRetailPipelineToolDetail(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export async function publishRetailPipelineToolStart(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
}): Promise<string> {
  const toolCallId = `retail-pipeline-${randomUUID()}`;
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    toolCallId,
    tool_call_id: toolCallId,
    action: retailPipelineToolAction(params.toolName),
    success: true,
    resultStatus: "running",
    summary: params.summary,
    isTransientToolMessage: true,
    ...(params.target
      ? { target: params.target, filePath: params.target }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    isShopGatePipelineStep: true,
  };
  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_use",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });
  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });
  return toolCallId;
}

export async function publishRetailPipelineToolMessage(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
  success?: boolean;
  resultStatus?: "completed" | "failed" | "skipped";
}) {
  const success = params.success !== false;
  const resultStatus =
    params.resultStatus ?? (success ? "completed" : "failed");
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    ...(params.toolCallId
      ? { toolCallId: params.toolCallId, tool_call_id: params.toolCallId }
      : {}),
    action: retailPipelineToolAction(params.toolName),
    success,
    resultStatus,
    summary: params.summary,
    isTransientToolMessage: false,
    ...(params.target
      ? {
          target: params.target,
          filePath: params.target,
        }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    ...(params.output !== undefined
      ? {
          toolOutput: stringifyRetailPipelineToolDetail(params.output),
          tool_output: stringifyRetailPipelineToolDetail(params.output),
          output: stringifyRetailPipelineToolDetail(params.output),
        }
      : {}),
    isShopGatePipelineStep: true,
  };

  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_result",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });

  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });

  return message;
}

export class RetailPreparationError extends Error {
  constructor(
    readonly code:
      | "ENTITY_RESOLVER_UNAVAILABLE"
      | "RETAIL_DATA_PREPARATION_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RetailPreparationError";
  }
}
