/**
 * projectStore —— 当前项目 / 数据集 / 特性 / 选择 / 导入动作。
 *
 * 出处：架构文档 §5。
 *
 * 本轮（T02/T03 对接）说明：
 * - 实体类型直接采用 `@/data/schema`（Project / Dataset / Characteristic / Measurement），
 *   与 data 层持久化实体一致，避免类型分叉。
 * - 导入解析由 `@/data/importer` 提供（`ImportPage` 调用），store 只承接建模结果。
 * - 持久化由 `@/data/repositories` 的 `ProjectRepository` 负责（见 useProjectPersistence）。
 * - 对外 API（dataset / projectName / setDataset / selectedCharacteristicId / findCharacteristic /
 *   generateId 等）保持不变，避免影响 T03 已验收的页面与测试。
 */

import { create } from 'zustand';
import type { Characteristic, Dataset, Measurement, Project } from '@/data/schema';
import { CURRENT_SCHEMA_VERSION } from '@/data/schema';

/** 导入解析的中间行（来自文件或粘贴文本）。 */
export interface ParsedRow {
  /** 原始行号（从 1 开始，供错误定位）。 */
  lineNumber: number;
  /** 行内容（按列拆分的字符串数组）。 */
  cells: string[];
}

/** 列映射：数据列 → 语义字段。 */
export interface ColumnMapping {
  /** 关键列索引：特性名（旧格式「物料名称」）。 */
  characteristicColumn: number;
  /** 测量值列索引。 */
  valueColumn: number;
  /** 子组列索引（-1 表示无）。 */
  subgroupColumn: number;
}

/** 导入校验结果统计（P0-15）。 */
export interface ImportValidation {
  /** 特性数。 */
  characteristicCount: number;
  /** 有效测量数。 */
  measurementCount: number;
  /** 缺陷类型数（旧格式 defect sheet 解析出）。 */
  defectTypeCount: number;
  /** 剔除的空值数。 */
  nullCount: number;
}

/** 一次导入的解析产物。 */
export interface ImportResult {
  fileName: string;
  rawFileName: string;
  sourceType: Dataset['sourceType'];
  /** 表头（可选，粘贴文本可能无表头）。 */
  header: string[];
  rows: ParsedRow[];
  /** 旧格式免改列名识别出的固定映射；为 null 表示需人工映射。 */
  autoMapping: ColumnMapping | null;
  /** 是否为旧工具双 sheet 格式（dimension/defect）。 */
  legacyFormat: boolean;
}

/** 被标注的异常值（P0-14：标注 → 人工勾选确认两步）。 */
export interface OutlierCandidate {
  /** 对应 measurements 数组下标。 */
  index: number;
  method: 'grubbs' | 'iqr';
  statistic: number;
  threshold: number;
  /** 用户是否确认排除（默认 false）。 */
  confirmed: boolean;
}

interface ProjectState {
  /** 当前项目实体（含 datasets / analysisConfigs / aiUsageLogs）。 */
  project: Project | null;
  /** 当前项目名（T05 项目库可重命名）。 */
  projectName: string;
  /** 当前数据集（首期单一数据集）。 */
  dataset: Dataset | null;
  /** 当前选中的特性 id。 */
  selectedCharacteristicId: string | null;

  setProjectName: (name: string) => void;
  /** 设置整个项目实体（加载 / 导入项目包时使用）。 */
  setProject: (project: Project) => void;
  selectCharacteristic: (id: string | null) => void;
  /** 设置导入结果（由 importer 建模产出）。 */
  setDataset: (dataset: Dataset) => void;
  clearDataset: () => void;
  /** 更新特性的异常值标注与确认。 */
  updateOutlierFlags: (characteristicId: string, flags: OutlierCandidate[]) => void;
  /** 更新测量值的排除标记（P0-14 勾选确认后）。 */
  setMeasurementsExcluded: (characteristicId: string, excludedIndices: number[]) => void;
}

/**
 * 生成一个简易唯一 id（不依赖 crypto，兼容离线与测试环境）。
 *
 * @param prefix id 前缀
 * @returns 唯一 id 字符串
 */
export function generateId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
}

/**
 * 由当前 dataset 构造一个最小可用 Project 实体（供持久化）。
 *
 * @param projectId 项目 id
 * @param name 项目名
 * @param dataset 数据集
 * @returns Project 实体
 */
export function buildProjectFromDataset(
  projectId: string,
  name: string,
  dataset: Dataset | null,
): Project {
  const now = new Date().toISOString();
  const datasets: Dataset[] = dataset ? [{ ...dataset, projectId }] : [];
  return {
    id: projectId,
    name,
    description: '',
    createdAt: now,
    updatedAt: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets,
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

export const useProjectStore = create<ProjectState>((set) => ({
  project: null,
  projectName: '未命名项目',
  dataset: null,
  selectedCharacteristicId: null,

  setProjectName: (name) => set({ projectName: name }),

  setProject: (project) =>
    set({
      project,
      projectName: project.name,
      dataset: project.datasets[0] ?? null,
      selectedCharacteristicId: project.datasets[0]?.characteristics[0]?.id ?? null,
    }),

  selectCharacteristic: (id) => set({ selectedCharacteristicId: id }),

  setDataset: (dataset) =>
    set((s) => ({
      dataset,
      selectedCharacteristicId: dataset.characteristics[0]?.id ?? null,
      // 同步更新当前项目实体的 datasets（若已有项目）。
      project: s.project
        ? { ...s.project, datasets: [dataset], updatedAt: new Date().toISOString() }
        : buildProjectFromDataset('local', s.projectName, dataset),
    })),

  clearDataset: () => set({ dataset: null, selectedCharacteristicId: null }),

  updateOutlierFlags: (characteristicId, flags) =>
    set((s) => {
      if (!s.dataset) {
        return s;
      }
      const characteristics = s.dataset.characteristics.map((c) =>
        c.id === characteristicId
          ? {
              ...c,
              outlierFlags: flags.map((f) => ({
                measurementId: c.measurements[f.index]?.id ?? `idx-${f.index}`,
                method: f.method,
                statistic: f.statistic,
                threshold: f.threshold,
                confirmed: f.confirmed,
              })),
            }
          : c,
      );
      return { dataset: { ...s.dataset, characteristics } };
    }),

  setMeasurementsExcluded: (characteristicId, excludedIndices) =>
    set((s) => {
      if (!s.dataset) {
        return s;
      }
      const excludedSet = new Set(excludedIndices);
      const characteristics = s.dataset.characteristics.map((c) => {
        if (c.id !== characteristicId) {
          return c;
        }
        const measurements: Measurement[] = c.measurements.map((m, index) => ({
          ...m,
          excluded: excludedSet.has(index),
          excludeReason: excludedSet.has(index) ? '用户确认异常值' : null,
        }));
        return { ...c, measurements };
      });
      return { dataset: { ...s.dataset, characteristics } };
    }),
}));

/**
 * 从当前 dataset 中取出选中的特性。
 *
 * @param dataset 数据集
 * @param id 特性 id
 * @returns 特性；未找到返回 null
 */
export function findCharacteristic(
  dataset: Dataset | null,
  id: string | null,
): Characteristic | null {
  if (!dataset || !id) {
    return null;
  }
  return dataset.characteristics.find((c) => c.id === id) ?? null;
}
