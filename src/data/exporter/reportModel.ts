/**
 * reportModel：报表中间模型。
 *
 * 由当前项目数据构造「报表行」，供 excelReport（XLSX 写出）与
 * 打印/PDF 视图共用。中间模型是纯数据（不含 DOM / SheetJS），
 * 便于单测校验。
 *
 * 出处：架构文档 §2.5、§4.1；PRD P0-18（Excel ≥4 sheet：
 * CPK汇总 / 不良统计 / 原始尺寸 / 原始不良）。
 */

import type { CapabilityResult, ParetoItem } from '../../core/types';
import { buildPareto } from '../../core/pareto/pareto';
import { computeCapability } from '../../core/stats/capability';
import { buildSubgroups } from '../../core/stats/subgrouping';
import type { Characteristic, Dataset, Project } from '../schema';

/** CPK 汇总行（sheet1）。 */
export interface CpKSummaryRow {
  characteristic: string;
  n: number;
  mean: number;
  sigmaWithin: number;
  sigmaOverall: number;
  usl: number | null;
  lsl: number | null;
  ca: number | null;
  cp: number | null;
  cpk: number | null;
  pp: number | null;
  ppk: number | null;
  /** 3*Cpk（短期）。 */
  sigmaLevelShort: number | null;
  /** 3*Cpk + 1.5（工程口径）。 */
  sigmaLevelBench: number | null;
  ppmOverall: number | null;
}

/** 不良统计行（sheet2）。 */
export interface DefectStatRow {
  defectType: string;
  count: number;
  /** 占比 %（2 位小数）。 */
  ratio: number;
  /** 累计占比 %（2 位小数）。 */
  cumRatio: number;
}

/** 原始尺寸行（sheet3）。 */
export interface RawDimensionRow {
  characteristic: string;
  index: number;
  value: number;
  usl: number | null;
  lsl: number | null;
}

/** 原始不良行（sheet4）。 */
export interface RawDefectRow {
  defectType: string;
  count: number;
  category: string;
}

/** 报表完整中间模型。 */
export interface ReportModel {
  projectName: string;
  generatedAt: string;
  cpkSummary: CpKSummaryRow[];
  defectStats: DefectStatRow[];
  rawDimensions: RawDimensionRow[];
  rawDefects: RawDefectRow[];
  warnings: string[];
}

/** 默认子组容量（与 AnalysisConfig 默认一致）。 */
const DEFAULT_SUBGROUP_CAPACITY = 5;

/** 对单个特性计算能力结果。 */
function capabilityFor(characteristic: Characteristic): CapabilityResult {
  const values = characteristic.measurements
    .filter((m) => m.excluded !== true)
    .map((m) => m.value);
  const subgroups = buildSubgroups(
    characteristic.measurements.map((m) => ({
      id: m.id,
      value: m.value,
      ...(m.subgroupId !== null ? { subgroupId: m.subgroupId } : {}),
      excluded: m.excluded,
    })),
    { mode: 'fixed', capacity: DEFAULT_SUBGROUP_CAPACITY },
  );
  return computeCapability(values, characteristic.specLimits, subgroups, {
    useImrFallback: true,
  });
}

/** 由数据集构造 CPK 汇总行。 */
export function buildCpkSummary(dataset: Dataset): CpKSummaryRow[] {
  const rows: CpKSummaryRow[] = [];
  for (const c of dataset.characteristics) {
    if (c.measurements.length === 0) {
      continue;
    }
    const cap = capabilityFor(c);
    rows.push({
      characteristic: c.name,
      n: cap.n,
      mean: cap.mean,
      sigmaWithin: cap.sigma.within,
      sigmaOverall: cap.sigma.overall,
      usl: c.specLimits.usl,
      lsl: c.specLimits.lsl,
      ca: cap.ca,
      cp: cap.cp,
      cpk: cap.cpk,
      pp: cap.pp,
      ppk: cap.ppk,
      sigmaLevelShort: cap.sigmaLevelShort,
      sigmaLevelBench: cap.sigmaLevelBench,
      ppmOverall: cap.ppmOverall,
    });
  }
  return rows;
}

/** 由数据集构造不良统计行（柏拉图口径）。 */
export function buildDefectStats(dataset: Dataset): DefectStatRow[] {
  const result = buildPareto(
    dataset.defectRecords.map((d) => ({
      defectType: d.defectType,
      count: d.count,
      category: d.category,
    })),
    80,
    '其他',
    0,
  );
  return result.items.map((it: ParetoItem) => ({
    defectType: it.defectType,
    count: it.count,
    ratio: it.ratio,
    cumRatio: it.cumRatio,
  }));
}

/** 由数据集构造原始尺寸行。 */
export function buildRawDimensions(dataset: Dataset): RawDimensionRow[] {
  const rows: RawDimensionRow[] = [];
  for (const c of dataset.characteristics) {
    c.measurements.forEach((m, idx) => {
      rows.push({
        characteristic: c.name,
        index: idx + 1,
        value: m.value,
        usl: c.specLimits.usl,
        lsl: c.specLimits.lsl,
      });
    });
  }
  return rows;
}

/** 由数据集构造原始不良行。 */
export function buildRawDefects(dataset: Dataset): RawDefectRow[] {
  return dataset.defectRecords.map((d) => ({
    defectType: d.defectType,
    count: d.count,
    category: d.category ?? '',
  }));
}

/**
 * 由项目构造报表中间模型。
 *
 * @param project 项目
 * @param datasetId 指定数据集；缺省使用第一个数据集
 * @throws {Error} 项目无数据集
 */
export function buildReportModel(project: Project, datasetId?: string): ReportModel {
  const dataset =
    datasetId !== undefined
      ? project.datasets.find((d) => d.id === datasetId)
      : project.datasets[0];
  if (!dataset) {
    throw new Error('项目不含任何数据集，无法生成报表。');
  }
  const warnings: string[] = [];
  const cpkSummary = buildCpkSummary(dataset);
  const defectStats = buildDefectStats(dataset);
  if (cpkSummary.length === 0) {
    warnings.push('数据集不含有效测量值，CPK 汇总为空。');
  }
  if (defectStats.length === 0) {
    warnings.push('数据集不含不良记录，不良统计为空。');
  }
  return {
    projectName: project.name,
    generatedAt: new Date().toISOString(),
    cpkSummary,
    defectStats,
    rawDimensions: buildRawDimensions(dataset),
    rawDefects: buildRawDefects(dataset),
    warnings,
  };
}
