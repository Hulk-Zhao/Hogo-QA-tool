/**
 * analysisContext 测试（P8）。
 *
 * 缺陷背景（用户报障 + 截图）：AI 回复写着「这份统计摘要里三个特性均未给出控制图点子序列，
 * warnings 全为空，因此不能编造『第几子组触发某判异规则』」——
 * 根因是应用只发了能力指数，**子组序列与判异明细从来没发出去**。
 *
 * 证伪立场（每条都必须能因为「退回只发能力指数」而变红）：
 *  - 用例 1：控制图块必须带 CLA/UCL/LCL + 子组均值序列 + 1-based 子组编号；
 *  - 用例 2：人为制造一个越限子组 → violations 必须点名规则 id 与**具体子组编号**，
 *            outOfLimit 必须指出是哪个子组越了哪个限；
 *  - 用例 3：仍然不发逐条原始测量值（子组序列是聚合量）+ 无 measurements 字段；
 *  - 用例 4：子组序列有条数上限（防上下文爆炸），超限时标记 pointsTruncated 并进 caveats；
 *  - 用例 5：图表目录 / 规则清单 / 聚焦特性 / 数据局限都在；
 *  - 用例 6：规格限非法时能力指数降级但不抛异常（控制图照常给）。
 */

import { describe, expect, it } from 'vitest';
import type { Dataset } from '@/data/schema';
import { defaultToggleConfig } from '@/core';
import {
  SUBGROUP_SERIES_MAX,
  buildAnalysisContext,
  buildChartCatalogue,
  deriveChartType,
  parseChartRefId,
  subgroupSeriesLimitFor,
} from '@/services/ai/analysisContext';

/** 造一份「第 7 子组整体抬高」的数据：子组内极差正常 → 只有均值越限（W1/N1）。 */
function makeDataset(options?: { withDefects?: boolean; badSpec?: boolean }): Dataset {
  const measurements = [] as Dataset['characteristics'][number]['measurements'];
  let seq = 0;
  for (let g = 0; g < 12; g += 1) {
    for (let k = 0; k < 5; k += 1) {
      const shift = g === 6 ? 2.5 : 0;
      seq += 1;
      measurements.push({
        id: `m${seq}`,
        characteristicId: 'c1',
        value: 50 + Math.sin(seq) * 0.02 + shift,
        subgroupId: null,
        timestamp: null,
        batch: null,
        excluded: false,
        excludeReason: null,
      });
    }
  }
  return {
    id: 'ds1',
    projectId: 'p1',
    name: '外壳长度数据',
    sourceType: 'xlsx',
    importedAt: '2026-09-20T10:00:00.000Z',
    rawFileName: 'test.xlsx',
    characteristics: [
      {
        id: 'c1',
        datasetId: 'ds1',
        name: '外壳长度',
        specLimits: options?.badSpec
          ? { usl: 49, lsl: 50, target: null, unit: 'mm' }
          : { usl: 50.3, lsl: 49.7, target: 50, unit: 'mm' },
        measurements,
        subgroups: [],
        nullCount: 0,
        outlierFlags: [],
        preprocessConfigRef: null,
        measurementBlobRef: null,
      },
    ],
    defectRecords: options?.withDefects
      ? [
          { id: 'd1', datasetId: 'ds1', defectType: '尺寸超差', count: 12, category: '外观' },
          { id: 'd2', datasetId: 'ds1', defectType: '划伤', count: 5, category: '外观' },
        ]
      : [],
  };
}

function contextOf(dataset: Dataset | null, focus: string | null = null): Record<string, unknown> {
  return buildAnalysisContext({
    projectName: '质量日报',
    dataset,
    subgroupCapacity: 5,
    subgroupMode: 'fixed',
    sigmaMode: 'R',
    rulesConfig: defaultToggleConfig(),
    focusCharacteristic: focus,
  });
}

