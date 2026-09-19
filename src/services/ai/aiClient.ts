/**
 * aiClient —— OpenAI 兼容 API 统一客户端（架构 §8.1）。
 *
 * 数据主权技术保障（架构 §7.3）：本模块是**唯一**发起网络请求的模块，
 * 且仅在 `mode === 'ai'` 且由用户显式动作触发时被调用。
 *
 * - 请求：`POST {baseUrl}/chat/completions`，`Authorization: Bearer {apiKey}`。
 * - 兼容 DeepSeek / 通义 / OpenAI / Ollama（Ollama 无 Key 时留空）。
 * - 超时：分析类 30s，探测类 3s（用 AbortController 实现）。
 * - 错误归一化为 `AiResponse.errorCode`，**永不抛异常**。
 */

import { DEFAULT_MAX_TOKENS } from './types';
import type {
  AiClientConfig,
  AiErrorCode,
  AiOfflineReason,
  AiProbeResult,
  AiResponse,
  ChatCompletionOptions,
  ChatMessage,
  FetchLike,
  FetchLikeResponse,
  ProbeOptions,
} from './types';

/** 分析类默认超时（毫秒）。 */
export const ANALYSIS_TIMEOUT_MS = 30_000;

/** 探测类默认超时（毫秒）。 */
export const PROBE_TIMEOUT_MS = 3_000;

/**
 * 归一化 baseUrl（去掉尾部 `/`，避免拼接出 `//chat/completions`）。
 *
 * @param baseUrl 原始 baseUrl
 * @returns 规范化后的 baseUrl
 */
export function normalizeBaseUrl(baseUrl: string): string {
  return (baseUrl ?? '').trim().replace(/\/+$/, '');
}

/**
 * 由 baseUrl 拼接 chat/completions 端点。
 *
 * 若用户已传入以 `/chat/completions` 结尾的完整地址，则直接使用。
 *
 * @param baseUrl baseUrl
 * @returns 完整端点
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/chat/completions')) {
    return base;
  }
  return `${base}/chat/completions`;
}

/**
 * 由 baseUrl 拼接 models 端点（连通性探测用）。
 *
 * @param baseUrl baseUrl
 * @returns 完整端点
 */
export function modelsUrl(baseUrl: string): string {
  const base = normalizeBaseUrl(baseUrl);
  if (base.endsWith('/models')) {
    return base;
  }
  return `${base}/models`;
}

/**
 * 构造请求头（Authorization 仅在 apiKey 非空时添加，兼容 Ollama）。
 *
 * @param apiKey API Key
 * @returns 请求头
 */
function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey && apiKey.trim().length > 0) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  return headers;
}

/**
 * 合并「外部信号」与「内部超时」为一个 AbortSignal。
 *
 * @param timeoutMs 超时毫秒数
 * @param external 外部信号（可选）
 * @returns { signal, dispose, timedOut }
 */
function withTimeout(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onExternalAbort = (): void => controller.abort();
  if (external) {
    if (external.aborted) {
      controller.abort();
    } else {
      external.addEventListener('abort', onExternalAbort);
    }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (external) {
        external.removeEventListener('abort', onExternalAbort);
      }
    },
    timedOut: () => timedOut,
  };
}

/**
 * 将 HTTP 状态码映射为归一化错误码。
 *
 * @param status HTTP 状态码
 * @returns 错误码
 */
function errorCodeFromStatus(status: number): AiErrorCode {
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'rateLimit';
  }
  if (status >= 400 && status < 500) {
    return 'content';
  }
  return 'unknown';
}

/**
 * 是否为 4xx 客户端错误。
 *
 * @param status HTTP 状态码
 * @returns 是否 4xx
 */
function isClientErrorStatus(status: number): boolean {
  return status >= 400 && status < 500;
}

/**
 * 判定某 HTTP 状态是否值得「去掉 `reasoning_effort` 重试一次」。
 *
 * 只对**该字段确实可疑**的 4xx 重试：
 * - 401 / 403（鉴权失败）与 429（限流）与请求字段无关，重发必然是同样结果，
 *   且会把真实错误延后一次才报、限流时还会自己加重限流 → 排除；
 * - 其余 4xx（400 参数不认识、404 路径/字段、422 语义错误等）都可能是服务端
 *   不识别 `reasoning_effort` 所致 → 重试一次。
 *
 * 取舍说明：宁可对 404/422 多打一次（幂等、代价低），也不要漏掉某个 provider
 * 用非 400 状态表达「未知字段」的情形；同时坚决避开鉴权/限流状态的无效重发。
 *
 * @param status HTTP 状态码
 * @returns 是否应去掉该字段重试
 */
