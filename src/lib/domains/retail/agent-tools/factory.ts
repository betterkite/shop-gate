import type { PiAgentTool } from '@/lib/agent/types';
import {
  createPiAgentTools,
  type CreatePiAgentToolsOptions,
  type PiAgentToolProfile,
} from '@/lib/agent/tools';
import { createInspectDashboardContractTool } from './dashboard-contract';
import {
  createApplyDashboardSpecTool,
} from './dashboard-spec';
import {
  createImageExtractionTool,
  type PiAgentImageExtractionToolOptions,
} from './image-extraction';
import {
  createCommerceApiGetTool,
  type PiAgentRetailApiToolOptions,
} from './commerce-api';
import { retailContextReceiptProjector } from './context-receipts';
import { RETAIL_JSON_ARTIFACT_CONFIGURATION } from './structured-read';

export const RETAIL_PREPARED_SOURCE_WRITE_GLOBS = [
  'app/page.tsx',
  'app/globals.css',
] as const;

export interface CreateRetailPiAgentToolsOptions
  extends Omit<
    CreatePiAgentToolsOptions,
    'preparedCompilerTool' | 'inspectionTools' | 'trustedAdditionalTools' | 'trustedTrailingTools'
  > {
  profile?: PiAgentToolProfile;
  commerceApi?: PiAgentRetailApiToolOptions;
  includeCommerceApi?: boolean;
  includeDashboardSpec?: boolean;
  includeDashboardInspector?: boolean;
  imageExtraction?: Omit<PiAgentImageExtractionToolOptions, 'workspaceRoot'>;
  includeImageExtraction?: boolean;
}

/** Retail Domain Pack adapter over the product-neutral PI Agent Tool factory. */
export function createRetailPiAgentTools(
  options: CreateRetailPiAgentToolsOptions,
): PiAgentTool[] {
  const allowedWriteGlobs = [
    ...(options.profileAllowedWriteGlobs ?? []),
    ...(options.allowedWriteGlobs ?? []),
  ];
  if (
    options.preparedSurface &&
    (options.includeCommerceApi !== false ||
      options.includeImageExtraction !== false ||
      (options.additionalTools?.length ?? 0) > 0)
  ) {
    throw new Error(
      'Retail prepared surfaces require commerce API, image extraction, and plugin tools to be disabled.',
    );
  }
  if (
    options.preparedSurface &&
    allowedWriteGlobs.some((glob) =>
      !RETAIL_PREPARED_SOURCE_WRITE_GLOBS.includes(
        glob as (typeof RETAIL_PREPARED_SOURCE_WRITE_GLOBS)[number],
      ))
  ) {
    throw new Error('Retail prepared surfaces reject writes outside the certified app source scope.');
  }
  const workspaceOptions = {
    ...options,
    allowedWriteGlobs,
  };
  const preparedCompilerTool = options.includeDashboardSpec
    ? createApplyDashboardSpecTool(workspaceOptions)
    : null;
  const inspectionTools = options.includeDashboardInspector === false
    ? []
    : [createInspectDashboardContractTool(options)];
  const trustedAdditionalTools: PiAgentTool[] = options.includeCommerceApi === false ? [] : [
    createCommerceApiGetTool({
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.commerceApi,
    }),
  ];
  const trustedTrailingTools: PiAgentTool[] = options.includeImageExtraction === false ? [] : [
    createImageExtractionTool({
      workspaceRoot: options.workspaceRoot,
      timeoutMs: options.timeoutMs,
      maxOutputChars: options.maxOutputChars,
      ...options.imageExtraction,
    }),
  ];
  return createPiAgentTools({
    ...options,
    jsonArtifacts: RETAIL_JSON_ARTIFACT_CONFIGURATION,
    preparedCompilerTool,
    inspectionTools: options.preparedSurface ? [] : inspectionTools,
    trustedAdditionalTools: options.preparedSurface ? [] : trustedAdditionalTools,
    trustedTrailingTools: options.preparedSurface ? [] : trustedTrailingTools,
    contextReceiptProjector: retailContextReceiptProjector,
  });
}