/** 取出第一个特性的控制图块（测试里反复用到）。 */
function chartOf(ctx: Record<string, unknown>): Record<string, unknown> {
  const chars = ctx.characteristics as Record<string, unknown>[];
  return chars[0].controlChart as Record<string, unknown>;
}

describe('buildAnalysisContext —— 「够 LLM 用」的数据面', () => {
  it('控制图块给出图型/子组规模/控制限与逐子组均值序列（编号从 1 开始）', () => {
    const ctx = contextOf(makeDataset());
    const chart = chartOf(ctx);

    expect(chart.chartType).toBe('Xbar-R');
    expect(chart.subgroupSize).toBe(5);
    expect(chart.subgroupCount).toBe(12);
    expect(typeof chart.centerLine).toBe('number');
    expect(typeof chart.ucl).toBe('number');
    expect(typeof chart.lcl).toBe('number');

    const points = chart.points as { i: number; mean: number; range: number }[];
    expect(points).toHaveLength(12);
    expect(points[0].i).toBe(1);
    expect(points[11].i).toBe(12);
    expect(Number.isFinite(points[0].mean)).toBe(true);
    // 子组内极差是聚合量，不该等于逐条原始值
    expect(Number.isFinite(points[0].range)).toBe(true);
  });

  it('越限子组被点名：violations 带规则 id + 涉及子组编号，outOfLimit 指出限别', () => {
    const ctx = contextOf(makeDataset());
    const chart = chartOf(ctx);

    const violations = chart.violations as {
      ruleId: string;
      ruleLabel: string;
      subgroupIndices: number[];
      message: string;
      severity: string;
    }[];
    expect(violations.length).toBeGreaterThan(0);
    // 抬高的是第 7 个子组（1-based）——必须点名它，而不是含糊地说「部分子组异常」
    expect(violations.some((v) => v.subgroupIndices.includes(7))).toBe(true);
    expect(violations[0].ruleId).toMatch(/^[WN]\d$/);
    expect(violations[0].message.length).toBeGreaterThan(0);

    const outOfLimit = chart.outOfLimit as { subgroupIndex: number; limit: string; value: number }[];
    expect(outOfLimit.some((p) => p.subgroupIndex === 7 && p.limit === 'UCL')).toBe(true);
  });

  it('仍然不发逐条原始测量值（聚合口径不变，数据主权边界不放宽）', () => {
    const ctx = contextOf(makeDataset());
    const text = JSON.stringify(ctx);
    expect(text).not.toContain('measurements');
    expect(text).not.toContain('"values"');
    // 12 个子组 × 5 = 60 个原始值 → 发出去的只有 12 个聚合点
    expect((chartOf(ctx).points as unknown[]).length).toBeLessThan(60);
    expect(ctx.measurementCount).toBe(60);
  });

  it('子组序列有条数上限：超限时截成「前 30 + 后 30」并写进 caveats', () => {
    const dataset = makeDataset();
    // 把 12 个子组扩到 100 个（每个子组 5 点）
    const measurementList: Dataset['characteristics'][number]['measurements'] = [];
    let seq = 0;
    for (let g = 0; g < 100; g += 1) {
      for (let k = 0; k < 5; k += 1) {
        seq += 1;
        measurementList.push({
          id: `m${seq}`,
          characteristicId: 'c1',
          value: 50 + Math.sin(seq) * 0.02,
          subgroupId: null,
          timestamp: null,
          batch: null,
          excluded: false,
          excludeReason: null,
        });
      }
    }
    dataset.characteristics[0].measurements = measurementList;

    const ctx = contextOf(dataset);
    const chart = chartOf(ctx);
    const points = chart.points as { i: number }[];
    expect(chart.subgroupCount).toBe(100);
    expect(points).toHaveLength(SUBGROUP_SERIES_MAX);
    expect(chart.pointsTruncated).toBe(true);
    // 头尾都要留：第 1 个与第 100 个子组都必须在
    expect(points[0].i).toBe(1);
    expect(points[points.length - 1].i).toBe(100);
    expect((ctx.caveats as string[]).some((c) => c.includes('子组序列超过'))).toBe(true);
  });

  it('规则清单 / 图表目录 / 数据局限 / 聚焦特性都在（模型据此引用规则与图）', () => {
    const ctx = contextOf(makeDataset({ withDefects: true }), '外壳长度');

    const ruleSet = ctx.ruleSet as { enabled: string[]; labels: Record<string, string> };
    expect(ruleSet.enabled.length).toBeGreaterThan(0);
    expect(ruleSet.labels.W1).toBeTruthy();

    const catalogue = ctx.chartCatalogue as { id: string; kind: string }[];
    expect(catalogue.map((c) => c.id)).toContain('chart:control:外壳长度');
    expect(catalogue.map((c) => c.id)).toContain('chart:histogram:外壳长度');
    expect(catalogue.map((c) => c.id)).toContain('chart:pareto:all');

    expect(ctx.selectedCharacteristic).toBe('外壳长度');
    expect((ctx.caveats as string[]).length).toBeGreaterThan(0);
    expect((ctx.defects as { total: number }).total).toBe(17);
  });

  it('容量决定图型；容量 <2 退化为 I-MR（与「控制图」页同口径）', () => {
    expect(deriveChartType(1)).toBe('I-MR');
    expect(deriveChartType(5)).toBe('Xbar-R');
    expect(deriveChartType(12)).toBe('Xbar-S');
  });

  it('规格限非法时能力指数降级，但控制图数据照常给出（不抛异常）', () => {
    const ctx = contextOf(makeDataset({ badSpec: true }));
    const chars = ctx.characteristics as Record<string, unknown>[];
    expect(chars[0].capabilityUnavailable).toBeTruthy();
    expect(chars[0].cpk).toBeUndefined();
    expect(chartOf(ctx).subgroupCount).toBe(12);
  });

  it('没有数据集时不抛异常：特性数为 0，并明确写出数据局限', () => {
    const ctx = contextOf(null);
    expect(ctx.characteristicCount).toBe(0);
    expect(ctx.chartCatalogue).toEqual([]);
    expect((ctx.caveats as string[]).some((c) => c.includes('没有数据集'))).toBe(true);
  });
});

