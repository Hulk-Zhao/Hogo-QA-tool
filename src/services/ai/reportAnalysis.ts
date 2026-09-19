/**
 * reportAnalysis —— 报表模块级 AI 分析执行器（AI 导出功能的核心）。
 *
 * 用户需求：「新增一个 AI 导出功能，必须要接入 LLM，导出的报表每个模块都有 AI 分析，
 * 可以选择 AI 分析方向」。
 *
 * 行为约定（都可证伪）：
 *  1. **真的调用 LLM**：唯一出口是 `chatCompletion`（可注入以便用例断言调用次数与消息体）；
 *  2. **每个有数据的模块各一次调用**：一次请求只带一个模块的摘要，避免把全部模块塞进
 *     一次请求后模型开始「平均分配注意力」、某几个模块被敷衍；
 *  3. **串行**：并发会让本地 Ollama / 小配额服务端更容易 429，也让进度条失去意义；
 *  4. **失败不静默**：单模块失败记在结果里（`ok:false` + 原因），
 *     但遇到「重试也没用」的错误（鉴权 / 网络 / 超时 / 限流）会**提前中止**，
 *     剩余模块标记为「已中止」，不再白烧请求；
 *  5. **审计**：每次调用都产出 `AiUsageEntry`（写进项目 aiUsageLogs）。
 */

import { chatCompletion } from './aiClient';
import { buildMessages } from './payloadBuilder';
import { buildUsageEntry, type AiUsageEntry } from './usageLog';
import {
  focusInstructionText,
  focusLabels,
  intersectFocus,
  normalizeFocusIds,
  type AnalysisFocusId,
} from './analysisFocus';
import {
  analyzableModules,
  buildReportModules,
  type ReportModule,
  type ReportModuleExtras,
  type ReportModuleId,
} from './reportModules';
import type { AiClientConfig, AiErrorCode, AiResponse, ChatCompletionOptions, ChatMessage } from './types';
import type { ReportModel } from '@/data/exporter/reportModel';

/** 单个模块的分析产物。 */
export interface ModuleAnalysis {
  moduleId: ReportModuleId;
  title: string;
  /** 成功时的 Markdown 正文；失败或跳过时为空串。 */
  markdown: string;
  /** 是否拿到了有效正文。 */
  ok: boolean;
  model: string;
  /** 失败原因（面向用户）；成功时为 null。 */
  errorMessage: string | null;
  /** 该模块被跳过的原因（无数据 / 因前序失败而中止）；未跳过时为 null。 */
  skipReason: string | null;
  /** 本次实际发送的字段名清单（审计用）。 */
  sentFields: string[];
}

/** 执行参数。 */
export interface RunReportAnalysisRequest {
  model: ReportModel;
  focusIds: readonly AnalysisFocusId[];
  aiConfig: AiClientConfig;
  maxTokens?: number;
  disableThinking?: boolean;
  extras?: ReportModuleExtras;
  /** 可注入的聊天实现（默认 `chatCompletion`）。 */
  chat?: (
    config: AiClientConfig,
    messages: ChatMessage[],
    options: ChatCompletionOptions,
  ) => Promise<AiResponse>;
  /** 进度回调（每个模块开始前触发一次）。 */
  onProgress?: (info: { done: number; total: number; title: string }) => void;
  signal?: AbortSignal;
}

/** 执行结果。 */
export interface RunReportAnalysisResult {
  analyses: ModuleAnalysis[];
  /** 实际发起的 LLM 调用次数。 */
  requestCount: number;
  /** 审计记录（与 requestCount 等长）。 */
  usage: AiUsageEntry[];
  /** 提前中止的原因（面向用户）；未中止为 null。 */
  abortedBy: string | null;
}

/**
 * 该错误码是否应当**提前中止**整轮分析（继续下去只是白烧请求）。
 *
 * `content` 不中止：它包含「模型名写错 / 参数被拒」这类可以换模块再试的情况，
 * 而且单模块失败不该连坐其它模块。
 *
 * @param code 归一化错误码
 * @returns 是否中止
 */
export function shouldAbortAnalysis(code: AiErrorCode | null): boolean {
  return code === 'auth' || code === 'network' || code === 'timeout'
    || code === 'rateLimit' || code === 'aborted' || code === 'unknown';
}

/**
 * 构造某个模块的分析消息。
 *
 * 统计摘要放在 payload（会被 JSON 序列化进 user 消息），
 * 「分析方向」放在备注位 —— 它是用户指令，不是数据。
 *
 * @param module 模块
 * @param focusIds 分析方向
 * @param projectName 项目名
 * @returns 聊天消息
 */
export function buildModuleMessages(
  module: ReportModule,
  focusIds: readonly AnalysisFocusId[],
  projectName: string,
): ChatMessage[] {
  const payload: Record<string, unknown> = {
    projectName,
    moduleTitle: module.title,
    moduleDataAvailable: module.unavailable === null,
    unavailableReason: module.unavailable,
    ...module.summary,
  };
  // 方向必须**按模块**过滤后再下发：把「过程稳定性」这类与计数模块无关的方向发过去，
  // 模型只能回一句「本模块是计数数据、没有 σ、无法判断是否受控」——
  // 这正是用户截图里「摘要未提供…」噪音的根因（请求发出去了，答案不可能有信息量）。
  const applicable = intersectFocus(focusIds, module.applicableFocus);
  const note = [
    focusInstructionText(applicable),
    `本模块的数据口径：${module.dataScope}`,
    '请只针对上面这一个模块输出分析，不要涉及其它模块；'
      + '只输出上面列出的分析方向，清单之外的方向不要提及，也不要用「摘要未提供」占位。',
  ].join('\n\n');
  return buildMessages('moduleAnalysis', payload, note);
}

