import fs from 'node:fs/promises';

import type { PiAgentTool } from '@/lib/agent/types';
import { assessRetailDatasetIdentity } from '../data-identity';
import {
  retailBaseDashboardCssTemplate,
  retailBaseDashboardPageTemplate,
} from '@/lib/utils/retail-scaffold-templates';
import {
  retailCatalogPageTemplate,
  retailDailyBriefPageTemplate,
  retailFunnelPageTemplate,
  retailPriceInventoryPageTemplate,
} from '@/lib/utils/retail-scaffold-templates';

import { PiAgentToolError, throwIfAborted } from '@/lib/agent/tools/errors';
import type { PiAgentFileToolOptions } from '@/lib/agent/tools/filesystem';
import { writePiAgentWorkspaceBatch } from '@/lib/agent/tools/filesystem';
import { inputRecord, optionalString } from '@/lib/agent/tools/input';
import { PiAgentWorkspacePolicy } from '@/lib/agent/tools/path-policy';
import { DEFAULT_TOOL_TIMEOUT_MS, executePiAgentTool } from '@/lib/agent/tools/runtime';

const RUN_PLAN_PATH = '.data-agent/retail-run-plan.json';
const FINAL_DATA_PATH = 'data_file/final/dashboard-data.json';
const PAGE_PATH = 'app/page.tsx';
const STYLES_PATH = 'app/globals.css';
const MAX_CONTRACT_BYTES = 2_000_000;
const DEFAULT_MAX_GENERATED_FILE_BYTES = 256_000;
const DEFAULT_MAX_GENERATED_TOTAL_BYTES = 512_000;

type JsonRecord = Record<string, unknown>;
type DashboardRenderer =
  | 'base'
  | 'funnel-analysis'
  | 'catalog-structure'
  | 'price-inventory'
  | 'daily-brief';

interface DashboardDataPrerequisite {
  id: string;
  description: string;
  satisfiedBy: (finalData: JsonRecord) => boolean;
}

interface SupportedDashboardCapability {
  supported: true;
  templateId: string;
  variantId: string;
  renderer: DashboardRenderer;
  requiredComponents: readonly string[];
  dataPrerequisites: readonly DashboardDataPrerequisite[];
}

interface UnsupportedDashboardCapability {
  supported: false;
  templateId: string;
  variantId: string;
  reason: string;
}

type DashboardCapability = SupportedDashboardCapability | UnsupportedDashboardCapability;

export interface ApplyDashboardSpecInput {
  /** 仅断言；权威值始终来自 run_plan / 最终数据。 */
  templateId?: string;
  /** 仅断言；权威值始终来自 run_plan / 最终数据。 */
  variantId?: string;
}

export interface CompiledDashboardSpec {
  schemaVersion: 1;
  templateId: string;
  variantId: string | null;
  renderer: DashboardRenderer;
  requiredComponents: string[];
  dataPrerequisites: string[];
  dataArtifact: typeof FINAL_DATA_PATH;
  outputArtifacts: [typeof PAGE_PATH, typeof STYLES_PATH];
}

export interface ApplyDashboardSpecOutput {
  spec: CompiledDashboardSpec;
  files: Array<{
    path: string;
    bytes: number;
    created: boolean;
    beforeSha256: string | null;
    afterSha256: string;
  }>;
  totalBytes: number;
}

export interface DashboardSpecReadinessAssessment {
  ready: boolean;
  errorCode: string | null;
  reasons: string[];
  spec: CompiledDashboardSpec | null;
}

export interface PiAgentDashboardSpecToolOptions extends Pick<
  PiAgentFileToolOptions,
  | 'workspaceRoot'
  | 'allowedWriteGlobs'
  | 'includeDefaultWriteGlobs'
  | 'timeoutMs'
  | 'maxWriteBytes'
  | 'resourceLockWaitTimeoutMs'
