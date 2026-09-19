/**
 * controlChartOption —— 控制图 ECharts option 的**纯函数**构造层。
 *
 * 出处：架构文档 T04「控制图页 + 判异准则 UI」；§9.2/§9.3（判异与去重）；
 * PRD P0-03~P0-06、P0-10。
 *
 * 设计动机（可测性）：
 *   ECharts 渲染依赖浏览器画布（jsdom 下无 canvas），难以在 node 环境
 *   直接断言渲染结果。因此把「数据 → option」这一步抽成**无副作用纯函数**
 *   集中于此模块，可在 node 环境直接断言 option 结构（7 种图 / 变限 /
 *   分区带 / 违规高亮），**绕开 jsdom 画布限制**。
 *
 * 本模块**不 import React / echarts-for-react**，仅依赖 core 类型与主题 token，
 * 因而归属 `src/ui/charts` 但可在纯 node 下 import 并测试。
 */

import type { ChartPoint, ControlChartSeries, ControlLine, RuleViolation } from '@/core';
import { chartThemeTokens } from '@/theme';

/** 违规高亮的严重级排序（高优先）。 */
const SEVERITY_ORDER: readonly RuleViolation['severity'][] = ['high', 'medium', 'low'];

/** 单点违规高亮描述（供 scatter 系列渲染）。 */
export interface ViolationMark {
  /** 点索引（0-based）。 */
  index: number;
  /** 横轴类目标签。 */
  xLabel: string;
  /** 该点主图纵值。 */
  value: number;
  /** 命中规则 id（去重后）。 */
  ruleIds: string[];
  /** 最高严重级。 */
  severity: RuleViolation['severity'];
  /** 高亮色。 */
  color: string;
}

/** 一条控制限的画图数据。 */
export interface LimitSeriesData {
  label: string;
  /** 逐点限值。 */
  values: number[];
  /** 是否为恒定限。 */
  isConstant: boolean;
  /** 是否画线（LCL 无定义时为 false）。 */
  visible: boolean;
}

/** 分区带（相对 CL 的 ±1σ / ±2σ）。 */
export interface SigmaZoneBands {
  /** 中心线值。 */
  centerLine: number;
  /** ±1σ 上下边界（恒定限时单值）。 */
  upper1: number[];
  lower1: number[];
  /** ±2σ 上下边界（恒定限时单值）。 */
  upper2: number[];
  lower2: number[];
  /** 是否可用（计量型主图才有）。 */
  enabled: boolean;
}

/** 单张主图（primary / secondary）的 option 片段。 */
export interface PanelOption {
  /** 面板名（'X̄' | 'R' | 'p' | ...）。 */
  name: string;
  /** 横轴类目。 */
  categories: string[];
  /** 主数据值。 */
  values: number[];
  /** 该面板的横轴名（子组号 / 样本号）。 */
  xAxisName: string;
  /** 该面板的纵轴名。 */
  yAxisName: string;
  /** 控制限序列（含 CL/UCL/LCL）。 */
  limits: LimitSeriesData[];
  /** 违规高亮点。 */
  violations: ViolationMark[];
  /** 分区带（仅主图且计量型有）。 */
  sigmaZones: SigmaZoneBands | null;
}

/** 控制图完整 option（主图 + 可选副图）。 */
export interface ControlChartOption {
  primary: PanelOption;
  secondary: PanelOption | null;
  /** 是否变限（P/U 逐点变限时 true，用于 UI 提示）。 */
  hasVariableLimits: boolean;
  /** 选中图型。 */
  selectedType: ControlChartSeries['selectedType'];
}

/**
 * 按最高严重级取高亮色。
 *
 * @param severity 严重级
 * @returns 十六进制颜色
 */
export function colorForSeverity(severity: RuleViolation['severity']): string {
  switch (severity) {
    case 'high':
      return chartThemeTokens.violationHigh;
    case 'medium':
      return chartThemeTokens.violationMedium;
    case 'low':
    default:
      return chartThemeTokens.violationLow;
  }
}

/**
 * 合并同一索引的多个违规，取最高严重级。
 *
 * @param violations 违规列表（已去重）
 * @returns index -> { ruleIds, severity }
 */
function collectViolationByIndex(
  violations: RuleViolation[],
): Map<number, { ruleIds: string[]; severity: RuleViolation['severity'] }> {
  const map = new Map<number, { ruleIds: string[]; severity: RuleViolation['severity'] }>();
  for (const v of violations) {
    for (const idx of v.pointIndices) {
      const existing = map.get(idx);
      if (!existing) {
        map.set(idx, { ruleIds: [v.ruleId], severity: v.severity });
        continue;
      }
      if (!existing.ruleIds.includes(v.ruleId)) {
        existing.ruleIds.push(v.ruleId);
      }
      // 取更高严重级。
      if (
        SEVERITY_ORDER.indexOf(v.severity) < SEVERITY_ORDER.indexOf(existing.severity)
      ) {
        existing.severity = v.severity;
      }
    }
  }
  return map;
}

