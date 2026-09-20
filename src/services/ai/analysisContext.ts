/**
 * analysisContext —— 构造「够 LLM 用」的分析上下文（P8）。
 *
 * 缺陷背景（用户报障，附界面截图）：
 *   AI 回复里写着「这份统计摘要里三个特性均未给出控制图点子序列，warnings 全为空，
 *   因此不能编造『第几子组触发某判异规则』」。
 *   用户要的恰恰是「哪个子组、哪条规则」，而**应用根本没把这些数据发出去**：
 *   `AiAssistantPage` 只调了 `buildCapabilitySummary`（能力指数），
 *   `payloadBuilder` 的白名单里虽然有 chartType/centerLine/ucl/lcl/violations，
 *   但摘要对象里从来没有这些字段 —— 模型只能诚实地回答「你没给我」。
 *
 * 本模块把「界面上算得出来的一切聚合统计」先装配好再发：
 *   - 每个特性：能力指数 + 控制图（图型/子组容量/CL/UCL/LCL/副图限）
 *                + **逐个子组均值与极差序列** + **逐条判异明细（含子组编号）** + 超限点；
 *   - 项目级：数据口径、子组配置、启用的判异规则清单、**可用图表目录**、缺陷 Pareto、数据局限。
 *
 * 数据主权边界（与架构 §8.2 一致，**没有放宽**）：
 *   仍然**不发送逐条原始测量值**。子组均值/极差是聚合统计（子组容量 n≥2 时不可反推原始值），
 *   与「能力指数、控制限」同属统计结果；逐条原始值依旧只在用户显式勾选
 *   「允许发送原始数据」并二次确认后才发送。发送清单由 `buildPayload` 的 `sentFields`
 *   原样展示给用户（UI 已渲染该清单）。
 *
 * 出处：架构文档 §8.2 / §8.3；PRD §6.3；用户指令「按照 LLM 的分析逻辑给出足够的数据」。
 */

import {
  RULE_META,
  buildCapabilitySummary,
  buildControlChart,
  buildPareto,
  buildSubgroups,
  computeCapability,
  dedupeViolations,
  evaluateRules,
  sigmaByPointOf,
  type ChartType,
  type RuleToggleConfig,
  type RuleViolation,
  type SubgroupConfig,
  type SubgroupMode,
  type SubgroupStats,
} from '@/core';
import type { Dataset } from '@/data/schema';

/** 单个特性的子组序列上限（超出时给「前 30 + 后 30」，见 {@link pickPoints}）。 */
export const SUBGROUP_SERIES_MAX = 60;

/** 所有特性的子组序列总预算（防止 20 个特性 × 60 点把上下文顶爆）。 */
export const SUBGROUP_SERIES_BUDGET = 600;

/** 图表目录里的一枚可引用图表。 */
export interface ChartRef {
  /** 唯一 id：`chart:control:<特性名>` / `chart:histogram:<特性名>` / `chart:pareto:all`。 */
  id: string;
  /** 图型类别（UI 据此选择渲染组件）。 */
  kind: 'control' | 'histogram' | 'pareto';
  /** 人类可读标题（也是 AI 在正文里引用时的语境）。 */
  title: string;
  /** 关联特性名（Pareto 为 `—`）。 */
  characteristic: string;
}

/** 解析图表 id：非法 id 返回 null（UI 与测试共用）。 */
export function parseChartRefId(id: string): { kind: ChartRef['kind']; characteristic: string } | null {
  const parts = String(id).split(':');
  if (parts.length < 3 || parts[0].trim() !== 'chart') {
    return null;
  }
  const kind = parts[1].trim();
  if (kind !== 'control' && kind !== 'histogram' && kind !== 'pareto') {
    return null;
  }
  return { kind, characteristic: parts.slice(2).join(':').trim() };
}

/** 每个特性分到多少个子组点（总预算 / 特性数，夹在 [20, 60]）。 */
export function subgroupSeriesLimitFor(characteristicCount: number): number {
  if (!Number.isFinite(characteristicCount) || characteristicCount <= 0) {
    return SUBGROUP_SERIES_MAX;
  }
  const per = Math.floor(SUBGROUP_SERIES_BUDGET / characteristicCount);
  return Math.max(20, Math.min(SUBGROUP_SERIES_MAX, per));
}