> {
  maxGeneratedTotalBytes?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : null;
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  return isRecord(record[key]) ? record[key] : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function datasetRecord(finalData: JsonRecord, key: string): JsonRecord | null {
  const datasets = nestedRecord(finalData, 'datasets');
  return datasets ? nestedRecord(datasets, key) : null;
}

function datasetRows(finalData: JsonRecord, key: string): JsonRecord[] {
  const dataset = datasetRecord(finalData, key);
  return Array.isArray(dataset?.rows) ? dataset.rows.filter(isRecord) : [];
}

function windowIsoDate(value: unknown): string | null {
  return contractString(value) && /^\d{4}-\d{2}-\d{2}$/.test(String(value).trim())
    ? String(value).trim()
    : null;
}

function finalDataWindow(finalData: JsonRecord): { start: string; end: string } | null {
  const window = nestedRecord(finalData, 'window');
  const start = windowIsoDate(window?.start);
  const end = windowIsoDate(window?.end);
  return start && end ? { start, end } : null;
}

function hasPlannedEntities(finalData: JsonRecord): boolean {
  const entities = nestedRecord(finalData, 'plannedEntities');
  if (!entities) return false;
  const categoryIds = entities.categoryIds;
  const itemIds = entities.itemIds;
  return Array.isArray(categoryIds) && Array.isArray(itemIds);
}

function funnelStagesReady(finalData: JsonRecord): boolean {
  const stages = recordArray(nestedRecord(datasetRecord(finalData, 'funnel') ?? {}, 'stages'));
  const order = ['pv', 'fav', 'cart', 'buy'];
  if (stages.length !== order.length) return false;
  return stages.every((stage, index) => {
    if (contractString(stage.stage) !== order[index]) return false;
    return finiteNumber(stage.events) !== null;
  });
}

function funnelDailyReady(finalData: JsonRecord): boolean {
  const rows = datasetRows(finalData, 'funnelDaily');
  return rows.length >= 2 && rows.every((row) => windowIsoDate(row.stat_date) !== null);
}

function categoriesReady(finalData: JsonRecord): boolean {
  const rows = datasetRows(finalData, 'categories');
  return rows.length >= 1 && rows.every((row) => (
    finiteNumber(row.gmv) !== null &&
    finiteNumber(row.pv) !== null &&
    finiteNumber(row.buy) !== null
  ));
}

function inventoryRiskReady(finalData: JsonRecord): boolean {
  const items = recordArray(nestedRecord(datasetRecord(finalData, 'inventoryRisk') ?? {}, 'items'));
  return items.length >= 1 && items.every((item) => (
    finiteNumber(item.price) !== null &&
    finiteNumber(item.stock) !== null &&
    finiteNumber(item.sell_through_ratio) !== null
  ));
}

function dailySummaryReady(finalData: JsonRecord): boolean {
  const summary = datasetRecord(finalData, 'summary');
  if (!summary) return false;
  const status = contractString(summary.status);
  const totals = nestedRecord(summary, 'totals');
  if (status === 'no_data') return false;
  return Boolean(
    totals &&
    finiteNumber(totals.gmv) !== null &&
    finiteNumber(totals.pv) !== null
  );
}

/**
 * 零售四个 v1 能力的渲染合同。renderer 与
 * `src/lib/utils/retail-scaffold-templates.ts` 的页面模板一一对应。
 */
const SUPPORTED_RETAIL_RENDERERS: ReadonlyArray<{
  capabilityId: string;
  renderer: DashboardRenderer;
  templateId: string;
  requiredComponents: readonly string[];
  dataPrerequisites: readonly DashboardDataPrerequisite[];
}> = [
  {
    capabilityId: 'traffic_funnel',
    renderer: 'funnel-analysis',
    templateId: 'funnel-analysis',
    requiredComponents: ['漏斗事件总览', '分日转化趋势', '分类目对比表', '数据质量说明'],
    dataPrerequisites: [
      { id: 'planned_entities', description: 'plannedEntities 声明完整', satisfiedBy: hasPlannedEntities },
      { id: 'funnel_stages', description: 'funnel 四阶段事件计数', satisfiedBy: funnelStagesReady },
      { id: 'funnel_daily', description: '分日趋势至少两日', satisfiedBy: funnelDailyReady },
    ],
  },
  {
    capabilityId: 'catalog_structure',
    renderer: 'catalog-structure',
    templateId: 'catalog-structure',
    requiredComponents: ['类目GMV排名', '集中度口径', '类目指标矩阵', '数据质量说明'],
    dataPrerequisites: [
      { id: 'planned_entities', description: 'plannedEntities 声明完整', satisfiedBy: hasPlannedEntities },
      { id: 'categories_rows', description: '类目行含 gmv/pv/buy', satisfiedBy: categoriesReady },
    ],
  },
  {
    capabilityId: 'price_inventory',
    renderer: 'price-inventory',
    templateId: 'price-inventory',
    requiredComponents: ['价格带分布', '库销比排行', '滞销清单说明', '合成口径标注'],
    dataPrerequisites: [
      { id: 'planned_entities', description: 'plannedEntities 声明完整', satisfiedBy: hasPlannedEntities },
      { id: 'inventory_items', description: '库存行含 price/stock/库销比', satisfiedBy: inventoryRiskReady },
    ],
  },
  {
    capabilityId: 'daily_brief',
    renderer: 'daily-brief',
    templateId: 'daily-brief',
    requiredComponents: ['当日总量摘要', '环比表', '类目异动榜', '数据质量说明'],
    dataPrerequisites: [
      { id: 'planned_entities', description: 'plannedEntities 声明完整', satisfiedBy: hasPlannedEntities },
      { id: 'daily_summary', description: 'summary 快照与环比可用', satisfiedBy: dailySummaryReady },
    ],
  },
];

function rendererTemplates(renderer: DashboardRenderer): { page: string; css: string } {
  const css = retailBaseDashboardCssTemplate();
  switch (renderer) {
    case 'funnel-analysis':
      return { page: retailFunnelPageTemplate(), css };
    case 'catalog-structure':
      return { page: retailCatalogPageTemplate(), css };
    case 'price-inventory':
      return { page: retailPriceInventoryPageTemplate(), css };
    case 'daily-brief':
      return { page: retailDailyBriefPageTemplate(), css };
    case 'base':
    default:
      return { page: retailBaseDashboardPageTemplate(), css };
  }
}

function resolveRetailDashboardCapability(params: {
  capabilityId: string;
  finalData: JsonRecord;
}): DashboardCapability {
  const rendererEntry = SUPPORTED_RETAIL_RENDERERS.find(
    (entry) => entry.capabilityId === params.capabilityId,
  );
  if (!rendererEntry) {
    return {
      supported: false,
      templateId: 'retail-base',
      variantId: 'base',
      reason: `能力 ${params.capabilityId} 没有已注册的零售渲染模板。`,
    };
  }
  const identity = assessRetailDatasetIdentity(
    {
      runId: contractString(params.finalData.runId),
      window: params.finalData.window,
      plannedEntities: params.finalData.plannedEntities,
    },
    params.finalData,
  );
  const unmet = rendererEntry.dataPrerequisites.filter(
    (prerequisite) => !prerequisite.satisfiedBy(params.finalData),
  );
  if (!identity.ready || unmet.length > 0) {
    return {
      supported: false,
      templateId: rendererEntry.templateId,
      variantId: 'base',
      reason: [
        ...identity.reasons.map((reason) => `final_data_identity: ${reason}`),
        ...unmet.map((prerequisite) => `${prerequisite.id}: ${prerequisite.description}`),
      ].join('; '),
    };
  }
  return {
    supported: true,
    templateId: rendererEntry.templateId,
    variantId: 'base',
    renderer: rendererEntry.renderer,
    requiredComponents: rendererEntry.requiredComponents,
    dataPrerequisites: rendererEntry.dataPrerequisites,
  };
}

function parseApplyInput(value: unknown): ApplyDashboardSpecInput {
  const record = inputRecord(value);
  const templateId = record.templateId === undefined
    ? undefined
    : optionalString(record, 'templateId', '', { maxLength: 160 });
  const variantId = record.variantId === undefined
    ? undefined
    : optionalString(record, 'variantId', '', { maxLength: 160 });
  return {
    ...(templateId ? { templateId } : {}),
    ...(variantId ? { variantId } : {}),
  };
}

function readCompiledSpec(value: string, label: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) {
      throw new PiAgentToolError('DASHBOARD_SPEC_CONTRACT_INVALID', `${label} 不是 JSON 对象。`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof PiAgentToolError) throw error;
    throw new PiAgentToolError('DASHBOARD_SPEC_CONTRACT_INVALID', `${label} 不是合法 JSON。`);
  }
}

