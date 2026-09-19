/**
 * ParetoChart —— 柏拉图（双 Y 轴：左数量 / 右累计占比 + 80% 分界线）。
 *
 * 出处：架构文档 §2.8、§6；PRD P0-17。
 *
 * 纯数据转换 `toParetoSeries()` 独立导出，便于单元测试
 * （不依赖 DOM/ECharts 渲染）。
 */

import ReactECharts from 'echarts-for-react';
import type { ReactElement } from 'react';
import type { ParetoResult } from '@/core';
import { chartThemeTokens } from '@/theme';

export interface ParetoChartProps {
  pareto: ParetoResult;
  height?: number;
}

/** 柏拉图图表的纯数据序列（可单测）。 */
export interface ParetoSeries {
  /** 横轴类目（缺陷类型，降序）。 */
  categories: string[];
  /** 各类目数量（左轴）。 */
  counts: number[];
  /** 各类目累计占比 %（右轴）。 */
  cumRatios: number[];
  /** 80% 分界线值（阈值）。 */
  threshold: number;
  /** 累计首次 >= 阈值的类目索引；无则 null。 */
  crossingIndex: number | null;
}

/**
 * 把 core 的 ParetoResult 转换为图表序列（纯函数，可单测）。
 *
 * @param pareto 柏拉图结果
 * @returns 图表序列
 */
export function toParetoSeries(pareto: ParetoResult): ParetoSeries {
  return {
    categories: pareto.items.map((it) => it.defectType),
    counts: pareto.items.map((it) => it.count),
    cumRatios: pareto.items.map((it) => it.cumRatio),
    threshold: pareto.threshold,
    crossingIndex: pareto.crossingIndex,
  };
}

/**
 * 构造 ECharts option。
 *
 * @param series 图表序列
 * @returns ECharts option 对象
 */
export function buildParetoOption(series: ParetoSeries): Record<string, unknown> {
  return {
    grid: { top: 40, right: 56, bottom: 56, left: 56 },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown): string => {
        const arr = Array.isArray(params) ? params : [params];
        if (arr.length === 0) {
          return '';
        }
        const first = arr[0] as { axisValue?: string; dataIndex?: number };
        const name = first.axisValue ?? '';
        const idx = typeof first.dataIndex === 'number' ? first.dataIndex : -1;
        const count = idx >= 0 ? series.counts[idx] : 0;
        const cum = idx >= 0 ? series.cumRatios[idx] : 0;
        return `${name}<br/>数量：${count}<br/>累计占比：${cum.toFixed(2)}%`;
      },
    },
    legend: { data: ['数量', '累计占比'], top: 4 },
    xAxis: {
      type: 'category',
      data: series.categories,
      axisLabel: { interval: 0, rotate: series.categories.length > 6 ? 30 : 0, fontSize: 11 },
    },
    yAxis: [
      {
        type: 'value',
        name: '数量',
        position: 'left',
        splitLine: { show: true },
      },
      {
        type: 'value',
        name: '累计占比 %',
        position: 'right',
        min: 0,
        max: 100,
        axisLabel: { formatter: '{value}%' },
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: '数量',
        type: 'bar',
        yAxisIndex: 0,
        data: series.counts,
        itemStyle: { color: chartThemeTokens.bar },
      },
      {
        name: '累计占比',
        type: 'line',
        yAxisIndex: 1,
        data: series.cumRatios,
        smooth: false,
        symbol: 'circle',
        symbolSize: 7,
        itemStyle: { color: chartThemeTokens.line },
        lineStyle: { color: chartThemeTokens.line, width: 2 },
        markLine: {
          silent: true,
          symbol: 'none',
          data: [
            {
              yAxis: series.threshold,
              label: { formatter: `${series.threshold}% 分界线`, position: 'insideEndTop' },
              lineStyle: { color: chartThemeTokens.violationMedium, type: 'dashed' as const },
            },
          ],
        },
      },
    ],
  };
}

/**
 * 渲染柏拉图。
 *
 * @param props 组件属性
 * @returns 图表元素
 */
export default function ParetoChart({ pareto, height = 400 }: ParetoChartProps): ReactElement {
  const option = buildParetoOption(toParetoSeries(pareto));
  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      notMerge
      lazyUpdate
      data-testid="pareto-chart"
    />
  );
}
