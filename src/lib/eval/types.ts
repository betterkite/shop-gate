import type { EvalSemanticReview, EvalStrategyCheck } from './evaluators';
import type { EvalOracleAssertion } from './oracles';
import type { EvalQualitySummary, EvalScoreDimension } from './scoring';
import type { EvalTraceDiagnostics } from './trace-diagnostics';

export type EvalCheckStatus = 'passed' | 'failed' | 'warning' | 'unknown';
export type CommerceEvalExecutionMode = 'contract' | 'e2e';
export type CommerceEvalCoverageLevel = 'routing' | 'contract' | 'live_e2e' | 'production';

export interface CommerceEvalCase {
  id: string;
  name: string;
  question: string;
  capabilityId: string;
  capabilityLabel: string;
  type: string;
  typeLabel: string;
  expectedEntities: string[];
  expectedEntityType: string | null;
  expectedTemplateId: string | null;
  expectedVariantId: string | null;
  expectedDatasets: string[];
  expectedRawFiles: string[];
  expectedFinalFields: string[];
  tags: string[];
  coverageLevel: CommerceEvalCoverageLevel;
  productionSupported: boolean;
  oracleAssertions: EvalOracleAssertion[];
  safetyTags: string[];
  hasImageAttachment: boolean;
  expectClarification: boolean;
  visualCheck: boolean;
}

export interface CommerceEvalSetDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  caseIds: string[];
  custom: boolean;
}

export interface CommerceEvalCheck {
  id: string;
  name: string;
  status: EvalCheckStatus;
  summary: string;
}

export interface CommerceEvalArtifactSummary {
  templateId: string | null;
  finalDataPath: string | null;
  rawFileCount: number;
  trendRows: number;
  profitRows: number;
  briefRows: number;
  orderRows: number;
  itemCount: number;
  inventoryItemCount: number;
  comparisonRows: number;
  qualityStatus: string | null;
  hasImageExtraction: boolean;
}