export function assessRetailDashboardSpecReadiness(params: {
  workspacePolicy: PiAgentWorkspacePolicy;
  capabilityId: string;
}): Promise<DashboardSpecReadinessAssessment> {
  return (async () => {
    const reasons: string[] = [];
    let runPlanRecord: JsonRecord | null = null;
    let finalDataRecord: JsonRecord | null = null;
    try {
      const runPlan = await params.workspacePolicy.resolveReadPath(RUN_PLAN_PATH);
      const runPlanContent = await fs.readFile(runPlan.canonicalPath, 'utf8');
      runPlanRecord = readCompiledSpec(runPlanContent, RUN_PLAN_PATH);
    } catch (error) {
      reasons.push(`run_plan_missing: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      const finalData = await params.workspacePolicy.resolveReadPath(FINAL_DATA_PATH);
      const finalDataContent = await fs.readFile(finalData.canonicalPath, 'utf8');
      finalDataRecord = readCompiledSpec(finalDataContent, FINAL_DATA_PATH);
    } catch (error) {
      reasons.push(`final_data_missing: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!runPlanRecord || !finalDataRecord) {
      return {
        ready: false,
        errorCode: 'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
        reasons,
        spec: null,
      };
    }
    const requestedCapabilityId =
      contractString(runPlanRecord.requestedCapabilityId) ??
      contractString(runPlanRecord.capabilityId) ??
      params.capabilityId;
    const capability = resolveRetailDashboardCapability({
      capabilityId: requestedCapabilityId,
      finalData: finalDataRecord,
    });
    if (!capability.supported) {
      return {
        ready: false,
        errorCode: 'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
        reasons: [capability.reason],
        spec: null,
      };
    }
    return {
      ready: true,
      errorCode: null,
      reasons: [],
      spec: {
        schemaVersion: 1,
        templateId: capability.templateId,
        variantId: capability.variantId,
        renderer: capability.renderer,
        requiredComponents: [...capability.requiredComponents],
        dataPrerequisites: capability.dataPrerequisites.map((prerequisite) => prerequisite.id),
        dataArtifact: FINAL_DATA_PATH,
        outputArtifacts: [PAGE_PATH, STYLES_PATH],
      },
    };
  })();
}

export function createApplyDashboardSpecTool(
  options: PiAgentDashboardSpecToolOptions,
): PiAgentTool<ApplyDashboardSpecInput, ApplyDashboardSpecOutput> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  let policyPromise: Promise<PiAgentWorkspacePolicy> | undefined;
  const policy = () =>
    (policyPromise ??= PiAgentWorkspacePolicy.create({
      workspaceRoot: options.workspaceRoot,
      allowedWriteGlobs: options.allowedWriteGlobs,
      includeDefaultWriteGlobs: options.includeDefaultWriteGlobs,
    }));
  const maxGeneratedFileBytes = options.maxWriteBytes ?? DEFAULT_MAX_GENERATED_FILE_BYTES;
  const maxGeneratedTotalBytes =
    options.maxGeneratedTotalBytes ?? DEFAULT_MAX_GENERATED_TOTAL_BYTES;

  return {
    name: 'apply_dashboard_spec',
    description:
      'Compile the authoritative retail dashboard template (from run plan + final data identity) and write app/page.tsx + app/globals.css. The template choice comes from the run plan capability; templateId/variantId arguments are assertions only.',
    effect: 'workspace_write',
    idempotency: 'intrinsic',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: { type: 'string', maxLength: 160 },
        variantId: { type: 'string', maxLength: 160 },
      },
      additionalProperties: false,
    },
    parseInput: parseApplyInput,
    execute: (input, context) =>
      executePiAgentTool(context.signal, timeoutMs, async (signal) => {
        throwIfAborted(signal);
        const workspacePolicy = await policy();
        const capabilityId =
          input.templateId ??
          (await (async () => {
            const runPlanPath = await workspacePolicy.resolveReadPath(RUN_PLAN_PATH);
            const runPlanContent = await fs.readFile(runPlanPath.canonicalPath, 'utf8');
            const runPlan = readCompiledSpec(runPlanContent, RUN_PLAN_PATH);
            return contractString(runPlan.requestedCapabilityId) ??
              contractString(runPlan.capabilityId) ??
              'traffic_funnel';
          })());
        const readiness = await assessRetailDashboardSpecReadiness({
          workspacePolicy,
          capabilityId,
        });
        if (!readiness.ready || !readiness.spec) {
          throw new PiAgentToolError(
            readiness.errorCode ?? 'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
            `零售看板合同未就绪：${readiness.reasons.join('; ')}`,
          );
        }
        if (input.templateId && input.templateId !== readiness.spec.templateId) {
          throw new PiAgentToolError(
            'DASHBOARD_SPEC_TEMPLATE_MISMATCH',
            `断言 templateId=${input.templateId} 与权威值 ${readiness.spec.templateId} 不一致。`,
          );
        }
        const templates = rendererTemplates(readiness.spec.renderer);
        const pageBytes = Buffer.byteLength(templates.page, 'utf8');
        const cssBytes = Buffer.byteLength(templates.css, 'utf8');
        if (pageBytes > maxGeneratedFileBytes || cssBytes > maxGeneratedFileBytes) {
          throw new PiAgentToolError(
            'DASHBOARD_SPEC_OUTPUT_TOO_LARGE',
            `生成模板超过单文件上限 ${maxGeneratedFileBytes} 字节。`,
          );
        }
        if (pageBytes + cssBytes > maxGeneratedTotalBytes) {
          throw new PiAgentToolError(
            'DASHBOARD_SPEC_OUTPUT_TOO_LARGE',
            `生成模板超过总上限 ${maxGeneratedTotalBytes} 字节。`,
          );
        }
        const writes = await writePiAgentWorkspaceBatch({
          policy: workspacePolicy,
          files: [
            { relativePath: PAGE_PATH, content: Buffer.from(templates.page, 'utf8') },
            { relativePath: STYLES_PATH, content: Buffer.from(templates.css, 'utf8') },
          ],
          maxBytesPerFile: maxGeneratedFileBytes,
          maxTotalBytes: maxGeneratedTotalBytes,
          signal,
          resourceLockWaitTimeoutMs: options.resourceLockWaitTimeoutMs,
          lockIdentity: { runId: context.runId, operationId: context.operationId },
          commitWorkspaceMutation: context.commitWorkspaceMutation,
        });
        const data: ApplyDashboardSpecOutput = {
          spec: readiness.spec,
          files: writes.files,
          totalBytes: writes.totalBytes,
        };
        return {
          ok: true,
          data,
          content: `Compiled ${readiness.spec.templateId}/${readiness.spec.variantId} with the trusted ${readiness.spec.renderer} renderer into ${readiness.spec.outputArtifacts.join(', ')}.`,
          metadata: {
            dashboardSpecVersion: readiness.spec.schemaVersion,
            templateId: readiness.spec.templateId,
            variantId: readiness.spec.variantId,
            renderer: readiness.spec.renderer,
          },
        };
      }),
  };
}
