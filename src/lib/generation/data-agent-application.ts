import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DATA_AGENT_EVENTS_RELATIVE_PATH,
  DATA_AGENT_PROFILE_RELATIVE_PATH,
  DATA_AGENT_WORKSPACE_RELATIVE_PATH,
  DataAgentApplicationCatalog,
  type DataAgentApplicationAdapter,
  type DataAgentProfileSelection,
  type DataAgentWorkspaceDescriptor,
  writeWorkspaceFileAtomic,
  writeWorkspaceJsonAtomic,
} from '@/lib/data-agent';
import { installPiAgentSkillsForWorkspace } from '@/lib/agent/skills';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  buildRetailProjectSettings,
  getRetailCapability,
} from '@/lib/domains/retail/capabilities';
import {
  createRetailDataAgentRegistry,
  getRetailSkillCapabilityDescriptor,
  RETAIL_AGENT_PROFILE_ID,
} from '@/lib/domains/retail';
import { serializeRetailVisualizationTemplate } from '@/lib/domains/retail/visualization-templates';
import { RETAIL_RUN_PLAN_RELATIVE_PATH } from '@/lib/domains/retail/workspace-artifacts';

const retailAdapter: DataAgentApplicationAdapter = {
  profileId: RETAIL_AGENT_PROFILE_ID,
  async provisionProject(input, application) {
    const capability = getRetailCapability(application.capability.id);
    const visualizationTemplate = serializeRetailVisualizationTemplate(capability.id);
    const llm = getProjectLlmConfig(input.selectedModel);
    const now = new Date().toISOString();
    await Promise.all(application.deliveryPack.workspaceDirectories.map((directory) => (
      fs.mkdir(path.join(input.projectPath, directory), { recursive: true })
    )));
    const workspace: DataAgentWorkspaceDescriptor = {
      schemaVersion: 1,
      workspaceId: input.projectId,
      projectId: input.projectId,
      projectName: input.projectName,
      platform: 'Shop Gate',
      composition: application.composition,
      createdAt: now,
      updatedAt: now,
      runtime: {
        framework: 'PI Agent',
        executorId: input.preferredCli,
        modelId: input.selectedModel,
        modelProfileId: llm.profileId,
      },
    };
    const profileSelection: DataAgentProfileSelection = {
      schemaVersion: 1,
      profile: application.profile,
      selectedCapabilityId: capability.id,
      composition: application.composition,
      selectionSource: input.capabilitySelectionSource,
      updatedAt: now,
    };
    await Promise.all([
      writeWorkspaceJsonAtomic(
        input.projectPath,
        DATA_AGENT_WORKSPACE_RELATIVE_PATH,
        workspace,
      ),
      writeWorkspaceJsonAtomic(
        input.projectPath,
        RETAIL_RUN_PLAN_RELATIVE_PATH,
        {
          schemaVersion: 1,
          runId: null,
          status: 'pending',
          capabilityId: capability.id,
          composition: application.composition,
          llm,
          question: '',
          symbols: [],
          timeRange: null,
          dataRequirements: capability.dataEndpoints,
          analysisSteps: [],
          visualization: {
            required: false,
            templateId: visualizationTemplate.templateId,
            name: visualizationTemplate.name,
            scenario: visualizationTemplate.scenario,
            variantId: visualizationTemplate.variantId,
            variantName: visualizationTemplate.variantName,
            variantScenario: visualizationTemplate.variantScenario,
            layout: visualizationTemplate.layout,
            density: visualizationTemplate.density,
            firstViewport: visualizationTemplate.firstViewport,
            variantGuidance: visualizationTemplate.variantGuidance,
            matchReasons: visualizationTemplate.matchReasons,
            panels: visualizationTemplate.requiredComponents,
            painPoints: visualizationTemplate.painPoints,
            optionalPanels: visualizationTemplate.optionalComponents,
            dataSignals: visualizationTemplate.dataSignals,
            finalDataContract: visualizationTemplate.finalDataContract,
          },
          expectedArtifacts: capability.expectedArtifacts,
          validationRules: capability.validationRules,
          createdAt: now,
          updatedAt: now,
        },
      ),
      writeWorkspaceJsonAtomic(
        input.projectPath,
        DATA_AGENT_PROFILE_RELATIVE_PATH,
        profileSelection,
      ),
      writeWorkspaceFileAtomic(
        input.projectPath,
        DATA_AGENT_EVENTS_RELATIVE_PATH,
        '',
      ),
    ]);
    await installPiAgentSkillsForWorkspace(input.projectPath, {
      capabilityId: capability.id,
      capability: getRetailSkillCapabilityDescriptor(capability.id),
      additionalSkillIds: ['platform-ui-product-design'],
    });
    return {
      settings: {
        llm,
        retail: buildRetailProjectSettings(capability.id),
        dataAgent: {
          profileId: application.profile.id,
          profileVersion: application.profile.version,
          capabilityId: capability.id,
          compositionSha256: application.composition.sha256,
        },
      },
    };
  },
};

const applicationCatalog = new DataAgentApplicationCatalog(
  createRetailDataAgentRegistry(),
).register(retailAdapter);

export function getApplicationDataAgentCatalog(): DataAgentApplicationCatalog {
  return applicationCatalog;
}
