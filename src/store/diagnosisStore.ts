/**
 * diagnosisStore —— 「AI 全面诊断」结果（第五轮需求 #12）。
 *
 * 出处：用户明确要求「诊断结果持久化（**不要 useState**）」。
 *
 * 为什么单独一个 store + 单键 localStorage，而不是塞进 `Project`：
 * 见 `@/services/ai/diagnosisReport` 的注释（schemaVersion 冻结，为一条 AI 文本
 * 升级 schema 的连带风险远大于收益）。本 store 的契约是：
 *   1. 结果**不在组件 state 里**，刷新 / 路由切换 / 重新挂载都不丢；
 *   2. 读取走 `sanitizeFullDiagnosis`，脏数据一律当「无记录」，绝不白屏；
 *   3. `clearFullDiagnosis` 会把「已清空」这一事实也落盘（写入 null），
 *      避免刷新后旧报告「复活」。
 *
 * 注意：归一化由注入的持久层完成（组合根用 `sanitizeFullDiagnosis` 构造
 * `LocalStorageJsonStore`），本 store 只持有已校验的数据。
 */

import { create } from 'zustand';
import type { FullDiagnosisRecord } from '@/services/ai/diagnosisReport';

/** 诊断结果持久化 key。 */
export const DIAGNOSIS_STORAGE_KEY = 'hogo-qa-diagnosis';

/** 最小持久化接口（UI 层注入实现，store 自身不碰浏览器 API）。 */
export interface DiagnosisPersistence {
  load: () => FullDiagnosisRecord | null;
  save: (record: FullDiagnosisRecord | null) => void;
}

interface DiagnosisState {
  /** 最近一次成功的全面诊断；无则 null。 */
  fullDiagnosis: FullDiagnosisRecord | null;
  /** 写入一条新诊断结果（调用方负责只在成功时调用）。 */
  setFullDiagnosis: (record: FullDiagnosisRecord) => void;
  /** 清除诊断结果（并落盘）。 */
  clearFullDiagnosis: () => void;
}

export const useDiagnosisStore = create<DiagnosisState>((set) => ({
  fullDiagnosis: null,
  setFullDiagnosis: (record) => set({ fullDiagnosis: record }),
  clearFullDiagnosis: () => set({ fullDiagnosis: null }),
}));

/**
 * 从持久化存储加载诊断结果（启动时调用）。
 *
 * @param persistence 持久化实现（可注入；null 表示不持久化）
 */
export function hydrateDiagnosis(persistence: DiagnosisPersistence | null): void {
  if (!persistence) {
    return;
  }
  const loaded = persistence.load();
  if (loaded) {
    useDiagnosisStore.getState().setFullDiagnosis(loaded);
  }
}

/**
 * 保存当前诊断结果到持久化存储。
 *
 * @param persistence 持久化实现
 */
export function persistDiagnosis(persistence: DiagnosisPersistence | null): void {
  if (!persistence) {
    return;
  }
  persistence.save(useDiagnosisStore.getState().fullDiagnosis);
}