/**
 * aiReportStore —— 「AI 分析导出」的状态（P4-B 新增）。
 *
 * 为什么放 store 而不是报表页的 useState：与 P3-B 的 AI 会话同因 ——
 * 报表页的 AI 分析要跑 N 次串行 LLM 调用（本地小模型可能几十秒），
 * 用户在等待期间切到别的页面是很自然的行为；若状态在组件里，
 * 切页会卸载组件、把已完成的模块分析全部丢掉，回来还得重跑一遍（既费时又费钱）。
 *
 * 刻意不落盘：分析正文是 AI 生成内容，刷新即清空（与 aiChatStore 同一口径）。
 */

import { create } from 'zustand';
import { DEFAULT_FOCUS_IDS, normalizeFocusIds, type AnalysisFocusId } from '@/services/ai/analysisFocus';
import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';

/** 分析状态机。 */
export type AiReportStatus = 'idle' | 'running' | 'done' | 'error';

interface AiReportState {
  /** 勾选的分析方向。 */
  focusIds: AnalysisFocusId[];
  status: AiReportStatus;
  /** 逐模块分析结果（顺序与报表模块一致）。 */
  analyses: ModuleAnalysis[];
  /** 结果对应的数据签名；与当前数据不一致时界面提示「结果对应的是旧数据」。 */
  signature: string | null;
  /** 进度：正在分析的模块名。 */
  progressTitle: string;
  /** 进度：已完成 / 总数。 */
  progressDone: number;
  progressTotal: number;
  /** 轮次级错误（例如整体中止）。 */
  error: string | null;
  /** 本次实际使用的模型名。 */
  model: string;

  toggleFocus: (id: AnalysisFocusId) => void;
  setFocusIds: (ids: readonly unknown[]) => void;
  startRun: (signature: string) => void;
  setProgress: (done: number, total: number, title: string) => void;
  finishRun: (signature: string, analyses: ModuleAnalysis[], model: string, error: string | null) => void;
  clear: () => void;
}

export const useAiReportStore = create<AiReportState>((set) => ({
  focusIds: [...DEFAULT_FOCUS_IDS],
  status: 'idle',
  analyses: [],
  signature: null,
  progressTitle: '',
  progressDone: 0,
  progressTotal: 0,
  error: null,
  model: '',

  toggleFocus: (id) =>
    set((s) => {
      // 至少保留一个方向：一个都不选时 prompt 里就没有分析约束，模型会自由发挥。
      const next = s.focusIds.includes(id)
        ? s.focusIds.filter((x) => x !== id)
        : normalizeFocusIds([...s.focusIds, id]);
      return next.length === 0 ? { focusIds: s.focusIds } : { focusIds: next };
    }),

  setFocusIds: (ids) => {
    const normalized = normalizeFocusIds(ids);
    set({ focusIds: normalized.length > 0 ? normalized : [...DEFAULT_FOCUS_IDS] });
  },

  startRun: (signature) =>
    set({
      status: 'running',
      signature,
      analyses: [],
      error: null,
      model: '',
      progressTitle: '',
      progressDone: 0,
      progressTotal: 0,
    }),

  setProgress: (done, total, title) =>
    set({ progressDone: done, progressTotal: total, progressTitle: title }),

  finishRun: (signature, analyses, model, error) =>
    set({
      status: error ? 'error' : 'done',
      signature,
      analyses,
      model,
      error,
      progressTitle: '',
    }),

  clear: () =>
    set({
      status: 'idle',
      analyses: [],
      signature: null,
      error: null,
      model: '',
      progressDone: 0,
      progressTotal: 0,
      progressTitle: '',
    }),
}));