/** 数值整理：有限值四舍五入到 6 位；非有限值给 null（不让 NaN 进 JSON）。 */
function num(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 1e6) / 1e6;
}

/** 取控制限序列的常量值（变限图取首点，并在 caveats 里说明）。 */
function limitOf(lines: { label: string; values: number[]; isConstant: boolean }[] | undefined, label: string): number | null {
  const line = (lines ?? []).find((l) => l.label === label);
  return line && line.values.length > 0 ? num(line.values[0]) : null;
}

/**
 * 依子组容量推导控制图型（与「控制图」页的默认选择保持一致的口径）。
 *
 * 为什么要推导而不是读页面状态：控制图页的图型是页面内的 `useState`，不是全局状态，
 * service 层读不到；按容量推导是同一套口径里最稳的默认（n<2 → I-MR，n≤9 → X̄-R，n>9 → X̄-S）。
 *
 * @param capacity 子组容量
 * @returns 图型
 */
export function deriveChartType(capacity: number): ChartType {
  if (!Number.isFinite(capacity) || capacity < 2) {
    return 'I-MR';
  }
  return capacity <= 9 ? 'Xbar-R' : 'Xbar-S';
}

/** 子组序列采样：不超上限就全给，超了就「前 30 + 后 30」（首尾都要，才看得出漂移）。 */
function pickPoints<T>(points: T[], limit: number): { points: T[]; truncated: boolean } {
  if (points.length <= limit) {
    return { points, truncated: false };
  }
  const head = Math.ceil(limit / 2);
  const tail = limit - head;
  return { points: [...points.slice(0, head), ...points.slice(points.length - tail)], truncated: true };
}

/** 判异明细（给模型看的版本：规则 id + 规则说明 + 涉及子组编号，1-based）。 */
function violationRows(violations: RuleViolation[]): Record<string, unknown>[] {
  return violations.map((v) => {
    const meta = RULE_META[v.ruleId] as { label?: string; description?: string } | undefined;
    return {
      ruleId: v.ruleId,
      ruleLabel: meta?.label ?? '',
      ruleDescription: meta?.description ?? '',
      subgroupIndices: v.pointIndices.map((i) => i + 1),
      message: v.message,
      severity: v.severity,
    };
  });
}

/** 超限点（|值| 越过 CL±3σ）：这是「图上红点」的可计算口径，模型据此指认具体子组。 */
function outOfLimitRows(
  series: ReturnType<typeof buildControlChart>,
): Record<string, unknown>[] {
  const primary = series.limits.primary;
  const ucl = limitOf(primary, 'UCL');
  const lcl = limitOf(primary, 'LCL');
  const rows: Record<string, unknown>[] = [];
  if (ucl === null || lcl === null) {
    return rows;
  }
  for (const p of series.primary.points) {
    if (p.value > ucl || p.value < lcl) {
      rows.push({
        chart: series.primary.name,
        subgroupIndex: p.index + 1,
        value: num(p.value),
        limit: p.value > ucl ? 'UCL' : 'LCL',
        limitValue: p.value > ucl ? ucl : lcl,
      });
    }
  }
  return rows;
}

