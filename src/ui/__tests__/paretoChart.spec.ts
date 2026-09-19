/**
 * 柏拉图图表数据转换测试（架构文档 §2.8、§6）。
 *
 * 只验证「core ParetoResult → 图表序列」的纯数据映射，
 * 不验证 core 的聚合公式（那是 T01 pareto.spec.ts 的职责）。
 */

import { describe, expect, it } from 'vitest';
import { buildPareto } from '@/core';
import { toParetoSeries, buildParetoOption } from '@/ui/charts/ParetoChart';

const RECORDS = [
  { defectType: '划伤', count: 42 },
  { defectType: '毛边', count: 31 },
  { defectType: '尺寸超差', count: 18 },
  { defectType: '气孔', count: 12 },
];

describe('toParetoSeries —— 数据转换', () => {
  const pareto = buildPareto(RECORDS, 80, '其他', 0);
  const series = toParetoSeries(pareto);

  it('类目、数量、累计占比一一对应', () => {
    expect(series.categories.length).toBe(pareto.items.length);
    expect(series.counts.length).toBe(pareto.items.length);
    expect(series.cumRatios.length).toBe(pareto.items.length);
  });

  it('降序保持（数量非递增）', () => {
    for (let i = 1; i < series.counts.length; i += 1) {
      expect(series.counts[i]).toBeLessThanOrEqual(series.counts[i - 1]);
    }
  });

  it('累计占比单调不减且末项为 100%', () => {
    for (let i = 1; i < series.cumRatios.length; i += 1) {
      expect(series.cumRatios[i]).toBeGreaterThanOrEqual(series.cumRatios[i - 1]);
    }
    expect(series.cumRatios[series.cumRatios.length - 1]).toBeCloseTo(100, 6);
  });

  it('阈值与跨越索引透传', () => {
    expect(series.threshold).toBe(80);
    expect(series.crossingIndex).toBe(pareto.crossingIndex);
  });
});

describe('buildParetoOption —— ECharts 配置', () => {
  const pareto = buildPareto(RECORDS, 80, '其他', 0);
  const option = buildParetoOption(toParetoSeries(pareto)) as {
    yAxis: unknown[];
    series: { name: string; markLine?: { data: unknown[] } }[];
  };

  it('双 Y 轴（左数量 / 右累计占比）', () => {
    expect(Array.isArray(option.yAxis)).toBe(true);
    expect(option.yAxis.length).toBe(2);
  });

  it('柱状 + 折线两条系列', () => {
    expect(option.series.length).toBe(2);
    expect(option.series[0].name).toBe('数量');
    expect(option.series[1].name).toBe('累计占比');
  });

  it('折线带 80% 分界线 markLine', () => {
    expect(option.series[1].markLine).toBeDefined();
    expect(option.series[1].markLine?.data.length).toBe(1);
  });
});
