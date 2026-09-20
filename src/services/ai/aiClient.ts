/**
 * aiClient —— OpenAI 兼容 API 统一客户端（架构 §8.1）。
 *
 * 数据主权技术保障（架构 §7.3）：本模块是**唯一**发起网络请求的模块，
 * 且仅在 `mode === 'ai'` 且由用户显式动作触发时被调用。
 *
 * - 请求：`POST {baseUrl}/chat/completions`，`Authorization: Bearer {apiKey}`。
 * - 兼容 DeepSeek / 通义 / OpenAI / Ollama（Ollama 无 Key 时留空）。
 * - 超时：分析类按输出规模自适应（30s 起，最多 120s；探测类固定 3s，均用 AbortController 实现）。
 * - 瞬时链路故障（连接被切断 / 正文读一半断流）自动重试一次；超时与 4xx 不重试。
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

/** 服务端在 400 响应里声明的 `max_tokens` 合法区间。 */
export interface MaxTokensRange {
  min: number;
  max: number;
}

/**
 * 从服务端错误原文里解析 `max_tokens` 的合法区间。
 *
 * 为什么必须解析而不是写死：各家上限差别极大 —— 本机 Ollama 基本不限，
 * DeepSeek 实测返回「the valid range of max_tokens is [1, 393216]」，
 * 而本项目的「最大输出 tokens」按需求**刻意不设上限**（用户明确要求不限制）。
 * 两者相遇时，唯一既通用又不武断的做法就是**读服务端自己声明的区间**。
 *
 * @param detail 服务端错误原文
 * @returns 合法区间；无法解析时 null
 */
export function parseMaxTokensRange(detail: string): MaxTokensRange | null {
  if (!/max_tokens/i.test(detail)) {
    return null;
  }
  const m = /\[\s*(\d+)\s*,\s*(\d+)\s*\]/.exec(detail);
  if (!m) {
    return null;
  }
  const min = Number(m[1]);
  const max = Number(m[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 1 || max < min) {
    return null;
  }
  return { min, max };
}

/**
 * 把 `max_tokens` 收敛到服务端允许的区间内。
 *
 * @param value 用户配置的上限
 * @param range 服务端声明的合法区间
 * @returns 收敛后的值
 */
export function clampMaxTokens(value: number, range: MaxTokensRange): number {
  const rounded = Math.round(value);
  return Math.min(Math.max(rounded, range.min), range.max);
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

/** 响应体原文进入错误信息前的最大长度（避免把整页 HTML 塞进 UI）。 */
export const MAX_RAW_BODY_SNIPPET_CHARS = 200;

/** 折叠空白并截断原始响应体，供错误信息 / serverDetail 展示。 */
function collapseRawBody(raw: string, max = MAX_RAW_BODY_SNIPPET_CHARS): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}

/**
 * 从 SSE（`text/event-stream`）响应体里累计正文。
 *
 * 兼容 `choices[0].delta.content`（真流式）与 `choices[0].message.content`（伪流式），
 * 忽略 `[DONE]` 与无法解析的 keep-alive 行。
 *
 * @param raw 完整响应体
 * @returns { content, model, finishReason }
 */
export function extractSseContent(raw: string): { content: string; model: string; finishReason: string } {
  let content = '';
  let model = '';
  let finishReason = '';
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) {
      continue;
    }
    const payload = trimmed.slice('data:'.length).trim();
    if (payload.length === 0 || payload === '[DONE]') {
      continue;
    }
    let chunk: unknown;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    const obj = (chunk ?? {}) as {
      model?: string;
      choices?: {
        finish_reason?: string;
        delta?: { content?: unknown };
        message?: { content?: unknown };
      }[];
    };
    const choice = obj.choices?.[0];
    const part = choice?.delta?.content ?? choice?.message?.content;
    if (typeof part === 'string') {
      content += part;
    }
    if (typeof obj.model === 'string' && obj.model.length > 0) {
      model = obj.model;
    }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) {
      finishReason = choice.finish_reason;
    }
  }
  return { content, model, finishReason };
}