/** 构造单个特性的控制图块。 */
function buildControlChartBlock(
  values: number[],
  config: SubgroupConfig,
  toggles: RuleToggleConfig,
  limit: number,
): { block: Record<string, unknown> | null; violations: number; truncated: boolean } {
  const chartType = deriveChartType(config.capacity ?? values.length);
  let series: ReturnType<typeof buildControlChart>;
  try {
    if (chartType === 'I-MR') {
      series = buildControlChart('I-MR', { kind: 'imr', values });
    } else {
      const subgroups = buildSubgroups(
        values.map((value, i) => ({ id: `m-${i}`, value })),
        config,
      );
      if (subgroups.length === 0) {
        return { block: null, violations: 0, truncated: false };
      }
      series = buildControlChart(chartType, { kind: 'variables', subgroups });
    }
  } catch {
    return { block: null, violations: 0, truncated: false };
  }

  const evaluation = evaluateRules(series, sigmaByPointOf(series), toggles);
  const violations = dedupeViolations(evaluation.violations, true);
  const means = series.primary.points.map((p) => ({ i: p.index + 1, mean: num(p.value) }));
  const secondary = series.secondary
    ? series.secondary.points.map((p) => ({ i: p.index + 1, range: num(p.value) }))
    : [];
  const picked = pickPoints(
    means.map((m) => ({ ...m, ...(secondary[m.i - 1] ? { range: secondary[m.i - 1].range } : {}) })),
    limit,
  );

  return {
    block: {
      chartType,
      subgroupSize: series.primary.points[0]?.subgroupSize ?? null,
      subgroupCount: series.primary.points.length,
      primaryChartName: series.primary.name,
      centerLine: limitOf(series.limits.primary, 'CL'),
      ucl: limitOf(series.limits.primary, 'UCL'),
      lcl: limitOf(series.limits.primary, 'LCL'),
      secondaryChartName: series.secondary?.name ?? null,
      secondaryCenterLine: limitOf(series.limits.secondary, 'CL'),
      secondaryUcl: limitOf(series.limits.secondary, 'UCL'),
      secondaryLcl: limitOf(series.limits.secondary, 'LCL'),
      oneSigma: num(series.sigmaZones?.oneSigma),
      points: picked.points,
      pointsTruncated: picked.truncated,
      violations: violationRows(violations),
      outOfLimit: outOfLimitRows(series),
    },
    violations: violations.length,
    truncated: picked.truncated,
  };
}

/** 可用图表目录（AI 只能引用这里给出的 id）。 */
export function buildChartCatalogue(dataset: Dataset | null): ChartRef[] {
  if (dataset === null) {
    return [];
  }
  const refs: ChartRef[] = [];
  for (const c of dataset.characteristics) {
    refs.push({
      id: `chart:control:${c.name}`,
      kind: 'control',
      title: `${c.name} · 控制图`,
      characteristic: c.name,
    });
    refs.push({
      id: `chart:histogram:${c.name}`,
      kind: 'histogram',
      title: `${c.name} · 直方图（含规格限）`,
      characteristic: c.name,
    });
  }
  if (dataset.defectRecords.length > 0) {
    refs.push({
      id: 'chart:pareto:all',
      kind: 'pareto',
      title: '缺陷类型 Pareto（含累计占比）',
      characteristic: '—',
    });
  }
  return refs;
}

/** 构造分析上下文的入参。 */
export interface AnalysisContextOptions {
  projectName: string;
  dataset: Dataset | null;
  /** 子组容量（来自 analysisStore）。 */
  subgroupCapacity: number;
  /** 子组划分方式（来自 analysisStore）。 */
  subgroupMode: SubgroupMode;
  /** 手动子组边界（manual 模式）。 */
  manualBoundaries?: number[];
  /** 组内 σ 估计法（R / S）。 */
  sigmaMode: 'R' | 'S';
  /** 判异规则开关（来自 settingsStore，与「控制图」页同源）。 */
  rulesConfig: RuleToggleConfig;
  /** 当前选中特性（可选，用于「解读当前控制图」聚焦）。 */
  focusCharacteristic?: string | null;
}

/**
 * 构造「够 LLM 用」的分析上下文。
 *
 * @param options 入参（见 {@link AnalysisContextOptions}）
 * @returns 可直接交给 `buildPayload` 的摘要对象（仍不含逐条原始值）
 */