export interface CommerceEvalResult {
  id: string;
  name: string;
  question: string;
  projectId: string | null;
  projectPath: string | null;
  requestId: string | null;
  durationMs: number;
  passed: boolean;
  firstPassPassed: boolean;
  finalPassed: boolean;
  score: number;
  failures: string[];
  entities: string[];
  repairAttempts: number;
  platformRepairCount: number;
  agentExecuted: boolean;
  agentExecution: {
    executed: boolean;
    cli: string | null;
    provider: string | null;
    model: string | null;
    requestId: string | null;
    runIds: string[];
    runs: Array<{
      id: string;
      runInstanceId: string;
      requestId: string | null;
      status: string | null;
      provider: string | null;
      model: string | null;
      frameworkVersion: string | null;
      buildRevision: string | null;
      startedAt: string | null;
      completedAt: string | null;
      turns: number;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        cachedInputTokens: number;
        cacheMissInputTokens: number;
        reasoningTokens: number;
      };
      tools: {
        total: number;
        succeeded: number;
        failed: number;
        uncertain: number;
        unexpectedFailureCount: number;
        workspaceWriteSucceeded: number;
        submitResultSucceeded: number;
      };
    }>;
    missionId: string | null;
    generationId: string | null;
    missionStatus: string | null;
    candidateVersion: number;
    acceptedReceiptId: string | null;
    acceptedReceiptHash: string | null;
    acceptedReceiptType: string | null;
    acceptedReceiptVerdict: string | null;
    acceptedSourceRunId: string | null;
    acceptedSourceRequestId: string | null;
    acceptedCandidateSource: string | null;
    frameworkVersion: string | null;
    buildRevision: string | null;
    gitRevision: string | null;
    startedAt: string | null;
    completedAt: string | null;
    turns: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cachedInputTokens: number;
      cacheMissInputTokens: number;
      reasoningTokens: number;
    };
    tools: {
      total: number;
      succeeded: number;
      failed: number;
      uncertain: number;
      unexpectedFailureCount: number;
      workspaceWriteSucceeded: number;
      submitResultSucceeded: number;
    };
  } | null;
  missionAcceptance: {
    missionId: string | null;
    generationId: string | null;
    status: string | null;
    candidateVersion: number;
    acceptedReceiptId: string | null;
    acceptedReceiptHash: string | null;
    acceptedReceiptType: string | null;
    acceptedReceiptVerdict: string | null;
    acceptedSourceRunId: string | null;
    acceptedSourceRequestId: string | null;
    acceptedCandidateSource: string | null;
  } | null;
  capabilityId: string;
  capabilityLabel: string;
  type: string;
  typeLabel: string;
  tags: string[];
  validationStatus: EvalCheckStatus;
  validationChecks: CommerceEvalCheck[];
  evaluation: {
    evaluatorId: string;
    evaluatorVersion: string;
    rubricVersion: string;
    hardGatePassed: boolean;
    passed: boolean;
    score: number;
    checks: EvalStrategyCheck[];
    dimensions: EvalScoreDimension[];
    semanticReview: EvalSemanticReview | null;
  } | null;
  stability: {
    passed: boolean;
    repeatCount: number;
    passedAttempts: number;
    passRate: number;
    flaky: boolean;
    attempts: Array<{
      attempt: number;
      passed: boolean;
      firstPassPassed: boolean;
      score: number;
      durationMs: number;
      repairAttempts: number;
      projectId: string | null;
      projectPath: string | null;
      requestId: string | null;
      failures: string[];
      agentAttested: boolean | null;
    }>;
  } | null;
  eventAudit: {
    total: number;
    warningCount: number;
    errorCount: number;
    eventTypes: string[];
    stages: string[];
  } | null;
  traceDiagnostics: EvalTraceDiagnostics | null;
  artifacts: CommerceEvalArtifactSummary;
  visualCheck: {
    passed: boolean;
    screenshotPath: string | null;
    screenshots: Array<{
      viewport: string;
      path: string;
      width: number;
      height: number;
    }>;
    accessibilityIssueCount: number;
    failures: string[];
  } | null;
}

export interface CommerceEvalE2eQuality {
  passed: boolean;
  problems: string[];
  thresholds: {
    maxTurnsPerCase: number;
    maxCacheMissInputTokensPerCase: number;
    maxUnexpectedToolFailures: number;
  };
  summary: {
    caseCount: number;
    measuredCaseCount: number;
    missingMetricsCaseIds: string[];
    turns: { total: number; average: number; max: { id: string | null; value: number } };
    cacheMissInputTokens: {
      total: number;
      average: number;
      max: { id: string | null; value: number };
    };
    tools: { unexpectedFailureCount: number; affectedCaseIds: string[] };
  };
}

