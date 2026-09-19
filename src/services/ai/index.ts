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
  __internal as __aiClientInternals,
} from './aiClient';

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