/**
 * 把 core 的 ControlLine[] 转换为可画的限序列。
 *
 * @param lines 控制限数组
 * @param pointCount 点数量
 * @returns 画图用限序列
 */
function toLimitSeriesData(lines: ControlLine[] | undefined, pointCount: number): LimitSeriesData[] {
  if (!lines) {
    return [];
  }
  return lines.map((line) => {
    const first = line.values[0];
    // 空值 / 非有限数表示不画该线（如 R 图 n<7 时 LCL 无定义）。
    const visible = line.values.length > 0 && Number.isFinite(first);
    const values = new Array<number>(pointCount).fill(0);
    for (let i = 0; i < pointCount; i += 1) {
      const raw = line.values[Math.min(i, line.values.length - 1)];
      values[i] = Number.isFinite(raw) ? raw : first;
    }
    return { label: line.label, values, isConstant: line.isConstant, visible };
  });
}

/**
 * 构造分区带（±1σ / ±2σ）。
 *
 * @param series 控制图序列
 * @param pointCount 点数量
 * @returns 分区带；非计量型或无 σ 时 enabled=false
 */
function toSigmaZones(series: ControlChartSeries, pointCount: number): SigmaZoneBands {
  const zones = series.sigmaZones;
  if (!zones || !Number.isFinite(zones.oneSigma) || zones.oneSigma <= 0) {
    return {
      centerLine: 0,
      upper1: [],
      lower1: [],
      upper2: [],
      lower2: [],
      enabled: false,
    };
  }
  const cl = zones.centerLine;
  const s = zones.oneSigma;
  const upper1 = new Array<number>(pointCount).fill(cl + s);
  const lower1 = new Array<number>(pointCount).fill(cl - s);
  const upper2 = new Array<number>(pointCount).fill(cl + 2 * s);
  const lower2 = new Array<number>(pointCount).fill(cl - 2 * s);
  return { centerLine: cl, upper1, lower1, upper2, lower2, enabled: true };
}

/**
 * 由点数组构造违规高亮标记。
 *
 * @param points 面板点
 * @param violations 违规列表（已去重）
 * @returns 高亮标记数组（按索引升序）
 */
function toViolationMarks(points: ChartPoint[], violations: RuleViolation[]): ViolationMark[] {
  const byIndex = collectViolationByIndex(violations);
  const marks: ViolationMark[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const hit = byIndex.get(i);
    if (!hit) {
      continue;
    }
    marks.push({
      index: i,
      xLabel: points[i].xLabel,
      value: points[i].value,
      ruleIds: [...hit.ruleIds].sort(),
      severity: hit.severity,
      color: colorForSeverity(hit.severity),
    });
  }
  return marks;
}

/**
 * 构造单个面板的 option 片段。
 *
 * @param name 面板名
 * @param points 点数组
 * @param limits 控制限
 * @param violations 违规列表（仅主图传入，副图传空）
 * @param zones 分区带（仅主图传入）
 * @param xAxisName 横轴名
 * @param yAxisName 纵轴名
 * @returns 面板 option 片段
 */
function buildPanel(
  name: string,
  points: ChartPoint[],
  limits: ControlLine[] | undefined,
  violations: RuleViolation[],
  zones: SigmaZoneBands,
  xAxisName: string,
  yAxisName: string,
): PanelOption {
  const pointCount = points.length;
  return {
    name,
    categories: points.map((p) => p.xLabel),
    values: points.map((p) => p.value),
    xAxisName,
    yAxisName,
    limits: toLimitSeriesData(limits, pointCount),
    violations: toViolationMarks(points, violations),
    sigmaZones: zones.enabled ? zones : null,
  };
}

/**
 * 由控制图序列与违规结果构造完整 option 描述（纯函数）。
 *
 * @param series 控制图序列
 * @param violations 去重后的违规列表
 * @returns 控制图 option 描述
 */
export function buildControlChartOption(
  series: ControlChartSeries,
  violations: RuleViolation[],
): ControlChartOption {
  const primaryPoints = series.primary.points;
  const primaryZones = toSigmaZones(series, primaryPoints.length);
  const isVariablesChart =
    series.selectedType === 'Xbar-R' ||
    series.selectedType === 'Xbar-S' ||
    series.selectedType === 'I-MR';

  const primary = buildPanel(
    series.primary.name,
    primaryPoints,
    series.limits.primary,
    violations,
    primaryZones,
    '子组 / 样本号',
    series.primary.name,
  );

  let secondary: PanelOption | null = null;
  if (series.secondary) {
    secondary = buildPanel(
      series.secondary.name,
      series.secondary.points,
      series.limits.secondary,
      [], // 违规仅标注在主图上
      { centerLine: 0, upper1: [], lower1: [], upper2: [], lower2: [], enabled: false },
      '子组 / 样本号',
      series.secondary.name,
    );
  }

  // 变限判定：主图 UCL 非常数即视为变限（P/U 逐点）。
  const ucl = series.limits.primary.find((l) => l.label === 'UCL');
  const hasVariableLimits = Boolean(ucl && !ucl.isConstant) && !isVariablesChart;

  return { primary, secondary, hasVariableLimits, selectedType: series.selectedType };
}

