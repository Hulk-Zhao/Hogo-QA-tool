/**
 * selectors —— 派生选择器（含 memo 计算入口）。
 *
 * 出处：架构文档 §5「派生计算」。所有重计算都在此调用 core，
 * UI 组件只读结果。memo 按 `(characteristicId, configHash)` 缓存，
 * 避免每次渲染重算。
 */

import {
  buildSubgroups,
  computeCapability,
  testNormality,
  buildHistogram,
  type CapabilityResult,
  type HistogramResult,
  type MeasurementInput,
  type SpecLimits,
  type SubgroupConfig,
  type SubgroupStats,
} from '@/core';
import type { NormalityTestBundle } from '@/core';
import type { Characteristic } from '@/data/schema';
import type { SpecEditorState } from './analysisStore';

/** 能力页所需的完整分析结果包。 */
export interface CapabilityAnalysis {
  /** 参与计算的（未排除）值。 */
  values: number[];
  subgroups: SubgroupStats[];
  capability: CapabilityResult;
  normality: NormalityTestBundle;
  histogram: HistogramResult;
}

/** 缓存键所需的配置指纹。 */
export interface AnalysisConfigFingerprint {
  subgroupMode: SubgroupConfig['mode'];
  subgroupCapacity: number;
  manualBoundaries: number[];
  sigmaMode: 'R' | 'S';
  spec: SpecEditorState;
}

/**
 * 把特性实体转换为 core 的 MeasurementInput[]。
 *
 * @param characteristic 领域特性
 * @returns 测量输入数组（保留 excluded 标记，由 core 过滤）
 */
export function toMeasurementInputs(characteristic: Characteristic): MeasurementInput[] {
  return characteristic.measurements.map((m) => ({
    id: m.id,
    value: m.value,
    subgroupId: m.subgroupId ?? undefined,
    excluded: m.excluded,
  }));
}

/**
 * 构造子组划分配置。
 *
 * @param fingerprint 分析配置指纹
 * @param measurementCount 测量数（manual 模式校验用）
 * @returns SubgroupConfig
 */
export function buildSubgroupConfig(
  fingerprint: AnalysisConfigFingerprint,
  measurementCount: number,
): SubgroupConfig {
  if (fingerprint.subgroupMode === 'manual') {
    const boundaries =
      fingerprint.manualBoundaries.length > 0
        ? fingerprint.manualBoundaries
        : manualBoundariesFromCapacity(measurementCount, fingerprint.subgroupCapacity);
    return { mode: 'manual', manualBoundaries: boundaries };
  }
  return { mode: 'fixed', capacity: fingerprint.subgroupCapacity };
}

/**
 * 当用户在 manual 模式但未显式给边界时，按容量推导默认边界。
 *
 * @param count 测量数
 * @param capacity 子组容量
 * @returns 升序起始索引数组
 */
export function manualBoundariesFromCapacity(count: number, capacity: number): number[] {
  const c = Math.max(2, Math.floor(capacity) || 5);
  const boundaries: number[] = [];
  for (let i = 0; i < count; i += c) {
    boundaries.push(i);
  }
  return boundaries.length > 0 ? boundaries : [0];
}

/**
 * 计算配置指纹的稳定字符串键。
 *
 * @param fp 配置指纹
 * @returns 字符串键
 */
export function fingerprintKey(fp: AnalysisConfigFingerprint, characteristicVersion: number): string {
  return [
    fp.subgroupMode,
    fp.subgroupCapacity,
    fp.manualBoundaries.join(','),
    fp.sigmaMode,
    fp.spec.usl ?? 'x',
    fp.spec.lsl ?? 'x',
    fp.spec.target ?? 'x',
    characteristicVersion,
  ].join('|');
}

/** 单条 memo 缓存。 */
interface CacheEntry {
  key: string;
  value: CapabilityAnalysis;
}

let capabilityCache: CacheEntry | null = null;

/**
 * 计算能力分析（带 memo）。
 *
 * 出处：架构文档 §5。内部调用 core 的 buildSubgroups / computeCapability /
 * testNormality / buildHistogram。**不在此处做任何舍入**（舍入在展示层）。
 *
 * @param characteristic 领域特性
 * @param fingerprint 分析配置指纹
 * @returns 完整分析结果包；若特性为空返回 null
 */
export function selectCapability(
  characteristic: Characteristic | null,
  fingerprint: AnalysisConfigFingerprint,
): CapabilityAnalysis | null {
  if (!characteristic) {
    return null;
  }

  // 特性内容版本：以测量数 + 排除数 + 首末值近似，避免深比较开销。
  const excluded = characteristic.measurements.filter((m) => m.excluded).length;
  const version =
    characteristic.measurements.length * 1000 + excluded * 10 + (characteristic.nullCount ?? 0);
  const key = fingerprintKey(fingerprint, version);

  if (capabilityCache && capabilityCache.key === key) {
    return capabilityCache.value;
  }

  const activeValues = characteristic.measurements
    .filter((m) => !m.excluded)
    .map((m) => m.value)
    .filter((v) => Number.isFinite(v));

  const measurements = toMeasurementInputs(characteristic);
  const subgroupConfig = buildSubgroupConfig(fingerprint, measurements.length);

  let subgroups: SubgroupStats[] = [];
  try {
    subgroups = buildSubgroups(measurements, subgroupConfig);
  } catch {
    // 子组划分失败（如容量越界）：退化为无子组结构。
    subgroups = [];
  }

  const spec: SpecLimits = {
    usl: fingerprint.spec.usl,
    lsl: fingerprint.spec.lsl,
    target: fingerprint.spec.target,
    unit: fingerprint.spec.unit,
  };

  let capability: CapabilityResult;
  try {
    capability = computeCapability(activeValues, spec, subgroups, {
      sigmaMode: fingerprint.sigmaMode,
      useImrFallback: true,
    });
  } catch {
    capability = emptyCapability(spec);
  }

  const normality = testNormality(activeValues);
  const histogram = buildHistogramSafe(activeValues);

  const value: CapabilityAnalysis = {
    values: activeValues,
    subgroups,
    capability,
    normality,
    histogram,
  };
  capabilityCache = { key, value };
  return value;
}

/**
 * 直方图安全封装：样本不足时返回空箱。
 *
 * @param values 数值数组
 * @returns HistogramResult
 */
function buildHistogramSafe(values: number[]): HistogramResult {
  if (values.length < 2) {
    return { bins: [], binWidth: 0, binCount: 0, rule: 'sturges' };
  }
  try {
    return buildHistogram(values, 'sturges');
  } catch {
    return { bins: [], binWidth: 0, binCount: 0, rule: 'sturges' };
  }
}

/**
 * 数据不足以计算能力时的空结果（全部指数为 null，附告警）。
 *
 * @param spec 规格限
 * @returns 空白 CapabilityResult
 */
function emptyCapability(spec: SpecLimits): CapabilityResult {
  return {
    n: 0,
    mean: 0,
    sigma: { mode: 'OVERALL', within: 0, overall: 0, basis: 'R' },
    spec,
    ca: null,
    cp: null,
    cpk: null,
    cpu: null,
    cpl: null,
    pp: null,
    ppk: null,
    ppu: null,
    ppl: null,
    sigmaLevelShort: null,
    sigmaLevelBench: null,
    ppmOverall: null,
    ppmWithin: null,
    warnings: ['INSUFFICIENT_SAMPLE'],
  };
}

/** 清空 memo 缓存（供测试与配置重大变更时调用）。 */
export function clearCapabilityCache(): void {
  capabilityCache = null;
}
