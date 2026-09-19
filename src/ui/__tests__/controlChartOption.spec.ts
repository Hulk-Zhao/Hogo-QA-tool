/**
 * controlChartOption 纯函数测试（架构文档 T04，node 环境）。
 *
 * 覆盖：
 *   - 7 种控制图 option 结构（主图/副图/限序列）；
 *   - 变样本量 P/U 逐点变限（UCL 非常数）；
 *   - 计量型分区带（±1σ/±2σ）；
 *   - 违规高亮（严重级着色 + 逐点合并）；
 *   - toPanelEChartsOption 的系列构成。
 *
 * 全部在 node 下裸跑（不 import React / echarts-for-react / jsdom）。
 */

import { describe, expect, it } from 'vitest';
import {
  buildControlChart,
  buildSubgroups,
  type ChartType,
  type ControlChartSeries,
  type SubgroupStats,
  type RuleViolation,
} from '@/core';
import {
  buildControlChartOption,
  colorForSeverity,
  toPanelEChartsOption,
} from '@/ui/charts/controlChartOption';

/** 构造一组恒定容量 5 的子组。 */
function makeSubgroups(values: number[], capacity = 5): SubgroupStats[] {
  const measurements = values.map((value, i) => ({ id: `m-${i}`, value }));
  return buildSubgroups(measurements, { mode: 'fixed', capacity });
}

/** 生成 30 个带轻微波动的测量值。 */
function sampleValues(n = 30): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(50 + Math.sin(i / 3) * 2 + (i % 3) * 0.3);
  }
  return out;
}