/**
 * 逐模块执行 AI 分析。
 *
 * @param req 执行参数
 * @returns 分析结果
 */
export async function runReportAnalysis(
  req: RunReportAnalysisRequest,
): Promise<RunReportAnalysisResult> {
  const chat = req.chat ?? chatCompletion;
  const focusIds = normalizeFocusIds(req.focusIds);
  const modules = buildReportModules(req.model, req.extras);
  const analyzable = analyzableModules(modules);
  // 只对「本模块适用」的方向发请求：既不问计数数据要 σ，也不为不适用的方向白烧一次调用。
  const targets = analyzable.filter((m) => intersectFocus(focusIds, m.applicableFocus).length > 0);
  const skipped = modules.filter((m) => m.unavailable !== null);
  const focusSkipped = analyzable.filter(
    (m) => intersectFocus(focusIds, m.applicableFocus).length === 0,
  );

  const analyses: ModuleAnalysis[] = [];
  const usage: AiUsageEntry[] = [];
  let requestCount = 0;
  let abortedBy: string | null = null;

  const baseOptions: ChatCompletionOptions = {};
  if (Number.isFinite(req.maxTokens) && (req.maxTokens ?? 0) >= 1) {
    baseOptions.maxTokens = req.maxTokens;
  }
  if (req.disableThinking) {
    baseOptions.reasoningEffort = 'none';
  }
  if (req.signal) {
    baseOptions.signal = req.signal;
  }

  for (let i = 0; i < targets.length; i += 1) {
    const module = targets[i];
    req.onProgress?.({ done: i, total: targets.length, title: module.title });

    if (abortedBy !== null) {
      analyses.push({
        moduleId: module.id,
        title: module.title,
        markdown: '',
        ok: false,
        model: '',
        errorMessage: null,
        skipReason: `前序模块失败，已提前中止（${abortedBy}）`,
        sentFields: [],
      });
      continue;
    }

    const applicable = intersectFocus(focusIds, module.applicableFocus);
    const messages = buildModuleMessages(module, applicable, req.model.projectName);
    const sentFields = Object.keys({
      projectName: true,
      moduleTitle: true,
      moduleDataAvailable: true,
      unavailableReason: true,
      ...module.summary,
    });

    requestCount += 1;
    const response = await chat(req.aiConfig, messages, baseOptions);
    usage.push(buildUsageEntry('moduleAnalysis', 'summary', response.model, response.ok));

    const text = response.content.trim();
    if (response.ok && text.length > 0) {
      analyses.push({
        moduleId: module.id,
        title: module.title,
        markdown: text,
        ok: true,
        model: response.model,
        errorMessage: null,
        skipReason: null,
        sentFields,
      });
      continue;
    }

    const reason = response.ok
      ? '模型返回了空正文（可尝试调大「最大输出 tokens」后重试）'
      : response.errorMessage ?? '请求失败';
    analyses.push({
      moduleId: module.id,
      title: module.title,
      markdown: '',
      ok: false,
      model: response.model,
      errorMessage: reason,
      skipReason: null,
      sentFields,
    });

    if (shouldAbortAnalysis(response.errorCode)) {
      abortedBy = reason;
    }
  }

  for (const module of skipped) {
    analyses.push({
      moduleId: module.id,
      title: module.title,
      markdown: '',
      ok: false,
      model: '',
      errorMessage: null,
      skipReason: module.unavailable,
      sentFields: [],
    });
  }

  // 方向不适用的模块：**不发请求**（省一次调用），但在结果与导出文档里显式说明，
  // 让用户知道「不是没分析，是这类方向问不到这个模块的数据」。
  for (const module of focusSkipped) {
    analyses.push({
      moduleId: module.id,
      title: module.title,
      markdown: '',
      ok: false,
      model: '',
      errorMessage: null,
      skipReason:
        `所选分析方向（${focusLabels(focusIds).join('、')}）不适用于本模块：${module.dataScope}`,
      sentFields: [],
    });
  }

  req.onProgress?.({ done: targets.length, total: targets.length, title: '完成' });

  // 结果顺序固定为「报表模块顺序」，与界面/文档一致。
  const order = new Map(modules.map((m, i) => [m.id, i] as const));
  analyses.sort((a, b) => (order.get(a.moduleId) ?? 0) - (order.get(b.moduleId) ?? 0));

  return { analyses, requestCount, usage, abortedBy };
}

/** 供界面展示「本次发送的分析方向」。 */
export function describeFocuses(focusIds: readonly AnalysisFocusId[]): string {
  const labels = focusLabels(focusIds);
  return labels.length === 0 ? '未选择分析方向' : labels.join('、');
}