function shouldRetryWithoutReasoningEffort(status: number): boolean {
  if (status === 401 || status === 403 || status === 429) {
    return false;
  }
  return isClientErrorStatus(status);
}

/** 错误码 → 中文说明。 */
const ERROR_MESSAGE: Record<AiErrorCode, string> = {
  network: '网络不可达，请检查 Base URL 与网络连接。',
  auth: '鉴权失败，请检查 API Key 是否正确。',
  rateLimit: '请求过于频繁（限流），请稍后重试。',
  content: '请求内容被服务端拒绝，请检查模型名与参数。',
  timeout: '请求超时，请检查服务是否可用或稍后重试。',
  aborted: '请求已取消。',
  unknown: 'AI 服务返回未知错误。',
};

/** 服务端错误原文进入 UI 前的最大长度（避免把整页 HTML / 日志塞进气泡）。 */
export const MAX_SERVER_DETAIL_CHARS = 300;

/**
 * 把服务端错误响应体压成**一句话**，让用户直接看到真实原因。
 *
 * 解析优先级（兼容 Ollama / vLLM / OpenAI 的错误体形状）：
 * 1. `{ error: { message } }` —— Ollama 与 OpenAI 官方形状（实测 400 走这条）；
 * 2. `{ error: "文本" }`；
 * 3. `{ message: "文本" }`；
 * 4. 以上都不成立（含 HTML 错误页、纯文本）→ 原样使用。
 *
 * 统一做「空白折叠 + 截断」，保证可安全嵌入一行 UI 文案。
 *
 * @param raw 服务端响应体原文
 * @returns 单行、可展示的原文；无内容时返回空串
 */
export function extractServerDetail(raw: string): string {
  const text = (raw ?? '').trim();
  if (text.length === 0) {
    return '';
  }
  let message = text;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    const err: unknown = parsed?.error;
    if (typeof err === 'string' && err.trim().length > 0) {
      message = err;
    } else if (typeof err === 'object' && err !== null) {
      const inner = (err as { message?: unknown }).message;
      if (typeof inner === 'string' && inner.trim().length > 0) {
        message = inner;
      }
    } else if (typeof parsed?.message === 'string' && parsed.message.trim().length > 0) {
      message = parsed.message;
    }
  } catch {
    // 非 JSON（HTML 错误页 / 纯文本）：原样使用。
  }
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SERVER_DETAIL_CHARS
    ? collapsed.slice(0, MAX_SERVER_DETAIL_CHARS) + '…'
    : collapsed;
}

/**
 * 组装「HTTP 非 2xx」的面向用户文案：基础说明 + 状态码 + **服务端原文**。
 *
 * 服务端原文是唯一能让用户自助定位（模型名写错 / 字段不被支持 / 上下文超限）的信息，
 * 必须透出而不是丢弃。
 *
 * @param code 归一化错误码
 * @param status HTTP 状态码
 * @param detail 已归一化的服务端原文（可为空串）
 * @returns 面向用户的错误文案
 */
function httpErrorMessage(code: AiErrorCode, status: number, detail: string): string {
  return detail.length > 0
    ? ERROR_MESSAGE[code] + '（HTTP ' + status + '：' + detail + '）'
    : ERROR_MESSAGE[code] + '（HTTP ' + status + '）';
}

/**
 * 从 fetch 异常中判定错误码（超时 vs 取消 vs 网络）。
 *
 * @param err 捕获的异常
 * @param timedOut 是否由内部超时触发
 * @returns 错误码
 */
function errorCodeFromException(err: unknown, timedOut: boolean): AiErrorCode {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError') {
    return timedOut ? 'timeout' : 'aborted';
  }
  return 'network';
}

