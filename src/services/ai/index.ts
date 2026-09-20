/**
 * AI 服务层统一导出（架构 §8）。
 */

export type {
  AiClientConfig,
  AiErrorCode,
  AiFeature,
  AiOfflineReason,
  AiPayload,
  AiProbeResult,
  AiResponse,
  ChatCompletionOptions,
  ChatMessage,
  FetchLike,
  FetchLikeResponse,
  PayloadScope,
  ProbeOptions,
  ReasoningEffort,
  SummaryLike,
} from './types';

export { DEFAULT_MAX_TOKENS } from './types';

export {
  chatCompletionsUrl,
  chatCompletion,
  modelsUrl,
  normalizeBaseUrl,
  probeAi,
  ANALYSIS_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  MAX_ANALYSIS_TIMEOUT_MS,
  MS_PER_OUTPUT_TOKEN,
  TRANSIENT_RETRY_NOTE,
  isRetryableTransient,
  readFailureMessage,
  resolveTimeoutMs,
  type AttemptOutcome,
  __internal as __aiClientInternals,
} from './aiClient';

export {
  buildAnalysisContext,
  buildChartCatalogue,
  deriveChartType,
  parseChartRefId,
  subgroupSeriesLimitFor,
  SUBGROUP_SERIES_BUDGET,
  SUBGROUP_SERIES_MAX,
  type AnalysisContextOptions,
  type ChartRef,
} from './analysisContext';

export { extractChartRefIds, stripChartRefs } from './chartRefs';
export {
  buildMessages,
  buildPayload,
  pickKnownSummaryFields,
  summaryWhitelist,
} from './payloadBuilder';

export {
  buildUsageEntry,
  USAGE_FEATURE_LABEL,
  USAGE_SCOPE_LABEL,
  type AiUsageEntry,
} from './usageLog';

export {
  ANALYSIS_FOCUSES,
  DEFAULT_FOCUS_IDS,
  findFocus,
  focusInstructionText,
  focusLabels,
  normalizeFocusIds,
  type AnalysisFocus,
  type AnalysisFocusId,
} from './analysisFocus';

export {
  analyzableModules,
  buildReportModules,
  controlLimits,
  type ReportModule,
  type ReportModuleExtras,
  type ReportModuleId,
} from './reportModules';

export {
  buildModuleMessages,
  describeFocuses,
  runReportAnalysis,
  shouldAbortAnalysis,
  type ModuleAnalysis,
  type RunReportAnalysisRequest,
  type RunReportAnalysisResult,
} from './reportAnalysis';

export {
  buildFullDiagnosisRecord,
  buildDiagnosisMarkdown,
  diagnosisFileName,
  sanitizeFullDiagnosis,
  type FullDiagnosisRecord,
} from './diagnosisReport';
