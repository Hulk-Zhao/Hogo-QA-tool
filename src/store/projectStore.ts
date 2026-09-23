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
import type { AiUsageEntry } from '@/services/ai/usageLog';
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

/** 审计记录持久化 key（跨会话保存 AI 调用审计，PRD P0-24）。 */
export const AI_USAGE_LOG_STORAGE_KEY = 'hogo-qa-ai-usage-logs';

/** 审计记录最多保留条数（防止 localStorage 无限增长；超出丢弃最旧）。 */
export const MAX_AI_USAGE_LOGS = 500;

/** 审计记录持久化窄接口（UI 层注入实现，store 自身不碰浏览器 API）。 */
export interface AiUsageLogPersistence {
  /** 读取并反序列化；缺失 / 损坏一律返回 null（不抛）。 */
  load: () => AiUsageEntry[] | null;
  /** 序列化并写入（失败由注入实现决定抛错或忽略）。 */
  save: (logs: AiUsageEntry[]) => void;
}

/**
 * 容错归一化审计记录数组。
 *
 * 处理三类脏数据（手动篡改 / 版本残留 / 字段缺失）：
 * - 非数组 → 返回 null，调用方视为「无历史」；
 * - 单条记录字段类型不符 → **丢弃该条**而非整份丢弃（其余合法记录继续可用）；
 * - 超出条数上限 → 只保留最新 `MAX_AI_USAGE_LOGS` 条。
 *
 * 纯函数：不触碰 DOM / 存储，可独立单测。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法记录数组；`raw` 非数组时返回 null
 */
export function sanitizeAiUsageLogs(raw: unknown): AiUsageEntry[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const out: AiUsageEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const r = item as Record<string, unknown>;
    const scope: AiUsageEntry['sentPayloadScope'] | null =
      r.sentPayloadScope === 'summary' ? 'summary' : r.sentPayloadScope === 'raw' ? 'raw' : null;
    if (
      typeof r.id !== 'string' ||
      r.id.length === 0 ||
      typeof r.feature !== 'string' ||
      scope === null ||
      typeof r.model !== 'string' ||
      typeof r.requestedAt !== 'string' ||
      typeof r.ok !== 'boolean'
    ) {
      continue;
    }
    out.push({
      id: r.id,
      feature: r.feature as AiUsageEntry['feature'],
      sentPayloadScope: scope,
      model: r.model,
      requestedAt: r.requestedAt,
      ok: r.ok,
      // 项目内审计记录带 projectId（schema.AiUsageLog）；存在则保真带回。
      ...(typeof r.projectId === 'string' ? { projectId: r.projectId } : {}),
    } as AiUsageEntry);
  }
  return out.slice(-MAX_AI_USAGE_LOGS);
}

/**
 * 合并两份审计记录（按 id 去重、按时间升序、截断到上限）。
 *
 * 语义要点：这是**并集**而非「后者覆盖前者」——审计记录是「本机向 AI 发送过
 * 哪些数据」的证据，任何一次合并都不允许丢证据。幂等（同一 id 重复合并不增长）。
 *
 * @param existing 已有记录
 * @param incoming 新并入的记录
 * @returns 合并后的记录（新的在后）
 */