/**
 * 从 OpenAI 兼容响应体中提取正文、模型名、`finish_reason` 与推理内容。
 *
 * 推理字段命名因后端而异（`reasoning` / `reasoning_content` / `thinking`），
 * 三者都识别，取第一个非空字符串；这样推理模型「思考占满配额、正文为空」的
 * 情形也能被上层感知。
 *
 * @param body 响应 JSON
 * @returns { content, model, finishReason, reasoning }
 */
function extractContent(body: unknown): {
  content: string;
  model: string;
  finishReason: string;
  reasoning: string;
} {
  const obj = (body ?? {}) as {
    model?: string;
    choices?: {
      finish_reason?: string;
      message?: {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
        thinking?: unknown;
      };
    }[];
  };
  const choice = obj.choices?.[0];
  const message = choice?.message ?? {};
  const content = typeof message.content === 'string' ? message.content : '';
  const model = typeof obj.model === 'string' ? obj.model : '';
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : '';
  const reasoning =
    [message.reasoning, message.reasoning_content, message.thinking].find(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ) ?? '';
  return { content, model, finishReason, reasoning };
}

/**
 * 构造「正文为空」时面向用户的可操作错误信息。
 *
 * 区分三种情形（`finish_reason === 'length'` 表示被输出上限截断）：
 * 1. 截断且有推理内容 → 提示是「思考耗尽配额」，引导确认「关闭模型思考」或调大上限；
 * 2. 单纯截断 → 提示调大上限；
 * 3. 其他 → 保留原通用文案。
 *
 * 注意：此处**刻意不给出具体 tokens 数值承诺** —— 推理模型的思考长度不可预测，
 * 实测见过「配额 4096 + 上下文 16384 仍耗尽、正文为空」，任何数值建议都需实测支撑。
 *
 * @param finishReason 归一化后的 finish_reason
 * @param reasoning 推理内容
 * @param maxTokens 本次请求实际使用的输出上限
 * @returns 面向用户的中文错误信息
 */
function emptyContentMessage(finishReason: string, reasoning: string, maxTokens: number): string {
  if (finishReason === 'length') {
    if (reasoning.length > 0) {
      return `模型思考过程已耗尽输出上限（${maxTokens} tokens），正文被截断。请确认「设置」页的「关闭模型思考」为开启（推荐），或调大「最大输出 tokens」后重试。`;
    }
    return `输出被输出上限（${maxTokens} tokens）截断，请确认「设置」页的「关闭模型思考」为开启（推荐），或调大「最大输出 tokens」后重试。`;
  }
  return 'AI 返回内容为空。';
}

/**
 * 发起一次 chat completion 请求（架构 §8.1）。
 *
 * @param config AI 配置
 * @param messages 聊天消息
 * @param options 请求选项（temperature / maxTokens / timeoutMs / signal）
 * @param fetchImpl 可注入的 fetch（默认全局 fetch；测试注入避免真实网络）
 * @returns 归一化响应（永不抛异常）
 */