export interface CommerceEvalRun {
  id: string;
  fileName: string;
  filePath: string;
  createdAt: string;
  mtimeMs: number;
  passed: boolean;
  total: number;
  passedCount: number;
  failedCount: number;
  passRate: number;
  averageScore: number;
  durationMs: number;
  metadata: {
    trigger: string | null;
    reportSchemaVersion?: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    command: string[];
    evaluator: {
      id: string | null;
      version?: string | null;
      rubricVersion?: string | null;
      concurrency: number;
    };
    runtime: {
      cli: string | null;
      model: string | null;
      reasoningEffort: string | null;
      configuredModel?: string | null;
      agentExecuted?: boolean;
      executedCaseCount?: number;
      unattestedCaseIds?: string[];
      frameworkVersion?: string | null;
      buildRevision?: string | null;
    };
    suite?: {
      mode: CommerceEvalExecutionMode;
      label: string;
      executionClass?: 'deterministic_contract' | 'live_mission_e2e' | string;
    };
    dataset?: {
      schemaVersion: number;
      visibility: 'public' | 'hidden' | 'production_replay';
      promptsRedacted: boolean;
      sourceIdentitySha256: string | null;
    };
    retention?: {
      databaseEvidenceRetained: boolean;
      workspaceRetained: boolean;
    };
    provenance?: {
      gitCommit: string | null;
      gitRevision?: string | null;
      buildRevision?: string | null;
      frameworkVersion?: string | null;
      casesSha256: string | null;
      promptsSha256: string | null;
      datasetRegistrySha256?: string | null;
      snapshotManifestSha256?: string | null;
    };
    dataSnapshots?: {
      schemaVersion: number;
      manifestId: string | null;
      manifestVersion: string | null;
      selected: Array<{
        caseId: string;
        id: string;
        asOf: string;
        payloadSha256: string;
      }>;
    };
    /** Duplicated into metadata JSON so DB-backed report reads retain it. */
    e2eQuality?: CommerceEvalE2eQuality | null;
    selection: {
      selectedCases: string[];
      limit: number | null;
      keepProjects: boolean;
      caseCount: number;
      concurrency: number;
      repeat: number;
    };
    skillLockSnapshot: {
      schemaVersion: string | number | null;
      skills: Record<
        string,
        {
          version: string | null;
          hash: string | null;
          packageHash: string | null;
          sourceSha256?: string | null;
          packageSha256?: string | null;
          sourcePath: string | null;
          packagePath: string | null;
        }
      >;
    };
  };
  qualitySummary: EvalQualitySummary;
  e2eQuality: CommerceEvalE2eQuality | null;
  coverage: {
    byCapability: Record<string, { total: number; passed: number; failed: number }>;
    byType: Record<string, { total: number; passed: number; failed: number }>;
    byTag: Record<string, { total: number; passed: number; failed: number }>;
    byLevel: Record<CommerceEvalCoverageLevel, Record<string, { total: number; passed: number; failed: number }>>;
    caseLevels: Record<string, CommerceEvalCoverageLevel[]>;
    caseTags: Record<string, string[]>;
    failedTags: Record<string, string[]>;
    requiredCoverage: {
      capabilities: string[];
      tags: string[];
      levels: Partial<Record<CommerceEvalCoverageLevel, string[]>>;
    };
  };
  results: CommerceEvalResult[];
}

export interface CommerceEvalDashboardData {
  generatedAt: string;
  reportsDir: string;
  casesPath: string;
  runtimeOptions: CommerceEvalRuntimeOption[];
  cases: CommerceEvalCase[];
  customEvalSets: CommerceEvalSetDefinition[];
  runs: CommerceEvalRun[];
  queue: CommerceEvalQueueItem[];
  repairTickets: CommerceEvalRepairTicket[];
  schedule: CommerceEvalScheduleConfig;
  latestRun: CommerceEvalRun | null;
  modelComparison: CommerceEvalModelComparison[];
  skillVersionImpact: CommerceEvalSkillVersionImpact[];
  assurance: {
    mutation: {
      createdAt: string;
      baselinePassed: boolean;
      total: number;
      killed: number;
      survived: number;
      killRate: number;
      reportPath: string;
    } | null;
    datasets: {
      publicCaseCount: number;
      productionCaseCount: number;
      productionSnapshotCount: number;
      hiddenConfigured: boolean;
      productionReplayConfigured: boolean;
    };
    judge: {
      datasetKind: string;
      productionCalibration: boolean;
      caseCount: number;
      agreementRate: number;
      cohenKappa: number;
      scoreMeanAbsoluteError: number;
      passed: boolean;
    } | null;
  };
  summary: {
    caseCount: number;
    reportCount: number;
    capabilityCount: number;
    latestPassRate: number;
    latestAverageScore: number;
    latestPassedCount: number;
    latestFailedCount: number;
    latestTotal: number;
  };
}

