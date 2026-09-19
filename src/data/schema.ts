/**
 * 领域实体类型（持久化层），与 core 类型衔接。
 *
 * 出处：架构文档 §3.6、PRD §8。
 */

import type {
  DefectRecordInput,
  NelsonRuleId,
  SigmaMode,
  SpecLimits,
  SubgroupMode,
  WesternRuleId,
} from '../core/types';

/** 当前 schema 版本号。 */
export const CURRENT_SCHEMA_VERSION = 1;

export interface Project {
  id: string;
  name: string;
  description: string;
  /** ISO 8601 UTC */
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  datasets: Dataset[];
  analysisConfigs: AnalysisConfig[];
  aiUsageLogs: AiUsageLog[];
}

export interface Dataset {
  id: string;
  projectId: string;
  name: string;
  sourceType: 'xlsx' | 'csv' | 'json';
  importedAt: string;
  rawFileName: string;
  characteristics: Characteristic[];
  defectRecords: DefectRecord[];
}

export interface Characteristic {
  id: string;
  datasetId: string;
  /** 原「物料名称」 */
  name: string;
  specLimits: SpecLimits;
  measurements: Measurement[];
  subgroups: PersistedSubgroup[];
  nullCount: number;
  outlierFlags: OutlierFlag[];
  preprocessConfigRef: string | null;
  /** OPFS 引用；为空时 measurements 内联 */
  measurementBlobRef: string | null;
}

export interface Measurement {
  id: string;
  characteristicId: string;
  value: number;
  subgroupId: string | null;
  /** ISO 8601 */
  timestamp: string | null;
  batch: string | null;
  excluded: boolean;
  excludeReason: string | null;
}

export interface PersistedSubgroup {
  id: string;
  characteristicId: string;
  index: number;
  size: number;
  measurementIds: string[];
  mean: number;
  range: number;
  std: number;
}

export interface OutlierFlag {
  measurementId: string;
  method: 'grubbs' | 'iqr';
  statistic: number;
  threshold: number;
  /** 是否被用户确认排除 */
  confirmed: boolean;
}

export interface DefectRecord extends DefectRecordInput {
  id: string;
  datasetId: string;
}

export interface AnalysisConfig {
  id: string;
  projectId: string;
  name: string;
  /** default 5 */
  subgroupCapacity: number;
  subgroupMode: SubgroupMode;
  sigmaMode: SigmaMode;
  outlierMethod: 'grubbs' | 'iqr';
  outlierConfirmedIds: string[];
  weRules: Record<WesternRuleId, boolean>;
  nelsonRules: Record<NelsonRuleId, boolean>;
}

export interface AiUsageLog {
  id: string;
  projectId: string;
  feature: 'chartExplain' | 'capExplain' | 'suggest' | 'report' | 'qa';
  sentPayloadScope: 'summary' | 'raw';
  model: string;
  requestedAt: string;
  ok: boolean;
}

/** 项目摘要（项目库列表用）。 */
export interface ProjectSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  datasetCount: number;
  characteristicCount: number;
}