export function buildAnalysisContext(options: AnalysisContextOptions): Record<string, unknown> {
  const { projectName, dataset, subgroupCapacity, subgroupMode, manualBoundaries, sigmaMode, rulesConfig } = options;
  const config: SubgroupConfig =
    subgroupMode === 'manual'
      ? { mode: 'manual', manualBoundaries: manualBoundaries ?? [] }
      : { mode: subgroupMode, capacity: subgroupCapacity };

  const enabledRules = Object.entries({ ...rulesConfig.westernElectric, ...rulesConfig.nelson })
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const ruleSet = {
    enabled: enabledRules,
    labels: Object.fromEntries(
      enabledRules.map((id) => [id, (RULE_META[id as keyof typeof RULE_META] as { label?: string })?.label ?? id]),
    ),
    equivalentPairs: 'W1↔N1、W2↔N2、W3↔N3、W4↔N4 是等价规则，命中其一即视为同一条',
  };

  const caveats: string[] = [];
  const characteristics: Record<string, unknown>[] = [];
  const total = dataset?.characteristics.length ?? 0;
  const limit = subgroupSeriesLimitFor(total);

  for (const c of dataset?.characteristics ?? []) {
    const values = c.measurements.filter((m) => m.excluded !== true).map((m) => m.value).filter((v) => Number.isFinite(v));
    if (values.length === 0) {
      characteristics.push({ characteristicName: c.name, n: 0, unavailable: '该特性没有有效测量值' });
      continue;
    }
    const subgroups: SubgroupStats[] = (() => {
      try {
        return buildSubgroups(
          values.map((value, i) => ({ id: `m-${i}`, value })),
          config,
        );
      } catch {
        return [];
      }
    })();
    // 能力指数计算失败（规格限非法、样本不足等）不能让整页崩掉：
    // 该特性降级为「能力指数不可用」，其余数据（控制图/判异）照常发出去。
    const capability = (() => {
      try {
        return buildCapabilitySummary(
          computeCapability(values, c.specLimits as never, subgroups, { useImrFallback: true }),
          c.name,
        );
      } catch {
        return null;
      }
    })();
    const chart = buildControlChartBlock(values, config, rulesConfig, limit);
    const excluded = c.measurements.filter((m) => m.excluded === true).length;
    characteristics.push({
      characteristicName: c.name,
      n: values.length,
      ...(capability ?? {}),
      capabilityUnavailable: capability === null ? '该特性的能力指数无法计算（规格限非法 / 样本不足）' : null,
      excludedCount: excluded,
      controlChart: chart.block,
      controlChartUnavailable:
        chart.block === null ? '该特性在当前子组配置下无法构造控制图（子组数不足）' : null,
    });
    if (chart.truncated) {
      caveats.push(`${c.name}：子组序列超过 ${limit} 点时只列「前 ${Math.ceil(limit / 2)} + 后 ${limit - Math.ceil(limit / 2)}」个子组`);
    }
  }

  const defects = dataset && dataset.defectRecords.length > 0
    ? (() => {
        const pareto = buildPareto(dataset.defectRecords.map((d) => ({ defectType: d.defectType, count: d.count })));
        return {
          total: pareto.total,
          items: pareto.items.slice(0, 10).map((it) => ({
            defectType: it.defectType,
            count: it.count,
            ratio: num(it.ratio),
            cumulativeRatio: num(it.cumRatio),
          })),
        };
      })()
    : null;

  if (subgroupsShortWarning(total, limit)) {
    caveats.push('子组序列每特性最多 60 点：特性数较多时会按总预算自动收缩');
  }
  if (dataset === null) {
    caveats.push('当前项目没有数据集：只能基于项目级信息回答，涉及数值的问题请先导入数据');
  }
  caveats.push('数据口径：均值与 σ 均为「未排除」测量值的统计结果；σ_within 由子组内极差/标准差估计，σ_overall 为整体标准差');

  return {
    projectName,
    datasetName: dataset?.name ?? null,
    measurementCount: dataset?.characteristics.reduce((acc, c) => acc + c.measurements.length, 0) ?? 0,
    characteristicCount: total,
    selectedCharacteristic: options.focusCharacteristic ?? null,
    datasetImportedAt: dataset?.importedAt ?? null,
    subgroupConfig: {
      mode: subgroupMode,
      capacity: subgroupMode === 'manual' ? null : subgroupCapacity,
      manualBoundaryCount: subgroupMode === 'manual' ? (manualBoundaries ?? []).length : 0,
      sigmaMode,
      subgroupSeriesLimit: limit,
    },
    ruleSet,
    characteristics,
    defects,
    chartCatalogue: buildChartCatalogue(dataset),
    caveats,
  };
}

/** 是否触发了「每特性 60 点」的收缩（用于给模型一句诚实的数据局限）。 */
function subgroupsShortWarning(characteristicCount: number, limit: number): boolean {
  return characteristicCount > 0 && limit < SUBGROUP_SERIES_MAX;
}