/**
 * 把面板 option 片段转换为可直接喂给 echarts-for-react 的 option 对象。
 *
 * 说明：本函数只做「数据 → ECharts 配置」的结构映射，不含任何副作用，
 * 便于 node 环境断言。分区带用两个 `line` 系列（上/下 ±2σ 与 ±1σ）以
 * `stack` + `areaStyle` 画带，违规点用 `scatter` 系列叠加。
 *
 * @param panel 面板 option 片段
 * @returns ECharts option 对象
 */
export function toPanelEChartsOption(panel: PanelOption): Record<string, unknown> {
  const series: Record<string, unknown>[] = [];

  // 分区带（先画，位于底层）：±2σ 带（浅色）+ ±1σ 带（稍深）。
  if (panel.sigmaZones) {
    series.push({
      name: '±2σ',
      type: 'line',
      data: panel.sigmaZones.upper2,
      lineStyle: { opacity: 0 },
      areaStyle: { color: chartThemeTokens.zoneBandA, origin: 'start' },
      silent: true,
      symbol: 'none',
      z: 1,
      tooltip: { show: false },
      // 以 CL 为基准填充：借助第二个 series 的 stack 由 ECharts 处理，
      // 这里直接给出上/下边界两条线更直观（见下方 ±1σ）。
    });
    series.push({
      name: '±1σ',
      type: 'line',
      data: panel.sigmaZones.upper1,
      lineStyle: { opacity: 0 },
      areaStyle: { color: chartThemeTokens.zoneBandB, origin: 'start' },
      silent: true,
      symbol: 'none',
      z: 1,
      tooltip: { show: false },
    });
  }

  // 主数据折线。
  series.push({
    name: panel.name,
    type: 'line',
    data: panel.values,
    symbol: 'circle',
    symbolSize: 6,
    showSymbol: true,
    itemStyle: { color: chartThemeTokens.bar },
    lineStyle: { color: chartThemeTokens.bar, width: 1.5 },
    z: 3,
  });

  // 控制限：CL 实线，UCL/LCL 虚线（逐点变限时为折线）。
  for (const lim of panel.limits) {
    if (!lim.visible) {
      continue;
    }
    const isCenter = lim.label === 'CL';
    series.push({
      name: lim.label,
      type: 'line',
      data: lim.values,
      showSymbol: false,
      silent: true,
      lineStyle: {
        color: isCenter ? chartThemeTokens.bar : chartThemeTokens.hline,
        width: isCenter ? 1 : 1.2,
        type: isCenter ? 'solid' : 'dashed',
      },
      z: 2,
      tooltip: { show: false },
    });
  }

  // 违规高亮点（scatter 叠加，按严重级着色；单系列统一色，逐点 itemStyle）。
  if (panel.violations.length > 0) {
    // 违规点定位到类目 x 与数值 y：使用 [categoryIndex, value] 形式。
    series.push({
      name: '违规点',
      type: 'scatter',
      data: panel.violations.map((v) => ({
        value: [v.index, v.value],
        itemStyle: { color: v.color, borderColor: '#ffffff', borderWidth: 1 },
        ruleIds: v.ruleIds,
        severity: v.severity,
      })),
      symbolSize: 12,
      z: 5,
      tooltip: {
        formatter: (p: unknown): string => {
          const d = p as { data?: { ruleIds?: string[]; severity?: string }; value?: number[] };
          const rules = d.data?.ruleIds?.join('、') ?? '';
          const idx = Array.isArray(d.value) ? d.value[0] : -1;
          return `第 ${(idx ?? 0) + 1} 点命中：${rules}`;
        },
      },
    });
  }

  return {
    grid: { top: 32, right: 28, bottom: 40, left: 52 },
    legend: { data: [panel.name, 'CL', 'UCL', 'LCL'], top: 2, type: 'scroll' },
    tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
    xAxis: {
      type: 'category',
      data: panel.categories,
      name: panel.xAxisName,
      nameLocation: 'middle',
      nameGap: 26,
      boundaryGap: false,
      axisLabel: { fontSize: 10, interval: panel.categories.length > 40 ? 'auto' : 0 },
    },
    yAxis: {
      type: 'value',
      name: panel.yAxisName,
      scale: true,
      splitLine: { show: true },
    },
    series,
  };
}
