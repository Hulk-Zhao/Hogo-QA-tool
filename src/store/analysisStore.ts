/**
 * analysisStore —— 子组配置、sigmaMode、异常值方法、分析结果缓存。
 *
 * 出处：架构文档 §5、PRD P0-12/P0-13/P0-14。
 *
 * 关键交互（P0-14）：异常值处理是「标注 → 人工勾选确认」两步：
 *   1. `detectOutliersFor()` —— 调用 core.detectOutliers 得到候选（confirmed=false）；
 *   2. `toggleOutlierSelection()` —— 用户在表格中勾选，改变 confirmed；
 *   3. `applyOutlierExclusions()` —— 把已确认项写入 projectStore（真正排除）。
 * 任何一步都不自动删除数据；用户可随时 `resetOutliers()` 撤销。
 */

import { create } from 'zustand';
import { detectOutliers } from '@/core';
import type { SubgroupMode } from '@/core';
import type { OutlierCandidate } from './projectStore';

/** 单双侧规格编辑态（能力页配置卡用）。 */
export interface SpecEditorState {
  usl: number | null;
  lsl: number | null;
  target: number | null;
  unit: string;
}

interface AnalysisState {
  /** 子组容量（默认 n=5，PRD P0-12）。 */
  subgroupCapacity: number;
  /** 子组划分方式。 */
  subgroupMode: SubgroupMode;
  /** 手动子组边界（manual 模式）。 */
  manualBoundaries: number[];
  /** 组内 σ 估计法。 */
  sigmaMode: 'R' | 'S';
  /** 异常值识别方法（默认 grubbs，§0.2 #3）。 */
  outlierMethod: 'grubbs' | 'iqr';
  /** 异常值候选（含用户勾选状态）。 */
  outlierCandidates: OutlierCandidate[];
  /** 规格限编辑态。 */
  spec: SpecEditorState;

  setSubgroupCapacity: (capacity: number) => void;
  setSubgroupMode: (mode: SubgroupMode) => void;
  setManualBoundaries: (boundaries: number[]) => void;
  setSigmaMode: (mode: 'R' | 'S') => void;
  setOutlierMethod: (method: 'grubbs' | 'iqr') => void;
  /** 步骤 1：标注（不删除）。 */
  detectOutliersFor: (values: number[]) => void;
  /** 步骤 2：勾选 / 取消勾选某一候选。 */
  toggleOutlierSelection: (index: number) => void;
  /** 步骤 2b：批量设置勾选。 */
  setAllOutlierConfirmed: (confirmed: boolean) => void;
  /** 返回当前已确认排除的下标数组（供写入 projectStore）。 */
  confirmedExcludedIndices: () => number[];
  /** 撤销：清空候选与勾选。 */
  resetOutliers: () => void;
  setSpec: (spec: Partial<SpecEditorState>) => void;
}

const DEFAULT_CAPACITY = 5;

export const useAnalysisStore = create<AnalysisState>((set, get) => ({
  subgroupCapacity: DEFAULT_CAPACITY,
  subgroupMode: 'fixed',
  manualBoundaries: [],
  sigmaMode: 'R',
  outlierMethod: 'grubbs',
  outlierCandidates: [],
  spec: { usl: null, lsl: null, target: null, unit: 'mm' },

  setSubgroupCapacity: (capacity) =>
    set({ subgroupCapacity: Math.max(2, Math.min(25, Math.floor(capacity) || DEFAULT_CAPACITY)) }),
  setSubgroupMode: (mode) => set({ subgroupMode: mode }),
  setManualBoundaries: (boundaries) => set({ manualBoundaries: [...boundaries] }),
  setSigmaMode: (mode) => set({ sigmaMode: mode }),
  setOutlierMethod: (method) => set({ outlierMethod: method }),

  detectOutliersFor: (values) => {
    const method = get().outlierMethod;
    const flags = detectOutliers(values, method);
    const candidates: OutlierCandidate[] = flags.map((f) => ({
      index: f.index,
      method: f.method,
      statistic: f.statistic,
      threshold: f.threshold,
      // 重新标注时保留用户已确认的选择（按 index 匹配）。
      confirmed: get().outlierCandidates.find((c) => c.index === f.index)?.confirmed ?? false,
    }));
    set({ outlierCandidates: candidates });
  },

  toggleOutlierSelection: (index) =>
    set((s) => ({
      outlierCandidates: s.outlierCandidates.map((c) =>
        c.index === index ? { ...c, confirmed: !c.confirmed } : c,
      ),
    })),

  setAllOutlierConfirmed: (confirmed) =>
    set((s) => ({
      outlierCandidates: s.outlierCandidates.map((c) => ({ ...c, confirmed })),
    })),

  confirmedExcludedIndices: () =>
    get()
      .outlierCandidates.filter((c) => c.confirmed)
      .map((c) => c.index),

  resetOutliers: () => set({ outlierCandidates: [] }),

  setSpec: (spec) => set((s) => ({ spec: { ...s.spec, ...spec } })),
}));