export interface CreateCommerceEvalCaseInput {
  id?: string;
  name?: string;
  question?: string;
  capabilityId?: string;
  type?: string;
  expectedEntities?: string[];
  expectedEntityType?: string | null;
  expectedTemplateId?: string | null;
  expectedVariantId?: string | null;
  expectedDatasets?: string[];
  expectedRawFiles?: string[];
  expectedFinalFields?: string[];
  coverageLevel?: CommerceEvalCoverageLevel;
  productionSupported?: boolean;
  oracleAssertions?: EvalOracleAssertion[];
  safetyTags?: string[];
  expectClarification?: boolean;
  visualCheck?: boolean;
}

export interface CreateCommerceEvalSetInput {
  id?: string;
  name?: string;
  description?: string;
  category?: string;
  caseIds?: string[];
}

export interface CommerceEvalRuntimeOption {
  cli: string;
  label: string;
  defaultModel: string;
  supportsReasoningEffort: boolean;
  models: {
    id: string;
    name: string;
    description: string | null;
  }[];
}

export interface CommerceEvalQueueItem {
  id: string;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cli: string;
  model: string;
  reasoningEffort: string;
  evaluatorId: string;
  concurrency: number;
  repeat: number;
  mode: CommerceEvalExecutionMode;
  selectedCases: string[];
  limit: number | null;
  keepProjects: boolean;
  reportId: string | null;
  reportPath: string | null;
  logPath: string | null;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
}

export type CommerceEvalQueueStatus = CommerceEvalQueueItem['status'];

export interface CommerceEvalModelComparison {
  key: string;
  cli: string;
  model: string;
  reasoningEffort: string;
  runs: number;
  latestRunId: string;
  latestPassRate: number;
  averagePassRate: number;
  latestAverageScore: number;
  averageScore: number;
  latestCreatedAt: string;
}

export interface CommerceEvalSkillVersionImpact {
  skillId: string;
  version: string;
  runs: number;
  latestRunId: string;
  latestPassRate: number;
  averagePassRate: number;
  latestAverageScore: number;
  averageScore: number;
  latestCreatedAt: string;
}

export interface StartCommerceEvalOptions {
  cli?: string;
  model?: string;
  reasoningEffort?: string;
  evaluatorId?: string;
  concurrency?: number;
  repeat?: number;
  mode?: CommerceEvalExecutionMode;
  selectedCases?: string[];
  limit?: number | null;
  keepProjects?: boolean;
}

export interface CommerceEvalFlowStep {
  id: string;
  name: string;
  status: 'passed' | 'warning' | 'failed';
  summary: string;
  detail: string | null;
}

export interface CommerceEvalFlowSimulation {
  generatedAt: string;
  ready: boolean;
  runtime: {
    cli: string;
    model: string;
    reasoningEffort: string;
    mode: CommerceEvalExecutionMode;
  };
  evaluator: {
    id: string;
    concurrency: number;
  };
  selection: {
    selectedCases: string[];
    limit: number | null;
    keepProjects: boolean;
    caseCount: number;
    concurrency: number;
    repeat: number;
  };
  selectedCaseIds: string[];
  command: string[];
  steps: CommerceEvalFlowStep[];
  warnings: string[];
}

export interface CommerceEvalRepairTicket {
  id: string;
  runId: string;
  caseId: string;
  title: string;
  status: 'open' | 'resolved';
  severity: 'high' | 'medium';
  createdAt: string;
  updatedAt: string;
  model: string;
  reportPath: string;
  projectId: string | null;
  failures: string[];
  validationSummaries: string[];
  suggestedActions: string[];
  skillVersions: Record<string, string | null>;
}

export interface CommerceEvalScheduleConfig {
  enabled: boolean;
  intervalHours: number;
  cli: string;
  model: string;
  reasoningEffort: string;
  selectedCases: string[];
  limit: number | null;
  keepProjects: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastQueuedRunId: string | null;
  updatedAt: string | null;
}

export interface UpdateCommerceEvalScheduleInput {
  enabled?: boolean;
  intervalHours?: number;
  cli?: string;
  model?: string;
  reasoningEffort?: string;
  selectedCases?: string[];
  limit?: number | null;
  keepProjects?: boolean;
  nextRunAt?: string | null;
}
