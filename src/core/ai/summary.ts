/**
 * 由分析结果构造「可发送摘要」（供 services 层使用）。
 *
 * 数据主权边界：本模块只输出统计摘要，**绝不包含逐条原始测量值**。
 * 出处：架构文档 §8.2 / PRD §6.3。
 */

import type {
  CapabilityResult,
  ChartType,
  ControlChartSeries,
  RuleViolation,
} from '../types';

/** 图表摘要（禁止含逐条原始值）。 */
export interface ChartSummaryInput {
  characteristicName: string;
  chartType: ChartType;
  centerLine: number;
  ucl: number;
  lcl: number;
  sigma: number;
  violations: { ruleId: string; message: string; windowStart: number }[];
  capability: { cp: number | null; cpk: number | null; pp: number | null; ppk: number | null };
}

/** 能力摘要。 */
export interface CapabilitySummaryInput {
  characteristicName: string;
  n: number;
  mean: number;
  sigmaWithin: number;
  sigmaOverall: number;
  ca: number | null;
  cp: number | null;
  cpk: number | null;
  pp: number | null;
  ppk: number | null;
  sigmaLevelShort: number | null;
  sigmaLevelBench: number | null;
  ppmOverall: number | null;
  ppmWithin: number | null;
  warnings: string[];
  spec: { usl: number | null; lsl: number | null; target: number | null; unit: string };
}

/**
 * 构造控制图摘要。
 *
 * @param series 控制图序列
 * @param capability 能力结果（可为 null，此时指数全为 null）
 * @param violations 违规列表
 * @param characteristicName 特性名
 */
export function buildChartSummary(
  series: ControlChartSeries,
  capability: CapabilityResult | null,
  violations: RuleViolation[],
  characteristicName = '',
): ChartSummaryInput {
  const primary = series.limits.primary;
  const findValue = (label: string): number => {
    const line = primary.find((l) => l.label === label);
    return line ? line.values[0] : Number.NaN;
  };

  return {
    characteristicName,
    chartType: series.selectedType,
    centerLine: findValue('CL'),
    ucl: findValue('UCL'),
    lcl: findValue('LCL'),
    sigma: series.sigmaZones?.oneSigma ?? Number.NaN,
    violations: violations.map((v) => ({
      ruleId: v.ruleId,
      message: v.message,
      windowStart: v.windowStart,
    })),
    capability: {
      cp: capability?.cp ?? null,
      cpk: capability?.cpk ?? null,
      pp: capability?.pp ?? null,
      ppk: capability?.ppk ?? null,
    },
  };
}

/**
 * 构造能力摘要。
 */
export function buildCapabilitySummary(
  result: CapabilityResult,
  characteristicName = '',
): CapabilitySummaryInput {
  return {
    characteristicName,
    n: result.n,
    mean: result.mean,
    sigmaWithin: result.sigma.within,
    sigmaOverall: result.sigma.overall,
    ca: result.ca,
    cp: result.cp,
    cpk: result.cpk,
    pp: result.pp,
    ppk: result.ppk,
    sigmaLevelShort: result.sigmaLevelShort,
    sigmaLevelBench: result.sigmaLevelBench,
    ppmOverall: result.ppmOverall,
    ppmWithin: result.ppmWithin,
    warnings: [...result.warnings],
    spec: {
      usl: result.spec.usl,
      lsl: result.spec.lsl,
      target: result.spec.target,
      unit: result.spec.unit,
    },
  };
}