describe('图表目录与 id 解析', () => {
  it('每个特性给出控制图与直方图两枚可引用 id，缺陷数据存在时再加 Pareto', () => {
    const refs = buildChartCatalogue(makeDataset({ withDefects: true }));
    expect(refs.filter((r) => r.kind === 'control')).toHaveLength(1);
    expect(refs.filter((r) => r.kind === 'histogram')).toHaveLength(1);
    expect(refs.filter((r) => r.kind === 'pareto')).toHaveLength(1);
  });

  it('parseChartRefId 认得三种 id，非法 id 一律 null（防止模型自造图表）', () => {
    expect(parseChartRefId('chart:control:转轴直径')).toEqual({ kind: 'control', characteristic: '转轴直径' });
    expect(parseChartRefId('chart:pareto:all')).toEqual({ kind: 'pareto', characteristic: 'all' });
    // 特性名里带冒号也要能还原
    expect(parseChartRefId('chart:histogram:轴:1')).toEqual({ kind: 'histogram', characteristic: '轴:1' });
    expect(parseChartRefId('chart:bogus:x')).toBeNull();
    expect(parseChartRefId('转轴直径')).toBeNull();
    expect(parseChartRefId('chart:control')).toBeNull();
  });

  it('子组序列预算随特性数收缩（20~60 之间），保证上下文不会爆炸', () => {
    expect(subgroupSeriesLimitFor(1)).toBe(SUBGROUP_SERIES_MAX);
    expect(subgroupSeriesLimitFor(10)).toBe(60);
    expect(subgroupSeriesLimitFor(40)).toBe(20);
    expect(subgroupSeriesLimitFor(0)).toBe(SUBGROUP_SERIES_MAX);
  });
});