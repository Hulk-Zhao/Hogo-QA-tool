/**
 * AI 服务层类型定义（架构文档 §7.1、§8）。
 *
 * 本层是**唯一**允许发起网络请求的层（`aiClient.ts`），
 * 且禁止 import React / MUI（架构 §2.9）。
 */

/**
 * AI 功能标识（与 `AiUsageLog.feature` 对齐）。
 *
 * 第五轮需求 #12 新增 `fullDiagnosis`（AI 全面诊断）：一次请求产出可交付的
 * Markdown 诊断报告。新增枚举值时必须同步四处，缺一处即为「接线类缺陷」：
 *   1. 本条联合类型；
 *   2. `payloadBuilder.FEATURE_LABEL` / `FEATURE_SYSTEM_PROMPT`；
 *   3. `usageLog.USAGE_FEATURE_LABEL`（设置页用量表）；
 *   4. `data/schema.AiUsageLog.feature`（持久化实体）。
 */
export type AiFeature = 'chartExplain' | 'capExplain' | 'suggest' | 'report' | 'qa' | 'fullDiagnosis';

/**
 * 默认最大输出 tokens（唯一真源，settingsStore/store 与 aiClient 共同引用）。
 *
 * 取值理由：推理模型（如 qwen3.5、deepseek-reasoner）的**思考过程同样计入
 * completion_tokens**。若上限过小（例如 1024），模型会在产出正文前就把配额
 * 耗光，服务端返回 `finish_reason: 'length'` 且 `content` 为空字符串，
 * 用户侧表现为「AI 返回内容为空」。4096 为推理模型留出足够配额。
 */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * 推理强度（映射到 OpenAI 兼容请求体的 `reasoning_effort` 字段）。
 *
 * 对**不收敛的推理模型**（如 qwen3.5:9b，思考可长达上万字符且始终不产出正文），
 * 传 `'none'` 可关闭思考、直接输出正文；非推理模型收到该字段通常会忽略之。
 * 若目标服务端不认识该字段而返回 4xx，`chatCompletion` 会自动去掉它重试一次。
 */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

/** 发送载荷范围：摘要 / 原始明细。 */
export type PayloadScope = 'summary' | 'raw';

/** 降级原因码（供设置页与徽标 tooltip 展示）。 */
export type AiOfflineReason =
  | 'NO_KEY'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'NO_BASE_URL'
  | 'NOT_CONFIGURED';

/** 模式判定结果（架构 §7.1 probeAi）。 */
export interface AiProbeResult {
  mode: 'offline' | 'ai';
  reason: AiOfflineReason | '';
  /** 失败时是否保留配置（架构 §7.1 keepConfig）。 */
  keepConfig: boolean;
  /** 面向用户的中文说明。 */
  message: string;
}

/** AI 配置（与 settingsStore.AiConfig 结构一致，避免循环依赖此处独立声明）。 */
export interface AiClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 聊天消息。 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** AI 响应（错误归一化，永不抛异常，架构 §8.1）。 */
export interface AiResponse {
  ok: boolean;
  content: string;
  /** 归一化错误码：network/auth/rateLimit/content/timeout/aborted/unknown。 */
  errorCode: AiErrorCode | null;
  /** 面向用户的中文错误说明。 */
  errorMessage: string | null;
  /** 本次响应采用的模型名。 */
  model: string;
  /**
   * 本次请求实际的 HTTP 状态码。
   *
   * - 成功/服务端错误分支填真实状态码；
   * - **未发出请求**的本地前置校验（无 fetch / baseUrl 为空）与 catch 分支
   *   （超时 / 网络异常）为 `undefined`。
   *
   * 用于让上层按**真实状态码**判断连通性（`< 400` 即可达），
   * 而不依赖归一化后的 `errorCode`（后者会把 404 与 2xx-空正文都压成 `'content'`，
   * 无法区分「路径写错」与「服务连通但无正文」）。
   */
  httpStatus?: number;
  /**
   * 服务端错误响应体的**可读原文**（仅 HTTP 非 2xx 时填充）。
   *
   * 为什么必须留着：Ollama / vLLM / OpenAI 的 400 会明确写出原因
   * （`model is required`、`invalid reasoning value: 'x'`…），而 `errorCode` 是
   * 归一化后的粗粒度分类——任意 4xx 都被压成 `'content'`。此前这里**读完即丢**，
   * 用户只能看到「请检查模型名与参数」这种无法自助排查的泛化文案
   * （实测复现：空模型名 → 400 `model is required`，UI 却只显示泛化提示）。
   * 已做空白折叠 + 长度截断（见 `MAX_SERVER_DETAIL_CHARS`），可直接展示。
   */
  serverDetail?: string;
  /**
   * OpenAI 兼容的 `finish_reason`（如 `stop` / `length` / `content_filter`）。
   * 后端未提供时为 undefined；用于区分「正常结束」与「被输出上限截断」。
   */
  finishReason?: string;
  /**
   * 推理模型返回的思考内容（`reasoning` / `reasoning_content` / `thinking` 归一化）。
   * 思考内容会占用 completion_tokens 但通常不属于正文；保留下来便于在正文为空时
   * 向用户展示「模型确实在思考」，而非只抛一句无信息量的「内容为空」。
   */
  reasoning?: string;
}

/** 归一化错误码。 */
export type AiErrorCode =
  | 'network'
  | 'auth'
  | 'rateLimit'
  | 'content'
  | 'timeout'
  | 'aborted'
  | 'unknown';

/** 请求选项。 */
export interface ChatCompletionOptions {
  temperature?: number;
  maxTokens?: number;
  /**
   * 推理强度（OpenAI 兼容 `reasoning_effort`）。
   *
   * 传 `'none'` 可关闭推理模型的思考过程（本项目默认路径，见
   * `AiConfig.disableThinking`）；若服务端不识别该字段而返回 4xx，
   * `chatCompletion` 会**自动去掉该字段重试一次**，不影响非推理后端。
   */
  reasoningEffort?: ReasoningEffort;
  /** 超时毫秒数；分析类 30000，探测类 3000（架构 §8.1）。 */
  timeoutMs?: number;
  /** 外部取消信号（与内部超时合并）。 */
  signal?: AbortSignal;
}

/** 探测选项。 */
export interface ProbeOptions {
  /** 探测超时毫秒数，默认 3000。 */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 依赖注入：fetch 实现（测试可替换，避免真实网络）。 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchLikeResponse>;

/** fetch 响应最小接口。 */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

/** buildPayload 白名单构造结果（架构 §8.2）。 */
export interface AiPayload {
  scope: PayloadScope;
  /** 本次实际发送的字段名清单（供 UI 展示与审计）。 */
  sentFields: string[];
  messages: ChatMessage[];
}

/** 分析摘要联合类型（来自 core/ai/summary 的产物，避免 services → core 类型分叉）。 */
export type SummaryLike = Record<string, unknown>;
