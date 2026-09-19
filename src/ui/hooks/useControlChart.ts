/**
 * useControlChart —— 控制图页数据装配 hook。
 *
 * 出处：架构文档 T04；§5「派生计算」；§9.2/§9.3（判异与去重）。
 *
 * 职责：
 *   1. 读取当前特性（@/store/projectStore）+ 分析配置（@/store/analysisStore）；
 *   2. 依子组配置构造 core 控制图序列（buildControlChart）；
 *   3. 依规则开关求值判异（evaluateRules）并去重（dedupeViolations）；
 *   4. 把「选中图型 / 规则开关 / 变限提示 / 违规列表」返回给页面。
 *
 * 设计约束：本 hook 只做「core 计算编排 + memo」，不渲染、不含 JSX。
 * 计数型控制图（P/NP/C/U）在缺少不良数据时返回 null（由页面给空状态）。
 */

import { useMemo } from 'react';
import {
  buildControlChart,
  buildSubgroups,
  dedupeViolations,
  evaluateRules,
  sigmaByPointOf,
  defaultToggleConfig,
  type AttributeInput,
  type ChartType,
  type ControlChartSeries,
  type RuleEvaluationResult,
  type RuleToggleConfig,
  type SubgroupStats,
} from '@/core';
import { findCharacteristic, useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';

/** 计量型图型。 */
const VARIABLES_TYPES: readonly ChartType[] = ['Xbar-R', 'Xbar-S', 'I-MR'];
/** 计数型图型。 */
const ATTRIBUTE_TYPES: readonly ChartType[] = ['P', 'NP', 'C', 'U'];

/** useControlChart 的产物。 */
export interface ControlChartState {
  /** 当前特性名；无特性时 null。 */
  characteristicName: string | null;
  /** 控制图序列；无法构造时 null。 */
  series: ControlChartSeries | null;
  /** 判异求值结果（已去重）；无序列时 null。 */
  evaluation: RuleEvaluationResult | null;
  /** 逐点 σ（变限 P/U 逐点不同）。 */
  sigmaByPoint: number[];
  /** 构造控制图时的错误信息；成功为 null。 */
  error: string | null;
  /** 用于构造的（未排除）测量值。 */
  values: number[];
}

/**
 * 依图型判断是否为计量型。
 *
 * @param type 图型
 * @returns 计量型返回 true
 */
export function isVariablesChart(type: ChartType): boolean {
  return VARIABLES_TYPES.includes(type);
}

/**
 * 依图型判断是否为计数型。
 *
 * @param type 图型
 * @returns 计数型返回 true
 */
export function isAttributeChart(type: ChartType): boolean {
  return ATTRIBUTE_TYPES.includes(type);
}

/**
 * 由（未排除）测量值构造子组统计（供计量型控制图）。
 *
 * @param values 有效测量值
 * @param capacity 子组容量
 * @returns 子组统计数组；容量越界或不足时返回空数组
 */
export function buildVariablesSubgroups(values: number[], capacity: number): SubgroupStats[] {
  if (values.length < capacity || capacity < 2) {
    return [];
  }
  const measurements = values.map((value, i) => ({ id: `m-${i}`, value }));
  try {
    return buildSubgroups(measurements, { mode: 'fixed', capacity });
  } catch {
    return [];
  }
}

/**
 * 计算控制图状态（纯函数，便于单测；不含 hook 依赖）。
 *
 * @param values 有效测量值
 * @param type 图型
 * @param capacity 子组容量
 * @param toggles 规则开关
 * @param attributeData 计数型输入（可选；缺省时计数型返回 error）
 * @returns 控制图状态
 */
export function computeControlChartState(
  values: number[],
  type: ChartType,
  capacity: number,
  toggles: RuleToggleConfig,
  attributeData?: AttributeInput,
): ControlChartState {
  let series: ControlChartSeries | null = null;
  let error: string | null = null;

  try {
    if (isVariablesChart(type)) {
      if (values.length === 0) {
        error = '无有效测量值。';
      } else if (type === 'I-MR') {
        series = buildControlChart('I-MR', { kind: 'imr', values });
      } else {
        const subgroups = buildVariablesSubgroups(values, capacity);
        if (subgroups.length === 0) {
          const need = capacity * 1;
          error = `子组容量 ${capacity} 下不足一个完整子组（需至少 ${need} 个测量值，当前 ${values.length} 个）。`;
        } else {
          series = buildControlChart(type, { kind: 'variables', subgroups });
        }
      }
    } else {
      // 计数型：无不良数据无法构造。
      if (!attributeData) {
        error = '计数型控制图需要「不良数 + 样本量」数据，当前数据集未提供。';
      } else {
        series = buildControlChart(type, { kind: 'attributes', data: attributeData });
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    series = null;
  }

  if (!series) {
    return {
      characteristicName: null,
      series: null,
      evaluation: null,
      sigmaByPoint: [],
      error: error ?? '无法构造控制图。',
      values,
    };
  }

  const sigmaByPoint = sigmaByPointOf(series);
  const evaluation = evaluateRules(series, sigmaByPoint, toggles);
  const deduped = dedupeViolations(evaluation.violations, true);

  return {
    characteristicName: null,
    series,
    evaluation: { ...evaluation, violations: deduped },
    sigmaByPoint,
    error: null,
    values,
  };
}

/**
 * 控制图数据装配 hook。
 *
 * @param type 选中的控制图类型
 * @param toggles 规则开关
 * @returns 控制图状态（含 series / evaluation / error）
 */
export function useControlChart(type: ChartType, toggles: RuleToggleConfig): ControlChartState {
  const dataset = useProjectStore((s) => s.dataset);
  const selectedId = useProjectStore((s) => s.selectedCharacteristicId);
  const capacity = useAnalysisStore((s) => s.subgroupCapacity);
  const manualBoundaries = useAnalysisStore((s) => s.manualBoundaries);
  const subgroupMode = useAnalysisStore((s) => s.subgroupMode);

  const characteristic = useMemo(
    () => findCharacteristic(dataset, selectedId),
    [dataset, selectedId],
  );

  const values = useMemo(
    () =>
      characteristic
        ? characteristic.measurements
            .filter((m) => !m.excluded)
            .map((m) => m.value)
            .filter((v) => Number.isFinite(v))
        : [],
    [characteristic],
  );

  const state = useMemo(
    () => computeControlChartState(values, type, capacity, toggles),
    // manualBoundaries / subgroupMode 参与子组划分的语义，但是否变化由 capacity 主导；
    // 显式列入依赖以保证配置变更时重算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [values, type, capacity, toggles, subgroupMode, manualBoundaries],
  );

  return { ...state, characteristicName: characteristic?.name ?? null };
}

/** 默认规则开关（转发 core，便于 UI 初始化）。 */
export { defaultToggleConfig };
