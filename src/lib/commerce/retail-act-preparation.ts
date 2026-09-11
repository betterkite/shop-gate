import { NextResponse } from "next/server";

import { collectPiAgentTurnMetrics } from "@/lib/services/pi-agent-turn-metrics";
import { createMessage } from "@/lib/services/message";
import { serializeMessage } from "@/lib/serializers/chat";
import { streamManager } from "@/lib/services/stream";
import {
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  isUserRequestCancelled,
} from "@/lib/services/user-requests";
import {
  recordQuotaUsage,
  releaseQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from "@/lib/quota";
import {
  readRetailRunPlan,
  writeInitialRunPlan,
  type RetailRunPlan,
} from "@/lib/domains/retail/workspace";
import { prefetchRetailDataForRunPlan } from "@/lib/commerce/retail-data-prefetch";
import { getRetailCapability } from "@/lib/domains/retail/capabilities";
import type { WorkspaceProgressPublisher } from "@/lib/generation/workspace-progress";
import { buildRetailClarificationMessage } from "@/lib/domains/retail/intent";
import {
  startRetailGenerationRun,
  updateRetailGenerationStep,
} from "@/lib/generation/generation-state";
import { runRetailGenerationStage } from "@/lib/generation/generation-queue";
import {
  createRetailPiAgentMission,
  markRetailPiAgentMissionNode,
  type PiAgentMissionContext,
} from "@/lib/services/pi-agent-mission-control";
import {
  failPiAgentMission,
  PiAgentMissionStateError,
} from "@/lib/services/pi-agent-mission-store";
import {
  prepareGovernedKnowledge,
  writeGovernedKnowledgeEvidence,
  type GovernedKnowledgePreparation,
} from "@/lib/platform/knowledge";
import { getProjectIntegrationScope } from "@/lib/platform/context/integration-scope";
import {
  RetailPreparationError,
  canUsePrefetchedDashboard,
  ensureRetailDashboardTemplateForAct,
  missingAgentInputArtifacts,
  publishRetailPipelineToolMessage,
  publishRetailPipelineToolStart,
} from "@/lib/generation/chat-act-support";

export interface RetailActPreparationInput {
  projectId: string;
  projectPath: string;
  requestId: string;
  finalInstruction: string;
  effectiveInstruction: string;
  effectiveDisplayInstruction: string;
  isInitialPrompt: boolean;
  cliPreference: string;
  selectedModel: string;
  conversationId: string | null;
  capabilityId?: string | null;
  capabilitySelectionSource?: string | null;
  processedImageCount: number;
  previousRunPlan: RetailRunPlan | null;
  quotaActorUserId: string | null;
  userMessageId: string;
  relatedAgentRequestIds: ReadonlySet<string>;
  publishWorkspaceProgress: WorkspaceProgressPublisher;
}

export interface RetailActPreparationResult {
  response: NextResponse | null;
  missionContext: PiAgentMissionContext | null;
  usePrefetchedSelectionDashboard: boolean;
  governedKnowledgePreparation: GovernedKnowledgePreparation | null;
  governedKnowledgeTaskCategory: string;
}

export async function prepareRetailActGeneration(
  input: RetailActPreparationInput,
): Promise<RetailActPreparationResult> {
  const {
    projectId: project_id,
    projectPath,
    requestId,
    finalInstruction,
    effectiveInstruction,
    effectiveDisplayInstruction,
    isInitialPrompt,
    cliPreference,
    selectedModel,
    conversationId,
    capabilityId,
    capabilitySelectionSource,
    processedImageCount,
    previousRunPlan,
    quotaActorUserId,
    userMessageId,
    relatedAgentRequestIds,
    publishWorkspaceProgress,
  } = input;
  let usePrefetchedSelectionDashboard = false;
  let missionContext: PiAgentMissionContext | null = null;
  const projectIntegrationScope = getProjectIntegrationScope(project_id);
  let governedKnowledgePreparation: GovernedKnowledgePreparation | null = null;
  let governedKnowledgeTaskCategory = "retail-operations";

  const clarificationResponse = await runRetailGenerationStage({
    projectPath,
    projectId: project_id,
    requestId,
    stage: "planning_data_prefetch",
    lockWorkspace: true,
    task: async () => {
      const generationState = await startRetailGenerationRun({
        projectPath,
        projectId: project_id,
        requestId,
        instruction: finalInstruction,
        cliPreference,
        selectedModel,
      });
      if (
        generationState.status === "cancelled" ||
        (await isUserRequestCancelled(project_id, requestId))
      ) {
        await publishWorkspaceProgress({
          stage: 5,
          cancelledReason: "请求在规划开始前已暂停。",
        });
        return NextResponse.json({
          success: true,
          status: "cancelled",
          message: "Generation request was cancelled before planning",
          requestId,
          userMessageId: userMessageId,
          conversationId: conversationId ?? null,
        });
      }
      let queryRewriteToolCallId: string | undefined;
      let runPlannerToolCallId: string | undefined;
      let dataRegistryToolCallId: string | undefined;
      let marketDataToolCallId: string | undefined;
      let dashboardVisualizationToolCallId: string | undefined;
      let queryRewriteQuotaReservationId: string | null = null;
      try {
        await updateRetailGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "planning",
          status: "running",
          summary: "开始生成 run plan。",
        });
        const planningInstruction =
          effectiveDisplayInstruction &&
          effectiveDisplayInstruction.trim().length > 0
            ? effectiveDisplayInstruction.trim()
            : effectiveInstruction;
        queryRewriteToolCallId = await publishRetailPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "query-rewrite",
          target: ".data-agent/retail-query-rewrite.json",
          summary: "正在把用户问题整理为可执行的类目/商品、周期和分析合同。",
          input: {
            question: planningInstruction,
            requestedCapabilityId: capabilityId,
          },
        });
        runPlannerToolCallId = await publishRetailPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "run-planner",
          target: ".data-agent/retail-run-plan.json",
          summary: "正在核对分析对象、时间范围、数据需求和验收规则。",
          input: {
            question: planningInstruction,
            requestedCapabilityId: capabilityId,
          },
        });
        if (quotaActorUserId) {
          const queryRewriteQuota = await reserveQuota({
            actorUserId: quotaActorUserId,
            projectId: project_id,
            metric: "commerce.query_rewrite.llm.daily",
            quantity: 1,
            idempotencyKey: `chat-query-rewrite:${quotaActorUserId}:${requestId}:reservation`,
          });
          queryRewriteQuotaReservationId =
            queryRewriteQuota.reservation?.id ?? null;
        }
        const runPlan = await writeInitialRunPlan({
          projectId: project_id,
          projectPath,
          instruction: planningInstruction,
          requestId,
          capabilityId,
          capabilitySource: capabilitySelectionSource,
          hasImageAttachments: processedImageCount > 0,
          previousPlan: previousRunPlan,
          llmModel: selectedModel,
        });
        const answerOnlyIntent = runPlan.queryRewrite?.outputIntent === "answer";

        const queryRewriteUsage = runPlan.queryRewrite?.execution.llm.usage;
        if (quotaActorUserId && queryRewriteQuotaReservationId) {
          await settleQuotaReservation({
            reservationId: queryRewriteQuotaReservationId,
            actualQuantity: runPlan.queryRewrite?.execution.llm.attempted
              ? 1
              : 0,
            sourceType: "query_rewrite",
            sourceId: requestId,
            usageEventIdempotencyKey: `chat-query-rewrite:${quotaActorUserId}:${requestId}:request`,
            metadata: {
              status:
                runPlan.queryRewrite?.execution.llm.status ?? "not_attempted",
              strategy:
                runPlan.queryRewrite?.execution.strategy ?? "deterministic",
            },
          });
          queryRewriteQuotaReservationId = null;
        }
        if (
          quotaActorUserId &&
          runPlan.queryRewrite?.execution.llm.attempted &&
          queryRewriteUsage &&
          queryRewriteUsage.totalTokens > 0
        ) {
          const actorId = quotaActorUserId;
          await recordQuotaUsage({
            actorUserId: actorId,
            projectId: project_id,
            metric: "llm.total_tokens.monthly",
            quantity: queryRewriteUsage.totalTokens,
            idempotencyKey: `chat-query-rewrite:${actorId}:${requestId}:tokens`,
            sourceType: "query_rewrite",
            sourceId: requestId,
            metadata: {
              provider: runPlan.queryRewrite.execution.llm.provider,
              model: runPlan.queryRewrite.execution.llm.model,
              inputTokens: queryRewriteUsage.inputTokens,
              outputTokens: queryRewriteUsage.outputTokens,
            },
          }).catch((error) => {
            console.error(
              "[Quota] Failed to record chat Query Rewrite token usage:",
              error,
            );
          });
        }

        await publishRetailPipelineToolMessage({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "query-rewrite",
          toolCallId: queryRewriteToolCallId,
          target: ".data-agent/retail-query-rewrite.json",
          summary:
            runPlan.queryRewrite?.status === "refused"
              ? "问题改写完成，安全策略已阻止确定性销量承诺。"
              : runPlan.queryRewrite?.status === "ready"
                ? `问题改写完成，已解析 ${runPlan.queryRewrite.resolvedEntities.length} 个类目/商品实体${runPlan.queryRewrite.execution.llm.applied ? "，并完成 LLM 语义增强" : ""}。`
                : "问题改写完成，存在需要确认的类目/商品或输入。",
          input: { question: planningInstruction },
          output: runPlan.queryRewrite ?? {},
        });
        queryRewriteToolCallId = undefined;

        await publishWorkspaceProgress({ stage: 1, runPlan });
        await publishRetailPipelineToolMessage({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "run-planner",
          toolCallId: runPlannerToolCallId,
          target: ".data-agent/retail-run-plan.json",
          summary:
            runPlan.status === "refused"
              ? "请求触发确定性安全策略，停止进入取数和生成链路。"
              : runPlan.status === "needs_clarification"
                ? "已完成初步识别，发现关键输入仍需澄清。"
                : `生成 ${runPlan.capabilityId} 执行计划，准备进入数据源选择和预取。`,
          input: {
            question: runPlan.question,
            capabilityId: runPlan.capabilityId,
          },
          output: {
            status: runPlan.status,
            templateId: runPlan.visualization?.templateId,
            entities: runPlan.entities,
            dataRequirements: runPlan.dataRequirements,
            analysisSteps: runPlan.analysisSteps,
          },
        });
        runPlannerToolCallId = undefined;

        if (runPlan.status === "refused" && runPlan.refusal) {
          await updateRetailGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "warning",
            summary: "请求触发安全策略，未执行取数或生成。",
            runStatus: "refused",
            metadata: {
              code: runPlan.refusal.code,
            },
          });
          const assistantMessage = await createMessage({
            projectId: project_id,
            role: "assistant",
            messageType: "chat",
            content: runPlan.refusal.message,
            conversationId: conversationId ?? undefined,
            cliSource: cliPreference,
            metadata: {
              type: "intent_refusal",
              refusal: runPlan.refusal,
              runPlanPath: ".data-agent/retail-run-plan.json",
              isMissionFinal: true,
              progressStatus: "refused",
            },
            requestId,
          });
          await markUserRequestAsCompleted(project_id, requestId);
          streamManager.publish(project_id, {
            type: "message",
            data: serializeMessage(assistantMessage, { requestId }),
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "intent_refused",
              message: runPlan.refusal.message,
              requestId,
              metadata: { code: runPlan.refusal.code },
            },
          });
          return NextResponse.json({
            success: true,
            status: "intent_refused",
            message: runPlan.refusal.message,
            requestId,
            userMessageId: userMessageId,
            assistantMessageId: assistantMessage.id,
            conversationId: conversationId ?? null,
            refusal: runPlan.refusal,
          });
        }

        if (
          runPlan.status === "needs_clarification" &&
          runPlan.clarification?.required
        ) {
          await updateRetailGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "warning",
            summary: "任务缺少关键输入，需要用户澄清。",
            runStatus: "needs_clarification",
            metadata: {
              missing: runPlan.clarification.missing,
              questions: runPlan.clarification.questions,
            },
          });
          const clarificationContent = buildRetailClarificationMessage(
            runPlan.clarification,
            runPlan.queryRewrite?.outputIntent,
          );
          const turnMetrics = await collectPiAgentTurnMetrics({
            projectId: project_id,
            requestId,
            relatedRequestIds: relatedAgentRequestIds,
          }).catch((error) => {
            console.error(
              "[API] Failed to collect clarification turn metrics:",
              error,
            );
            return null;
          });
          const assistantMessage = await createMessage({
            projectId: project_id,
            role: "assistant",
            messageType: "chat",
            content: clarificationContent,
            conversationId: conversationId ?? undefined,
            cliSource: cliPreference,
            metadata: {
              type: "intent_clarification",
              clarification: runPlan.clarification,
              runPlanPath: ".data-agent/retail-run-plan.json",
              isMissionFinal: true,
              progressStatus: "clarification",
              ...(turnMetrics ? { turnMetrics } : {}),
            },
            requestId,
          });

          await markUserRequestAsCompleted(project_id, requestId);
          streamManager.publish(project_id, {
            type: "message",
            data: serializeMessage(assistantMessage, { requestId }),
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "intent_clarification_required",
              message: "需要补充关键信息后再开始取数和生成看板。",
              requestId,
              metadata: {
                missing: runPlan.clarification.missing,
                questions: runPlan.clarification.questions,
              },
            },
          });

          return NextResponse.json({
            success: true,
            status: "intent_clarification_required",
            message: "Need clarification before agent execution",
            requestId,
            userMessageId: userMessageId,
            assistantMessageId: assistantMessage.id,
            conversationId: conversationId ?? null,
            clarification: runPlan.clarification,
          });
        }

        governedKnowledgePreparation = await prepareGovernedKnowledge({
          requestId,
          scope: projectIntegrationScope,
          task: [
            runPlan.queryRewrite?.rewrittenQuery ?? runPlan.question,
            `capability: ${runPlan.requestedCapabilityId ?? runPlan.capabilityId}`,
            ...runPlan.analysisSteps.slice(0, 12),
          ].join("\n"),
        });
        governedKnowledgeTaskCategory =
          runPlan.requestedCapabilityId ??
          runPlan.capabilityId ??
          "retail-operations";
        await writeGovernedKnowledgeEvidence({
          projectPath,
          requestId,
          preparation: governedKnowledgePreparation,
        });
        streamManager.publish(project_id, {
          type: "status",
          data: {
            status: "governed_knowledge_prepared",
            message:
              governedKnowledgePreparation.status === "prepared"
                ? `已取得 ${governedKnowledgePreparation.citationCount} 条受治理知识引用。`
                : governedKnowledgePreparation.status === "empty"
                  ? "受治理知识检索无匹配结果，继续使用真实市场数据。"
                  : governedKnowledgePreparation.status === "unavailable"
                    ? "受治理知识服务当前不可用，已按可选依赖降级。"
                    : "受治理知识集成未启用。",
            requestId,
            metadata: {
              knowledgeStatus: governedKnowledgePreparation.status,
              passageCount: governedKnowledgePreparation.passageCount,
              citationCount: governedKnowledgePreparation.citationCount,
            },
          },
        });

        missionContext = await createRetailPiAgentMission({
          projectId: project_id,
          projectPath,
          requestId,
          objective:
            runPlan.queryRewrite?.rewrittenQuery ?? planningInstruction,
          runPlan: { ...runPlan, symbols: runPlan.entities },
          maxRepairAttempts: generationState.maxRepairAttempts,
        });

        await updateRetailGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "planning",
          status: "success",
          summary: `已生成 ${runPlan.capabilityId} 执行计划。`,
          metadata: {
            capabilityId: runPlan.capabilityId,
            entities: runPlan.entities,
            expectedArtifacts: runPlan.expectedArtifacts,
            missionId: missionContext.id,
            generationId: missionContext.generationId,
            missionSpecSha256: missionContext.specHash,
          },
        });
        missionContext = await markRetailPiAgentMissionNode({
          mission: missionContext,
          nodeKey: "planning",
          status: "passed",
        });
        await publishWorkspaceProgress({
          stage: 2,
          runPlan,
          skillIds: Array.from(
            new Set([
              "commerce-data-registry",
              ...getRetailCapability(
                runPlan.requestedCapabilityId ?? runPlan.capabilityId,
              ).requiredSkills.filter(
                (skillId) =>
                  skillId !== "run-planner" &&
                  skillId !== "dashboard-visualization" &&
                  (skillId !== "image-extraction" || processedImageCount > 0),
              ),
            ]),
          ),
        });
        dataRegistryToolCallId = await publishRetailPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "commerce-data-registry",
          target: "本地数据窗口与实体解析",
          summary: "正在核验本地数据覆盖、标的解析和可用信源。",
          input: {
            question: runPlan.question,
            templateId: runPlan.visualization?.templateId,
          },
        });
        marketDataToolCallId = await publishRetailPipelineToolStart({
          projectId: project_id,
          requestId,
          conversationId,
          cliSource: cliPreference,
          toolName: "commerce-market-data",
          target: "data_file/final/dashboard-data.json",
          summary: "正在获取真实行为流、类目/商品数据与经营口径。",
          input: {
            entities: runPlan.entities,
            timeRange: runPlan.timeRange,
          },
        });
        await updateRetailGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: "running",
          summary: "开始预取真实数据。",
        });
        missionContext = await markRetailPiAgentMissionNode({
          mission: missionContext,
          nodeKey: "data_prefetch",
          status: "running",
        });
        const prefetch = await prefetchRetailDataForRunPlan({
          projectPath,
          plan: runPlan,
        });
        if (quotaActorUserId && !prefetch.skipped) {
          const dataUnits = Math.max(1, prefetch.rawFiles?.length ?? 0);
          await recordQuotaUsage({
            actorUserId: quotaActorUserId,
            projectId: project_id,
            metric: "commerce.data_units.daily",
            quantity: dataUnits,
            idempotencyKey: `chat-data-prefetch:${quotaActorUserId}:${requestId}`,
            sourceType: "commerce_data_prefetch",
            sourceId: requestId,
            metadata: {
              datasetCount: prefetch.datasetKeys?.length ?? 0,
              rawFileCount: prefetch.rawFiles?.length ?? 0,
            },
          }).catch((error) => {
            console.error(
              "[Quota] Failed to record commerce data-prefetch usage:",
              error,
            );
          });
        }
        const missingPreparedArtifacts =
          await missingAgentInputArtifacts(projectPath);
        if (
          processedImageCount === 0 &&
          (missingPreparedArtifacts.length > 0 ||
            (isInitialPrompt && prefetch.skipped))
        ) {
          const resolverUnavailable = runPlan.queryRewrite?.issues.find(
            (issue) => issue.code === "ENTITY_RESOLVER_UNAVAILABLE",
          );
          if (resolverUnavailable) {
            throw new RetailPreparationError(
              "ENTITY_RESOLVER_UNAVAILABLE",
              `类目/商品实体解析服务暂不可用，平台已停止后续取数：${resolverUnavailable.message}`,
              true,
            );
          }
          throw new RetailPreparationError(
            "RETAIL_DATA_PREPARATION_FAILED",
            `平台数据准备未完成，拒绝启动只具备 UI 创作权限的 PI Agent。${
              missingPreparedArtifacts.length
                ? ` 缺少：${missingPreparedArtifacts.join("、")}。`
                : ""
            } ${prefetch.summary}`.trim(),
            false,
          );
        }
        usePrefetchedSelectionDashboard = canUsePrefetchedDashboard({
          instruction: effectiveInstruction,
          runPlan,
          prefetchSkipped: prefetch.skipped ?? false,
        });
        await updateRetailGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: prefetch.skipped ? "skipped" : "success",
          summary: prefetch.summary ?? '',
          metadata: {
            skipped: prefetch.skipped ?? false,
            entities: prefetch.skipped ? undefined : prefetch.datasetKeys,
            finalDataPath: prefetch.skipped ? undefined : prefetch.finalDataPath,
            rawFiles: prefetch.skipped ? undefined : prefetch.rawFiles,
            deterministicDashboard: usePrefetchedSelectionDashboard || false,
          },
        });
        missionContext = await markRetailPiAgentMissionNode({
          mission: missionContext,
          nodeKey: "data_prefetch",
          status: prefetch.skipped ? "skipped" : "passed",
        });
        missionContext = await markRetailPiAgentMissionNode({
          mission: missionContext,
          nodeKey: "workspace_generation",
          status: "running",
        });
        if (prefetch.skipped) {
          await publishRetailPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "commerce-data-registry",
            toolCallId: dataRegistryToolCallId,
            target: "本地数据预取",
            summary: prefetch.summary ?? '', 
            output: {
              skipped: true,
              reason: prefetch.summary,
            },
          });
          dataRegistryToolCallId = undefined;
          await publishRetailPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "commerce-market-data",
            toolCallId: marketDataToolCallId,
            target: "data_file/final/dashboard-data.json",
            summary: `本阶段未重复取数：${prefetch.summary}`,
            resultStatus: "skipped",
            output: {
              skipped: true,
              reason: prefetch.summary,
            },
          });
          marketDataToolCallId = undefined;
          await publishWorkspaceProgress({
            stage: 3,
            runPlan,
            skillIds: answerOnlyIntent ? ["data-quality"] : ["dashboard-visualization"],
          });
        } else {
          const entities = runPlan.entities;
          const usedDatasetKeys = prefetch.datasetKeys ?? [];
          await publishRetailPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "commerce-data-registry",
            toolCallId: dataRegistryToolCallId,
            target: "/api/v1/commerce/meta",
            summary: entities.length
              ? `解析并确认类目/商品实体：${entities.join("、")}。`
              : "按全库口径完成实体解析与数据能力检查。",
            input: {
              question: runPlan.question,
              templateId: runPlan.visualization?.templateId,
            },
            output: {
              entities,
              datasetKeys: usedDatasetKeys,
              rawFiles: prefetch.rawFiles,
            },
          });
          dataRegistryToolCallId = undefined;
          await publishRetailPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "commerce-market-data",
            toolCallId: marketDataToolCallId,
            target: "data_file/final/dashboard-data.json",
            summary: prefetch.summary ?? '',
            input: {
              endpoints: [
                "/api/v1/commerce/funnel",
                "/api/v1/commerce/categories/top",
                "/api/v1/commerce/inventory-risk",
                "/api/v1/commerce/summary",
              ],
              entities,
            },
            output: {
              finalDataPath: prefetch.finalDataPath,
              rawFiles: prefetch.rawFiles,
            },
          });
          marketDataToolCallId = undefined;
          await publishWorkspaceProgress({
            stage: 3,
            runPlan,
            skillIds: answerOnlyIntent ? ["data-quality"] : ["dashboard-visualization"],
          });
          if (usePrefetchedSelectionDashboard) {
            dashboardVisualizationToolCallId =
              await publishRetailPipelineToolStart({
                projectId: project_id,
                requestId,
                conversationId,
                cliSource: cliPreference,
                toolName: "dashboard-visualization",
                target: "app/page.tsx",
                summary: "正在基于本地零售数据生成标准看板工作区。",
                input: {
                  templateId: runPlan.visualization?.templateId,
                  variantId: runPlan.visualization?.variantId,
                  entities,
                },
              });
          }
          if (!answerOnlyIntent) {
            await ensureRetailDashboardTemplateForAct(projectPath);
          }
          if (usePrefetchedSelectionDashboard) {
            await publishRetailPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "dashboard-visualization",
              toolCallId: dashboardVisualizationToolCallId,
              target: "app/page.tsx",
              summary:
                "平台已基于本地零售数据生成标准看板，后续直接进入自动验证。",
              input: {
                templateId: runPlan.visualization?.templateId,
                variantId: runPlan.visualization?.variantId,
                entities,
              },
              output: {
                finalDataPath: prefetch.finalDataPath,
                deterministicDashboard: true,
              },
            });
            dashboardVisualizationToolCallId = undefined;
          }
        }
        if (!prefetch.skipped) {
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "retail_data_prefetched",
              message: prefetch.summary,
              requestId,
              metadata: {
                entities: runPlan.entities,
                finalDataPath: prefetch.finalDataPath,
                rawFiles: prefetch.rawFiles,
              },
            },
          });
        }
      } catch (error) {
        if (queryRewriteQuotaReservationId) {
          await releaseQuotaReservation({
            reservationId: queryRewriteQuotaReservationId,
          }).catch((releaseError) => {
            console.error(
              "[Quota] Failed to release Query Rewrite reservation:",
              releaseError,
            );
          });
          queryRewriteQuotaReservationId = null;
        }
        console.error(
          "[API] Failed to prepare Shop Gate run plan or data prefetch:",
          error,
        );
        const preparationMessage =
          error instanceof Error ? error.message : String(error);
        const typedPreparationError =
          error instanceof RetailPreparationError ? error : null;
        const pendingToolFailures = [
          queryRewriteToolCallId
            ? {
                toolName: "query-rewrite",
                toolCallId: queryRewriteToolCallId,
                target: ".data-agent/retail-query-rewrite.json",
              }
            : null,
          runPlannerToolCallId
            ? {
                toolName: "run-planner",
                toolCallId: runPlannerToolCallId,
                target: ".data-agent/retail-run-plan.json",
              }
            : null,
          dataRegistryToolCallId
            ? {
                toolName: "commerce-data-registry",
                toolCallId: dataRegistryToolCallId,
                target: "本地数据窗口与实体解析",
              }
            : null,
          marketDataToolCallId
            ? {
                toolName: "commerce-market-data",
                toolCallId: marketDataToolCallId,
                target: "data_file/final/dashboard-data.json",
              }
            : null,
          dashboardVisualizationToolCallId
            ? {
                toolName: "dashboard-visualization",
                toolCallId: dashboardVisualizationToolCallId,
                target: "app/page.tsx",
              }
            : null,
        ].filter((value): value is NonNullable<typeof value> => value !== null);
        await Promise.all(
          pendingToolFailures.map((pending) =>
            publishRetailPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              ...pending,
              summary: `本阶段未完成：${preparationMessage}`,
              success: false,
              resultStatus: "failed",
              output: { error: preparationMessage },
            }).catch((projectionError) => {
              console.error(
                `[API] Failed to settle ${pending.toolName} projection:`,
                projectionError,
              );
            }),
          ),
        );
        const missionProjectBusy =
          error instanceof PiAgentMissionStateError &&
          error.code === "MISSION_PROJECT_BUSY";
        if (missionContext) {
          await failPiAgentMission({
            missionId: missionContext.id,
            projectId: missionContext.projectId,
            requestId: missionContext.requestId,
            code: "MISSION_PREPARATION_FAILED",
            message: preparationMessage,
          });
        }
        await updateRetailGenerationStep({
          projectPath,
          projectId: project_id,
          requestId,
          stepId: "data_prefetch",
          status: "failed",
          summary: "生成计划或数据预取失败。",
          runStatus: "failed",
          errorMessage: preparationMessage,
        });
        await markUserRequestAsFailed(
          project_id,
          requestId,
          preparationMessage,
        );
        await publishWorkspaceProgress({
          stage: 5,
          failureReason: preparationMessage,
        });
        streamManager.publish(project_id, {
          type: "status",
          data: {
            status: "retail_data_preparation_failed",
            message: preparationMessage,
            requestId,
            metadata: {
              terminalFailure: true,
              errorCode: missionProjectBusy
                ? "MISSION_PROJECT_BUSY"
                : (typedPreparationError?.code ??
                  "RETAIL_DATA_PREPARATION_FAILED"),
              retryable: typedPreparationError?.retryable ?? false,
              agentExecutionSkipped: true,
            },
          },
        });
        return NextResponse.json(
          {
            success: false,
            error: missionProjectBusy
              ? "MISSION_PROJECT_BUSY"
              : (typedPreparationError?.code ??
                "RETAIL_DATA_PREPARATION_FAILED"),
            message: preparationMessage,
            retryable: typedPreparationError?.retryable ?? false,
            requestId,
          },
          { status: missionProjectBusy ? 409 : 503 },
        );
      }
      return null;
    },
  });
  if (clarificationResponse) {
    return {
      response: clarificationResponse,
      missionContext,
      usePrefetchedSelectionDashboard,
      governedKnowledgePreparation,
      governedKnowledgeTaskCategory,
    };
  }

  return {
    response: clarificationResponse,
    missionContext,
    usePrefetchedSelectionDashboard,
    governedKnowledgePreparation,
    governedKnowledgeTaskCategory,
  };
}