export function mergeAiUsageLogs(
  existing: readonly AiUsageEntry[],
  incoming: readonly AiUsageEntry[],
): AiUsageEntry[] {
  const byId = new Map<string, AiUsageEntry>();
  for (const log of existing) {
    byId.set(log.id, log);
  }
  for (const log of incoming) {
    byId.set(log.id, log);
  }
  const merged = [...byId.values()].sort((a, b) =>
    a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0,
  );
  return merged.slice(-MAX_AI_USAGE_LOGS);
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
  /** AI 使用审计（会话内唯一真源；有 project 时同步镜像进去以便落盘）。 */
  aiUsageLogs: AiUsageEntry[];

  setProjectName: (name: string) => void;
  /** 追加一条 AI 使用审计记录（PRD P0-24）。 */
  appendAiUsageLog: (entry: AiUsageEntry) => void;
  /** 设置整个项目实体（加载 / 导入项目包时使用）。 */
  setProject: (project: Project) => void;
  selectCharacteristic: (id: string | null) => void;
  /**
   * 设置导入结果（由 importer 建模产出）。
   *
   * **每次调用都会新建一个项目实体**（id 唯一）：导入语义是「新项目」，
   * 不是「覆盖当前项目」（见 `setDataset` 实现注释）。
   */
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
  aiUsageLogs: [],

  setProjectName: (name) => set({ projectName: name }),

  setProject: (project) =>
    set((s) => ({
      project,
      projectName: project.name,
      dataset: project.datasets[0] ?? null,
      selectedCharacteristicId: project.datasets[0]?.characteristics[0]?.id ?? null,
      // 载入项目时把项目内审计记录**并入**设备级审计历史（按 id 去重 + 截断）。
      // 此前这里是整份替换：只要打开一个 aiUsageLogs 较短的项目，设备上已有的
      // 审计证据就被抹掉（刷新后设置页审计表变空）——审计必须只增不减。
      aiUsageLogs: mergeAiUsageLogs(s.aiUsageLogs, project.aiUsageLogs),
    })),

  /**
   * 追加一条 AI 使用审计记录。
   *
   * 背景（本轮发现的第二处「接线类缺陷」）：`buildUsageEntry` 早已实现并在
   * AI 助手中被调用，但**返回值被直接丢弃**，从未写入任何地方 —— 于是设置页的
   * 「AI 使用审计」表永远是空的，PRD P0-24 的数据主权承诺在 UI 上不可验证。
   *
   * 本动作同时更新切片与 `project.aiUsageLogs`：前者驱动 UI，后者随项目落盘；
   * `project` 为 null（未建项目）时只更新切片，不阻断 AI 请求。
   */
  appendAiUsageLog: (entry) =>
    set((s) => {
      const aiUsageLogs = mergeAiUsageLogs(s.aiUsageLogs, [entry]);
      const current = s.project;
      if (!current) {
        return { aiUsageLogs };
      }
      return {
        aiUsageLogs,
        project: {
          ...current,
          aiUsageLogs: aiUsageLogs.map((log) => ({ ...log, projectId: current.id })),
          updatedAt: new Date().toISOString(),
        },
      };
    }),

  selectCharacteristic: (id) => set({ selectedCharacteristicId: id }),

  /**
   * 导入结果落库。
   *
   * **每次导入 = 一个新项目**：此前这里是「已有项目就复用 `s.project`」，
   * 而项目 id 又被硬编码成 `'local'`，于是第二次导入会**静默覆盖**第一个项目 ——
   * 「项目库」永远只可能有 1 条记录，用户看到的就是「不存在任何数据」。
   * 项目库是**项目集合**，覆盖语义在这里必然导致数据丢失，故改为新建。
   *
   * 项目名取数据集名（导入时即文件名/「粘贴数据」），避免项目库里堆满
   * 「未命名项目」而无法区分。`dataset.projectId` 同步改写为新项目 id，
   * 保证内存切片与落盘实体一致。
   */
  setDataset: (dataset) =>
    set((s) => {
      const project = buildProjectFromDataset(
        generateId('proj'),
        dataset.name.trim().length > 0 ? dataset.name : s.projectName,
        dataset,
      );
      return {
        dataset: { ...dataset, projectId: project.id },
        selectedCharacteristicId: dataset.characteristics[0]?.id ?? null,
        project,
        projectName: project.name,
      };
    }),

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
 * 从持久化存储加载审计记录（启动时调用）。
 *
 * 需求出处（本轮 P1）：审计记录此前只存在于 `projectStore` 内存切片里，
 * **刷新即清空**（实测 reload 后设置页「AI 使用审计」表为空），
 * PRD P0-24 的「每次请求可审计」承诺无法在跨会话场景下验证。
 *
 * @param persistence 持久化实现（可注入；null 表示不持久化）
 */
export function hydrateAiUsageLogs(persistence: AiUsageLogPersistence | null): void {
  if (!persistence) {
    return;
  }
  const loaded = persistence.load();
  if (!loaded) {
    return;
  }
  const current = useProjectStore.getState().aiUsageLogs;
  useProjectStore.setState({ aiUsageLogs: mergeAiUsageLogs(current, loaded) });
}

/**
 * 保存当前审计记录到持久化存储。
 *
 * @param persistence 持久化实现
 */
export function persistAiUsageLogs(persistence: AiUsageLogPersistence | null): void {
  if (!persistence) {
    return;
  }
  persistence.save(useProjectStore.getState().aiUsageLogs);
}

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
