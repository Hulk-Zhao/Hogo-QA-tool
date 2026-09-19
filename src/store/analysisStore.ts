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
  /** 规格限编辑态（**有效值**：未覆盖时 = 所选特性导入的规格限）。 */
  spec: SpecEditorState;
  /**
   * 规格限是否被用户**手动改过**。
   *
   * false = 跟随所选特性的 `specLimits`（导入的 USL/LSL/target/unit 自动预填）；
   * true  = 用户显式输入过，任何自动预填都不得覆盖。
   *
   * 缺陷背景（本轮 P2，已在真实浏览器复现）：导入带 USL/LSL 的 CSV 后，
   * 能力页规格限为空、Cp/Cpk 全显示 N/A（提示「仅提供单侧规格…」），
   * 而同一份数据在报表页却能算出 Cpk=3.65 —— 因为能力页的 `spec` 从未与
   * `characteristic.specLimits` 同步，用户必须重新手输文件里已经有的规格限。
   */
  specOverridden: boolean;

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
  /**
   * 用某特性「导入的规格限」填充编辑态，并把「已覆盖」标记复位为 false。
   *
   * @param limits 特性的规格限（specLimits）
   */
  applyCharacteristicSpec: (limits: SpecEditorState) => void;
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
  specOverridden: false,

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

  // 用户手动改任意字段 → 标记为「已覆盖」，后续自动预填不再动它（用户意图优先）。
  setSpec: (spec) => set((s) => ({ spec: { ...s.spec, ...spec }, specOverridden: true })),

  applyCharacteristicSpec: (limits) =>
    set({
      spec: {
        usl: limits.usl,
        lsl: limits.lsl,
        target: limits.target,
        unit: limits.unit || 'mm',
      },
      specOverridden: false,
    }),
}));