export async function chatCompletion(
  config: AiClientConfig,
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
  fetchImpl?: FetchLike,
): Promise<AiResponse> {
  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  const model = config.model || '';
  if (!doFetch) {
    return {
      ok: false,
      content: '',
      errorCode: 'network',
      errorMessage: '当前环境不支持网络请求。',
      model,
    };
  }
  if (normalizeBaseUrl(config.baseUrl).length === 0) {
    return {
      ok: false,
      content: '',
      errorCode: 'network',
      errorMessage: '未配置 Base URL。',
      model,
    };
  }

  // 模型名是 chat 请求的**必填项**：空模型名实测会被 Ollama 以
  // `400 {"error":{"message":"model is required"}}` 拒绝。而 `DEFAULT_AI_CONFIG.model`
  // 就是空串（用户从未填写 / 配置被重置时即为此态），发出去只会换来一个
  // 看不懂的 400 —— 本地前置拦截并说清该改哪个字段，收益远大于一次网络往返。
  // 注意：**未发出请求**，故 `httpStatus` 保持 undefined（与既有契约一致）。
  if (model.trim().length === 0) {
    return {
      ok: false,
      content: '',
      errorCode: 'content',
      errorMessage:
        '未配置「模型名」，请求未发出（服务端会返回 400 model is required）。' +
        '请在「设置」页填写模型名（如 qwen3.5:9b）后重试。',
      model,
    };
  }

  const timeoutMs = options.timeoutMs ?? ANALYSIS_TIMEOUT_MS;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const hasReasoningEffort = options.reasoningEffort !== undefined;
  const buildBody = (includeReasoningEffort: boolean): string =>
    JSON.stringify({
      model: config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: maxTokens,
      stream: false,
      ...(includeReasoningEffort && options.reasoningEffort !== undefined
        ? { reasoning_effort: options.reasoningEffort }
        : {}),
    });
  const { signal, dispose, timedOut } = withTimeout(timeoutMs, options.signal);
  try {
    const url = chatCompletionsUrl(config.baseUrl);
    const headers = buildHeaders(config.apiKey);
    let response = await doFetch(url, {
      method: 'POST',
      headers,
      body: buildBody(hasReasoningEffort),
      signal,
    });

    // 兼容性兜底：部分服务端不认识 `reasoning_effort`，会以 4xx 拒绝整个请求。
    // 此时去掉该字段重试**一次**（复用同一超时/取消信号），保证非推理后端不被卡死。
    // 重试条件已收窄：鉴权失败（401/403）与限流（429）不重试（重发无意义且有害）。
    if (hasReasoningEffort && shouldRetryWithoutReasoningEffort(response.status)) {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: buildBody(false),
        signal,
      });
    }

    if (!response.ok) {
      const code = errorCodeFromStatus(response.status);
      let detail = '';
      try {
        detail = await response.text();
      } catch {
        detail = '';
      }
      // 服务端原文是**唯一**能指明真实原因的信息（「model is required」等）：
      // 归一化后的 errorCode 只会把任意 4xx 压成 content，不足以自助排查。
      // 故此处既拼进 errorMessage（一行可读文案），又保留原文供 UI 单独展示。
      const serverDetail = extractServerDetail(detail);
      return {
        ok: false,
        content: '',
        errorCode: code,
        errorMessage: httpErrorMessage(code, response.status, serverDetail),
        model,
        httpStatus: response.status,
        ...(serverDetail.length > 0 ? { serverDetail } : {}),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return {
        ok: false,
        content: '',
        errorCode: 'content',
        errorMessage: 'AI 返回内容无法解析。',
        model,
        httpStatus: response.status,
      };
    }
    const { content, model: respModel, finishReason, reasoning } = extractContent(body);
    if (!content) {
      return {
        ok: false,
        content: '',
        errorCode: 'content',
        errorMessage: emptyContentMessage(finishReason, reasoning, maxTokens),
        model: respModel || model,
        httpStatus: response.status,
        finishReason,
        reasoning,
      };
    }
    return {
      ok: true,
      content,
      errorCode: null,
      errorMessage: null,
      model: respModel || model,
      httpStatus: response.status,
      finishReason,
      reasoning,
    };
  } catch (err) {
    const code = errorCodeFromException(err, timedOut());
    return {
      ok: false,
      content: '',
      errorCode: code,
      errorMessage: ERROR_MESSAGE[code],
      model,
    };
  } finally {
    dispose();
  }
}

/**
 * 由 `GET /models` 的成功响应构造「可用」提示，并在**模型名疑似打错**时附加提醒。
 *
 * 安全版本（刻意不做硬拦截）：部分 OpenAI 兼容服务只返回模型子集，
 * 若因「不在列表」就判离线会误杀。因此这里 **不改 mode**（始终 `'ai'`），
 * 只把候选清单追加到成功 message 上，让用户能在徽标 tooltip 里自查模型名。
 *
 * @param resp /models 响应
 * @param model 用户配置的模型名
 * @returns 面向用户的成功提示
 */
async function availableMessage(resp: FetchLikeResponse, model: string): Promise<string> {
  const base = 'AI 服务可用。';
  const requested = model.trim();
  if (requested.length === 0) {
    return base;
  }
  let ids: string[];
  try {
    const body = (await resp.json()) as { data?: { id?: unknown }[] } | null;
    const data = body?.data;
    ids = Array.isArray(data)
      ? data.map((item) => (typeof item?.id === 'string' ? item.id : '')).filter((id) => id.length > 0)
      : [];
  } catch {
    // /models 返回非 JSON（部分实现）：无法校验，按可用处理，不打扰用户。
    return base;
  }
  if (ids.length === 0 || ids.includes(requested)) {
    return base;
  }
  const preview = ids.slice(0, 5).join('、');
  const more = ids.length > 5 ? ' 等' : '';
  return `${base}但模型「${requested}」不在服务端列表中（可用：${preview}${more}），请核对模型名。`;
}