/**
 * 解析 200 响应体：优先 JSON，失败时按 SSE 兜底。
 *
 * 实测部分服务端（或反向代理）即使收到 `stream:false` 仍返回 `text/event-stream`，
 * 此时 `response.json()` 必然失败 —— 旧实现会把它笼统报成「AI 返回内容无法解析」，
 * 用户无从自助排查。此处先读原文再判格式，彻底失败时把原文片段带进错误信息与 serverDetail。
 *
 * @param raw 完整响应体
 * @returns 成功时透出归一化 body；失败时给出可读信息与原文片段
 */
export function parseCompletionBody(
  raw: string,
): { ok: true; body: unknown } | { ok: false; message: string; detail: string } {
  const text = (raw ?? '').trim();
  if (text.length === 0) {
    return { ok: false, message: 'AI 返回内容为空。', detail: '' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const sse = extractSseContent(text);
    // SSE 形态（含 `data:` 行）即使本轮没有正文，也交给上层报「内容为空」，
    // 而不是笼统的「无法解析」——后者会误导用户去查网络/格式。
    if (sse.content.length > 0 || /^\s*data:/m.test(text)) {
      return {
        ok: true,
        body: {
          model: sse.model,
          choices: [{ finish_reason: sse.finishReason, message: { content: sse.content } }],
        },
      };
    }
    const snippet = collapseRawBody(text);
    return {
      ok: false,
      message: `AI 返回内容无法解析：既不是 OpenAI 兼容 JSON，也不是 SSE 流。服务端原文：${snippet}`,
      detail: snippet,
    };
  }
  const choices = (parsed as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) {
    const snippet = collapseRawBody(text);
    return {
      ok: false,
      message: `AI 返回内容缺少 choices 字段（不是 OpenAI 兼容响应）。服务端原文：${snippet}`,
      detail: snippet,
    };
  }
  return { ok: true, body: parsed };
}
/** 每个输出 token 预留的生成时间（毫秒）：云端实测约 25~40 tokens/s，这里取保守值。 */
export const MS_PER_OUTPUT_TOKEN = 30;

/** 自适应超时的上限：再长就该让用户去怀疑链路，而不是把界面无声卡住。 */
export const MAX_ANALYSIS_TIMEOUT_MS = 120_000;

/**
 * 计算本次请求的超时预算（P9 起**自适应**）。
 *
 * 为什么不能再固定 30s：`stream:false` 下必须等**整段生成完**才能拿到正文，
 * 而 4096 tokens 的中文报告在云端模型上常要 60~120s。固定 30s 会把
 * 「模型正在好好写」误判成故障 —— 用户实测的「连续两次失败、第三次才成功」
 * 就与这个预算偏紧相符（详见记忆 P9 节）。
 *
 * 显式传入 `timeoutMs` 时**完全以调用方为准**（测试与特殊场景需要确定性）。
 *
 * @param options 请求选项
 * @returns 超时毫秒数
 */
export function resolveTimeoutMs(options: ChatCompletionOptions): number {
  if (Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0) {
    return options.timeoutMs as number;
  }
  const maxTokens =
    Number.isFinite(options.maxTokens) && (options.maxTokens ?? 0) > 0
      ? (options.maxTokens as number)
      : DEFAULT_MAX_TOKENS;
  return Math.min(ANALYSIS_TIMEOUT_MS + maxTokens * MS_PER_OUTPUT_TOKEN, MAX_ANALYSIS_TIMEOUT_MS);
}

/** 瞬时故障自动重试时拼在错误信息前的说明（用户必须知道应用替他做了什么）。 */
export const TRANSIENT_RETRY_NOTE = '已自动重试 1 次：';

/**
 * 单轮「发请求 + 读正文」的结果分类。
 *
 * 分类而不是直接造文案：错因不同 → 文案不同、**是否重试**不同。
 */
export type AttemptOutcome =
  | { kind: 'http'; status: number; serverDetail: string }
  | { kind: 'read-failed'; status: number; bytes: number; timedOut: boolean }
  | { kind: 'thrown'; error: unknown; timedOut: boolean }
  | { kind: 'body'; status: number; body: string };

/**
 * 这一轮结果是否值得**整轮重试**（只给一次机会）。
 *
 * 只认「瞬时链路故障」：
 * - fetch 抛错（网络层失败），但不含超时与用户主动取消；
 * - 正文读到一半被切断（含 0 字节）。
 *
 * 刻意排除：超时（已用满本轮预算，再等一轮只会让用户多等一倍）、
 * 4xx（重发无意义且有害，见 aiClient 的自愈策略）。
 *
 * @param outcome 单轮结果
 * @returns 是否重试
 */
export function isRetryableTransient(outcome: AttemptOutcome): boolean {
  if (outcome.kind === 'thrown') {
    const name = (outcome.error as { name?: string } | null)?.name ?? '';
    return !outcome.timedOut && name !== 'AbortError';
  }
  if (outcome.kind === 'read-failed') {
    return !outcome.timedOut;
  }
  return false;
}

/**
 * 正文读取失败时的可操作文案。
 *
 * 旧实现无论是超时、断连还是被截断，都只说一句「响应流中断」——用户读到的信息量
 * 等于零（既不知道是谁的问题，也不知道该做什么）。这里按**证据**分成三种：
 * 0 字节 = 连接在返回正文前就被切断；N 字节 = 传到一半被截断（网关 / 代理典型症状）；
 * 超时 = 服务端一直没把正文发完。
 *
 * @param outcome 读正文失败的信息（已收字节数 / 是否超时）
 * @returns 面向用户的一句话
 */
export function readFailureMessage(outcome: { bytes: number; timedOut: boolean }): string {
  if (outcome.timedOut) {
    return (
      '等待响应正文超时，连接已中断（服务端在这段时间里没有把正文发完）。' +
      '若是云端模型的长回答，可到「设置」页调小「最大输出 tokens」缩小回答长度，或改用更快的模型后重试。'
    );
  }
  if (outcome.bytes <= 0) {
    return (
      'AI 返回内容读取失败：连接在返回正文前被切断（未收到任何数据）。' +
      '常见于 VPN / 代理不稳定，或服务端主动断开；直接再问一次通常即可。'
    );
  }
  return (
    `AI 返回内容读取失败：响应传到一半被切断（已收到 ${outcome.bytes} 字节）。` +
    '常见于 VPN / 代理在长响应上超时或网关限速；直接再问一次通常即可。'
  );
}

/** 按 UTF-8 计算字符串字节数（假响应没有字节流时用它估个准数）。 */
function utf8Length(text: string): number {
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    total += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return total;
}

/** 浏览器 / undici 响应体流的最小读取接口（只用到 read）。 */
type RawReader = { read: () => Promise<{ done: boolean; value?: Uint8Array }> };

/**
 * 读响应正文，并统计**实际收到的字节数**。
 *
 * 真实 fetch 有 `body` 流时逐块读：断流发生在第几块、共收到多少字节都能拿到，
 * 这是把「断连」与「被截断」分开的唯一证据。假响应（测试注入、老环境）没有流，
 * 退回 `text()`，行为与旧实现完全一致。
 *
 * @param response 响应
 * @returns 成功时给出正文与字节数；失败时给出**已收字节数**
 */
async function readBodyWithCount(
  response: FetchLikeResponse,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; bytes: number }> {
  const rawBody = (response as { body?: { getReader?: () => RawReader } | null }).body;
  const reader: RawReader | null =
    rawBody && typeof rawBody.getReader === 'function' ? rawBody.getReader() : null;
  if (reader === null) {
    try {
      const text = await response.text();
      return { ok: true, text, bytes: utf8Length(text) };
    } catch {
      return { ok: false, bytes: 0 };
    }
  }
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- 流必须按顺序读
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      if (chunk.value && chunk.value.byteLength > 0) {
        bytes += chunk.value.byteLength;
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    text += decoder.decode();
    return { ok: true, text, bytes };
  } catch {
    return { ok: false, bytes };
  }
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

  const timeoutMs = resolveTimeoutMs(options);
  let maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const hasReasoningEffort = options.reasoningEffort !== undefined;
  /** 是否已因服务端不识别而摘掉 `reasoning_effort`（只摘一次）。 */
  let dropReasoningEffort = false;
  /** 自动收敛 `max_tokens` 的说明：拼进错误信息，让用户知道到底发生了什么。 */
  let clampNote = '';
  /** 瞬时故障自动重试的说明：同样拼进错误信息（应用替用户做了什么，必须说出来）。 */
  let retryNote = '';
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
  /**
   * 跑一轮「发请求 + 读正文」，返回**结果分类**而不是直接造文案。
   *
   * 为什么按「一轮」切分（P9，用户实测踩到）：单轮之内的 400 自愈（收敛 max_tokens /
   * 摘掉 reasoning_effort）与「瞬时链路故障**整轮**重试」是两种语义。塞进同一个 for
   * 循环里会让两者互相挤占重试预算 —— 用户那次「连续两次 响应流中断、手点第三次才成功」，
   * 应用一次都没替他重试，只能靠他手点。
   */
  const runOnce = async (): Promise<AttemptOutcome> => {
    // 超时预算**每轮独立**：重试必须有自己的完整预算，不能被上一轮吃掉。
    const { signal, dispose, timedOut } = withTimeout(timeoutMs, options.signal);
    try {
      const url = chatCompletionsUrl(config.baseUrl);
      const headers = buildHeaders(config.apiKey);
      /** 单轮内最多 3 次请求：首次 + 收敛 max_tokens + 摘掉 reasoning_effort。 */
      const MAX_ATTEMPTS = 3;
      let response!: FetchLikeResponse;
      let serverDetail = '';
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: buildBody(hasReasoningEffort && !dropReasoningEffort),
          signal,
        });
        if (response.ok) {
          break;
        }
        let detail = '';
        try {
          detail = await response.text();
        } catch {
          detail = '';
        }
        serverDetail = extractServerDetail(detail);

        // 自愈 1（优先）：服务端在 400 里直接给出了 `max_tokens` 的合法区间。
        // 各家上限差别极大（本机 Ollama 基本不限、DeepSeek 实测 [1, 393216]），
        // 而「最大输出 tokens」按需求刻意**不设上限** —— 用户填的大值必然被拒。
        // 与其让用户自己猜该填多少，不如按服务端给的区间收敛后重试；仍失败才报错。
        const range = parseMaxTokensRange(detail);
        if (range) {
          const clamped = clampMaxTokens(maxTokens, range);
          if (clamped !== maxTokens) {
            clampNote =
              `已将「最大输出 tokens」由 ${maxTokens} 自动收敛为 ${clamped}` +
              `（服务端要求 ${range.min}~${range.max}）后重试。`;
            maxTokens = clamped;
            continue;
          }
        }

        // 自愈 2：部分服务端不认识 `reasoning_effort`，会以 4xx 拒绝整个请求。
        // 去掉该字段重试（复用同一超时/取消信号），保证非推理后端不被卡死。
        // 重试条件已收窄：鉴权失败（401/403）与限流（429）不重试（重发无意义且有害）。
        if (
          hasReasoningEffort &&
          !dropReasoningEffort &&
          shouldRetryWithoutReasoningEffort(response.status)
        ) {
          dropReasoningEffort = true;
          continue;
        }
        break;
      }

      if (!response.ok) {
        return { kind: 'http', status: response.status, serverDetail };
      }

      // 读正文时手写流读而不是 `response.text()`：只有流读才拿得到
      // 「到底收到了多少字节」，而 0 字节与「传了一半」指向完全不同的原因
      // （连接被切断 vs 网关 / 代理把长响应截断）—— 这正是用户上次那条
      // 「响应流中断」无法自助排查的地方。
      const read = await readBodyWithCount(response);
      if (!read.ok) {
        return {
          kind: 'read-failed',
          status: response.status,
          bytes: read.bytes,
          timedOut: timedOut(),
        };
      }
      return { kind: 'body', status: response.status, body: read.text };
    } catch (err) {
      return { kind: 'thrown', error: err, timedOut: timedOut() };
    } finally {
      dispose();
    }
  };

  let outcome = await runOnce();
  // 瞬时链路故障（fetch 抛错 / 正文读到一半被切断）自动重试**一次**：
  // 用户实测「连续两次失败、手点第三次才成功」说明链路是「抽一下就好」的，
  // 这种重试应当由应用完成，而不是指望用户手点。
  // 刻意**不重试**两类：超时（已用满本轮预算，再等一轮只会让用户多等一倍）、
  // 以及用户主动取消。
  if (isRetryableTransient(outcome)) {
    retryNote = TRANSIENT_RETRY_NOTE;
    outcome = await runOnce();
  }
  /** 附加说明（自动收敛 / 自动重试）：用户必须知道应用替他做了什么。 */
  const note = clampNote + retryNote;

  if (outcome.kind === 'http') {
    const code = errorCodeFromStatus(outcome.status);
    // 服务端原文是**唯一**能指明真实原因的信息（「model is required」等）：
    // 归一化后的 errorCode 只会把任意 4xx 压成 content，不足以自助排查。
    // 故此处既拼进 errorMessage（一行可读文案），又保留原文供 UI 单独展示。
    const baseMessage = httpErrorMessage(code, outcome.status, outcome.serverDetail);
    return {
      ok: false,
      content: '',
      errorCode: code,
      errorMessage: note.length > 0 ? `${note}${baseMessage}` : baseMessage,
      model,
      httpStatus: outcome.status,
      ...(outcome.serverDetail.length > 0 ? { serverDetail: outcome.serverDetail } : {}),
    };
  }

  if (outcome.kind === 'read-failed') {
    const baseMessage = readFailureMessage(outcome);
    return {
      ok: false,
      content: '',
      errorCode: outcome.timedOut ? 'timeout' : 'network',
      errorMessage: note.length > 0 ? `${note}${baseMessage}` : baseMessage,
      model,
      httpStatus: outcome.status,
    };
  }

  if (outcome.kind === 'thrown') {
    const code = errorCodeFromException(outcome.error, outcome.timedOut);
    return {
      ok: false,
      content: '',
      errorCode: code,
      errorMessage: note.length > 0 ? `${note}${ERROR_MESSAGE[code]}` : ERROR_MESSAGE[code],
      model,
    };
  }

  {
    const parsedBody = parseCompletionBody(outcome.body);
    if (!parsedBody.ok) {
      return {
        ok: false,
        content: '',
        errorCode: 'content',
        errorMessage: parsedBody.message,
        model,
        httpStatus: outcome.status,
        ...(parsedBody.detail.length > 0 ? { serverDetail: parsedBody.detail } : {}),
      };
    }
    const body = parsedBody.body;
    const { content, model: respModel, finishReason, reasoning } = extractContent(body);
    if (!content) {
      return {
        ok: false,
        content: '',
        errorCode: 'content',
        errorMessage: emptyContentMessage(finishReason, reasoning, maxTokens),
        model: respModel || model,
        httpStatus: outcome.status,
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
      httpStatus: outcome.status,
      finishReason,
      reasoning,
    };
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
  collapseRawBody,
};
