/**
 * HistogramChart —— 直方图（叠加 USL / LSL / 目标线）。
 *
 * 出处：架构文档 §2.8、§6（ECharts）。使用 echarts-for-react。
 * 规格线用 markLine 绘制；规格限为 null 时不画该线。
 */

import ReactECharts from 'echarts-for-react';
import type { ReactElement } from 'react';
import type { HistogramResult, SpecLimits } from '@/core';
import { chartThemeTokens } from '@/theme';

export interface HistogramChartProps {
  histogram: HistogramResult;
  spec: SpecLimits;
  height?: number;
}

interface MarkLineItem {
  xAxis: number;
  label: { formatter: string; position: 'end' };
  lineStyle: { color: string; type: 'solid' | 'dashed' };
}

/**
 * 构造 ECharts option。
 *
 * @param histogram 直方图数据
 * @param spec 规格限
 * @returns ECharts option 对象
 */
function buildOption(histogram: HistogramResult, spec: SpecLimits): Record<string, unknown> {
  const categories = histogram.bins.map((b) => b.label);
  const counts = histogram.bins.map((b) => b.count);

  const markLines: MarkLineItem[] = [];
  if (spec.usl !== null) {
    markLines.push({
      xAxis: spec.usl,
      label: { formatter: `USL ${spec.usl}`, position: 'end' },
      lineStyle: { color: chartThemeTokens.hline, type: 'dashed' },
    });
  }
  if (spec.lsl !== null) {
    markLines.push({
      xAxis: spec.lsl,
      label: { formatter: `LSL ${spec.lsl}`, position: 'end' },
      lineStyle: { color: chartThemeTokens.hline, type: 'dashed' },
    });
  }
  if (spec.target !== null) {
    markLines.push({
      xAxis: spec.target,
      label: { formatter: `目标 ${spec.target}`, position: 'end' },
      lineStyle: { color: chartThemeTokens.bar, type: 'solid' },
    });
  }

  return {
    grid: { top: 24, right: 24, bottom: 40, left: 48 },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: categories,
      name: spec.unit ? `测量值 (${spec.unit})` : '测量值',
      nameLocation: 'middle',
      nameGap: 28,
      axisLabel: { fontSize: 10 },
    },
    yAxis: {
      type: 'value',
      name: '频数',
    },
    series: [
      {
        name: '频数',
        type: 'bar',
        data: counts,
        barCategoryGap: '5%',
        itemStyle: { color: chartThemeTokens.bar },
        markLine: markLines.length
          ? { silent: true, symbol: 'none', data: markLines }
          : undefined,
      },
    ],
  };
}

/**
 * 渲染直方图。
 *
 * @param props 组件属性
 * @returns 图表元素
 */
export default function HistogramChart({
  histogram,
  spec,
  height = 320,
}: HistogramChartProps): ReactElement {
  const option = buildOption(histogram, spec);
  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      notMerge
      lazyUpdate
      data-testid="histogram-chart"
    />
  );
}