describe('buildControlChartOption —— 7 种控制图结构', () => {
  it('Xbar-R：主图 X̄ + 副图 R + 分区带 + CL/UCL/LCL', () => {
    const series = buildControlChart('Xbar-R', {
      kind: 'variables',
      subgroups: makeSubgroups(sampleValues(25)),
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('Xbar-R');
    expect(opt.primary.name).toBe('X̄');
    expect(opt.secondary?.name).toBe('R');
    expect(opt.primary.sigmaZones?.enabled).toBe(true);
    const labels = opt.primary.limits.map((l) => l.label);
    expect(labels).toContain('CL');
    expect(labels).toContain('UCL');
    expect(labels).toContain('LCL');
    // 恒定限
    expect(opt.primary.limits.every((l) => l.isConstant)).toBe(true);
    expect(opt.hasVariableLimits).toBe(false);
  });

  it('Xbar-S：主图 X̄ + 副图 S + 分区带', () => {
    const series = buildControlChart('Xbar-S', {
      kind: 'variables',
      subgroups: makeSubgroups(sampleValues(36), 12),
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('Xbar-S');
    expect(opt.primary.name).toBe('X̄');
    expect(opt.secondary?.name).toBe('S');
    expect(opt.primary.sigmaZones?.enabled).toBe(true);
  });

  it('I-MR：主图 I + 副图 MR + 分区带', () => {
    const series = buildControlChart('I-MR', { kind: 'imr', values: sampleValues(20) });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('I-MR');
    expect(opt.secondary?.name).toBe('MR');
    expect(opt.primary.sigmaZones?.enabled).toBe(true);
  });

  it('P 图：恒定样本量时 UCL 为常数（非变限）', () => {
    const series = buildControlChart('P', {
      kind: 'attributes',
      data: { defectivesOrDefects: [3, 2, 4, 1, 5], sampleSizes: [100, 100, 100, 100, 100] },
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('P');
    expect(opt.secondary).toBeNull();
    expect(opt.hasVariableLimits).toBe(false);
    expect(opt.primary.sigmaZones).toBeNull();
  });

  it('P 图：变样本量时逐点变限（UCL 非常数 → hasVariableLimits=true）', () => {
    const series = buildControlChart('P', {
      kind: 'attributes',
      data: { defectivesOrDefects: [3, 2, 4, 1, 5], sampleSizes: [100, 120, 90, 150, 80] },
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.hasVariableLimits).toBe(true);
    const ucl = opt.primary.limits.find((l) => l.label === 'UCL');
    expect(ucl?.isConstant).toBe(false);
    // 各点限值不全相同 → 真变限。
    const uniq = new Set(ucl?.values ?? []);
    expect(uniq.size).toBeGreaterThan(1);
  });

  it('U 图：变样本量逐点变限', () => {
    const series = buildControlChart('U', {
      kind: 'attributes',
      data: { defectivesOrDefects: [4, 6, 3, 8, 5], sampleSizes: [10, 20, 15, 25, 12] },
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('U');
    expect(opt.hasVariableLimits).toBe(true);
  });

  it('NP 图：恒定 n，限为常数', () => {
    const series = buildControlChart('NP', {
      kind: 'attributes',
      data: { defectivesOrDefects: [3, 2, 4, 1, 5], sampleSizes: [100, 100, 100, 100, 100] },
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('NP');
    expect(opt.hasVariableLimits).toBe(false);
    expect(opt.primary.limits.every((l) => l.isConstant)).toBe(true);
  });

  it('C 图：恒定区域，限为常数', () => {
    const series = buildControlChart('C', {
      kind: 'attributes',
      data: { defectivesOrDefects: [3, 2, 4, 1, 5], sampleSizes: [1, 1, 1, 1, 1] },
    });
    const opt = buildControlChartOption(series, []);
    expect(opt.selectedType).toBe('C');
    expect(opt.hasVariableLimits).toBe(false);
  });
});

describe('buildControlChartOption —— 违规高亮', () => {
  const series = buildControlChart('Xbar-R', {
    kind: 'variables',
    subgroups: makeSubgroups(sampleValues(25)),
  });

  it('无违规时 primary.violations 为空', () => {
    const opt = buildControlChartOption(series, []);
    expect(opt.primary.violations.length).toBe(0);
  });

  it('违规点按索引着色并合并规则，取最高严重级', () => {
    const violations: RuleViolation[] = [
      {
        ruleId: 'W1',
        ruleGroup: 'westernElectric',
        pointIndices: [2],
        windowStart: 2,
        message: 'x',
        severity: 'high',
      },
      {
        ruleId: 'N5',
        ruleGroup: 'nelson',
        pointIndices: [2, 3],
        windowStart: 2,
        message: 'y',
        severity: 'low',
      },
    ];
    const opt = buildControlChartOption(series, violations);
    const mark2 = opt.primary.violations.find((v) => v.index === 2);
    expect(mark2).toBeDefined();
    expect(mark2?.ruleIds).toEqual(['N5', 'W1']);
    // 合并后取 high（高于 low）。
    expect(mark2?.severity).toBe('high');
    expect(mark2?.color).toBe(colorForSeverity('high'));
    // 索引 3 也有标记（N5 涉及）。
    expect(opt.primary.violations.some((v) => v.index === 3)).toBe(true);
  });

  it('副图不承载违规高亮', () => {
    const violations: RuleViolation[] = [
      {
        ruleId: 'W1',
        ruleGroup: 'westernElectric',
        pointIndices: [0],
        windowStart: 0,
        message: 'x',
        severity: 'high',
      },
    ];
    const opt = buildControlChartOption(series, violations);
    expect(opt.secondary?.violations.length).toBe(0);
  });
});

describe('toPanelEChartsOption —— ECharts 系列构成', () => {
  it('计量型含分区带 + 主数据 + 限线 + 违规 scatter', () => {
    const series = buildControlChart('Xbar-R', {
      kind: 'variables',
      subgroups: makeSubgroups(sampleValues(25)),
    });
    const violations: RuleViolation[] = [
      {
        ruleId: 'W1',
        ruleGroup: 'westernElectric',
        pointIndices: [1],
        windowStart: 1,
        message: 'x',
        severity: 'high',
      },
    ];
    const opt = buildControlChartOption(series, violations);
    const echarts = toPanelEChartsOption(opt.primary) as { series: { name: string; type: string }[] };
    const names = echarts.series.map((s) => s.name);
    expect(names).toContain('X̄');
    expect(names).toContain('CL');
    expect(names).toContain('UCL');
    expect(names).toContain('LCL');
    expect(names).toContain('违规点');
    // 分区带两条。
    expect(names.filter((n) => n.includes('σ')).length).toBe(2);
    const scatter = echarts.series.find((s) => s.name === '违规点');
    expect(scatter?.type).toBe('scatter');
  });
});

describe('buildControlChartOption —— 变限判定不受计量型影响', () => {
  it('计量型图 hasVariableLimits 恒为 false', () => {
    const types: ChartType[] = ['Xbar-R', 'Xbar-S', 'I-MR'];
    const seriesMap: Record<string, ControlChartSeries> = {
      'Xbar-R': buildControlChart('Xbar-R', { kind: 'variables', subgroups: makeSubgroups(sampleValues(25)) }),
      'Xbar-S': buildControlChart('Xbar-S', { kind: 'variables', subgroups: makeSubgroups(sampleValues(36), 12) }),
      'I-MR': buildControlChart('I-MR', { kind: 'imr', values: sampleValues(20) }),
    };
    for (const t of types) {
      const opt = buildControlChartOption(seriesMap[t], []);
      expect(opt.hasVariableLimits).toBe(false);
    }
  });
});
