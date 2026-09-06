import type {
  DataAgentExecutionPlan,
  DataAgentProfileSelection,
  DataAgentTask,
} from '@/lib/data-agent';
import { DATA_AGENT_TASK_RELATIVE_PATH } from '@/lib/data-agent';
import {
  createRetailDataAgentRegistry,
  RETAIL_AGENT_PROFILE,
} from './agent-profile';
import { RETAIL_RUN_PLAN_RELATIVE_PATH } from './workspace-artifacts';
import type { RetailQueryRewriteResult } from './query-rewrite';
import type { RetailRunPlan } from './workspace';

/** Projects the Retail Domain contract into the provider-neutral Data Agent task. */
export function projectRetailRewriteToDataAgentTask(
  rewrite: RetailQueryRewriteResult,
): DataAgentTask {
  return {
    schemaVersion: 1,
    originalQuery: rewrite.originalQuery,
    objective: rewrite.rewrittenQuery,
    entities: rewrite.targetCandidates.map((text) => ({ text, evidence: text })),
    resolvedEntities: rewrite.resolvedEntities.map((entity) => ({
      mention: entity.query,
      entityType: entity.kind === 'item' ? 'retail.item' : 'retail.category',
      canonicalId: entity.kind === 'item' ? `item:${entity.id}` : `cat:${entity.id}`,
      displayName: entity.name,
      attributes: {
        kind: entity.kind,
        id: entity.id,
        ...(entity.syntheticFields.length > 0
          ? { synthetic_fields: entity.syntheticFields.join(',') }
          : {}),
      },
      resolverId: 'retail.entity-resolver',
      confidence: entity.confidence,
    })),
    metrics: [{ id: rewrite.analysisFocus.id, name: rewrite.analysisFocus.label }],
    dimensions: [],
    filters: [],
    timeRange: rewrite.timeRange
      ? { label: rewrite.timeRange.label, granularity: rewrite.timeRange.unit }
      : null,
    output: rewrite.outputIntent,
    domainHints: ['retail.core', rewrite.capabilityHint],
    status: rewrite.status,
    issues: rewrite.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      retryable: issue.retryable,
    })),
    extensions: {
      retail: {
        wholeCatalog: rewrite.broadUniverse,
        safety: rewrite.safety,
        execution: rewrite.execution,
      },
    },
  };
}

export function projectRetailPlanToDataAgentPlan(plan: RetailRunPlan): DataAgentExecutionPlan {
  const composition = createRetailDataAgentRegistry().resolveCapability(
    RETAIL_AGENT_PROFILE.id,
    plan.requestedCapabilityId ?? plan.capabilityId,
  ).composition;
  return {
    schemaVersion: 1,
    runId: plan.runId,
    status: plan.status === 'planned'
      ? 'planned'
      : plan.status === 'refused'
        ? 'refused'
        : 'needs_clarification',
    profile: {
      id: composition.profile.id,
      version: composition.profile.version,
      domainPacks: composition.domainPacks,
      deliveryPack: composition.deliveryPack,
      compositionSha256: composition.sha256,
    },
    capabilityId: plan.requestedCapabilityId ?? plan.capabilityId,
    taskArtifact: DATA_AGENT_TASK_RELATIVE_PATH,
    domainPlanArtifact: RETAIL_RUN_PLAN_RELATIVE_PATH,
    expectedArtifacts: [...plan.expectedArtifacts],
    validationRuleIds: plan.validationRules.map((_rule, index) =>
      `retail.rule.${String(index + 1).padStart(3, '0')}`),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function projectRetailProfileSelection(
  capabilityId: string,
  updatedAt: string,
  selectionSource: DataAgentProfileSelection['selectionSource'] = 'inferred',
): DataAgentProfileSelection {
  const composition = createRetailDataAgentRegistry().resolveCapability(
    RETAIL_AGENT_PROFILE.id,
    capabilityId,
  ).composition;
  return {
    schemaVersion: 1,
    profile: { ...RETAIL_AGENT_PROFILE },
    selectedCapabilityId: capabilityId,
    composition,
    selectionSource,
    updatedAt,
  };
}