/**
 * 连通性探测（架构 §7.1 probeAi）。
 *
 * 优先 `GET {baseUrl}/models`；若返回非 2xx（部分服务未实现 /models），
 * 退化为最小 chat 请求（max_tokens=16）。超时默认 3s。
 *
 * 配置语义（与设置页一致）：
 * - `baseUrl` 为空 → 离线（NO_BASE_URL），**不发起任何网络请求**；
 * - `baseUrl` 非空但 `apiKey` 为空 → **照常探测**：本机 Ollama / LM Studio
 *   等本地服务无需鉴权，空 Key 属合法配置（`buildHeaders` 已正确处理）。
 *
 * @param config AI 配置
 * @param options 探测选项
 * @param fetchImpl 可注入 fetch（测试注入）
 * @returns 探测结果
 */
export async function probeAi(
  config: AiClientConfig,
  options: ProbeOptions = {},
  fetchImpl?: FetchLike,
): Promise<AiProbeResult> {
  const offline = (reason: AiOfflineReason, message: string): AiProbeResult => ({
    mode: 'offline',
    reason,
    keepConfig: true,
    message,
  });

  if (normalizeBaseUrl(config.baseUrl).length === 0) {
    return offline('NO_BASE_URL', '未配置 Base URL，当前为离线模式。');
  }

  // 只探测 `/models` 会把「Base URL 可达但模型名没填」误判为「AI 模式可用」：
  // 用户能点「AI 全面诊断」，却只会收到 400 `model is required`（已实测复现）。
  // 模型名是 chat 请求的必填项，缺失即等于不可用，故在此直接判定离线并说明原因。
  if ((config.model ?? '').trim().length === 0) {
    return offline('NOT_CONFIGURED', '未配置模型名，当前为离线模式。');
  }

  const doFetch = fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!doFetch) {
    return offline('UNREACHABLE', '当前环境不支持网络请求，已降级为离线模式。');
  }

  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const { signal, dispose, timedOut } = withTimeout(timeoutMs, options.signal);
  try {
    const resp = await doFetch(modelsUrl(config.baseUrl), {
      method: 'GET',
      headers: buildHeaders(config.apiKey),
      signal,
    });
    if (resp.ok) {
      return {
        mode: 'ai',
        reason: '',
        keepConfig: true,
        message: await availableMessage(resp, config.model),
      };
    }
    // /models 不可用 → 尝试最小 chat 请求。
    // 探测目标是「连通性」而非「内容」：按**真实 HTTP 状态码**判定，
    // 只要服务端应答且 < 400 即算可达（含 2xx 但正文为空——例如推理模型在 16 tokens
    // 内只产出思考）。**绝不能用归一化后的 errorCode 推断**：`errorCodeFromStatus`
    // 把任意 4xx（含 404「路径写错」）都压成 'content'，用它会把「漏写 /v1 的 404」
    // 误判为「服务可用」，比保守判定更糟。
    const fallback = await chatCompletion(
      config,
      [{ role: 'user', content: 'ping' }],
      { maxTokens: 16, timeoutMs },
      fetchImpl,
    );
    if (fallback.httpStatus !== undefined && fallback.httpStatus < 400) {
      return { mode: 'ai', reason: '', keepConfig: true, message: 'AI 服务可用。' };
    }
    return offline('UNREACHABLE', 'AI 服务暂不可用，已降级为离线模式。');
  } catch (err) {
    const code = errorCodeFromException(err, timedOut());
    if (code === 'timeout') {
      return offline('TIMEOUT', 'AI 服务探测超时，已降级为离线模式（配置已保留）。');
    }
    return offline('UNREACHABLE', 'AI 服务不可达，已降级为离线模式（配置已保留）。');
  } finally {
    dispose();
  }
}

/** 导出内部工具供测试使用。 */
export const __internal = {
  buildHeaders,
  withTimeout,
  errorCodeFromStatus,
  errorCodeFromException,
  extractServerDetail,
  httpErrorMessage,
};
