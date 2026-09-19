/**
 * ControlChart —— 控制图渲染组件（ECharts，薄包装）。
 *
 * 出处：架构文档 T04；PRD P0-03~P0-06（7 种图）、P0-10（违规高亮 + 点击定位）。
 *
 * 设计要点（可测性）：所有 option 构造集中在纯函数模块
 * `controlChartOption.ts`，本组件仅负责：
 *   1. 调用纯函数得到 option；
 *   2. 渲染 ECharts；
 *   3. 把「点击图形元素 → 定位到点」回调出去。
 * 因此 option 结构可在 node 环境测试（见 controlChartOption.ts）。
 */

import ReactECharts from 'echarts-for-react';
import type { ReactElement } from 'react';
import { useMemo } from 'react';
import type { ControlChartSeries, RuleViolation } from '@/core';
import {
  buildControlChartOption,
  toPanelEChartsOption,
  type PanelOption,
} from './controlChartOption';

export interface ControlChartProps {
  series: ControlChartSeries;
  /** 去重后的违规列表。 */
  violations?: RuleViolation[];
  /** 点击某点（或违规点）时回调点索引，用于侧栏定位。 */
  onPointClick?: (pointIndex: number) => void;
  height?: number;
}

/**
 * 读取 ECharts 点击事件中的点索引。
 *
 * 主数据折线点击返回 dataIndex（类目索引）；违规 scatter 点击返回
 * value[0]（同为类目索引）。
 *
 * @param params ECharts 点击事件参数
 * @returns 点索引；无法解析时 null
 */
export function extractPointIndex(params: unknown): number | null {
  const p = params as {
    dataIndex?: number;
    seriesType?: string;
    data?: { value?: unknown };
  };
  if (p.seriesType === 'scatter') {
    const val = p.data?.value;
    if (Array.isArray(val) && typeof val[0] === 'number') {
      return val[0];
    }
  }
  if (typeof p.dataIndex === 'number') {
    return p.dataIndex;
  }
  return null;
}

/**
 * 渲染单张控制图面板。
 *
 * @param panel 面板 option 片段
 * @param height 高度
 * @param onPointClick 点击回调
 * @param testId data-testid
 * @returns 图表元素
 */
function PanelChart({
  panel,
  height,
  onPointClick,
  testId,
}: {
  panel: PanelOption;
  height: number;
  onPointClick?: (pointIndex: number) => void;
  testId: string;
}): ReactElement {
  const option = useMemo(() => toPanelEChartsOption(panel), [panel]);

  const handleClick = (params: unknown): void => {
    if (!onPointClick) {
      return;
    }
    const idx = extractPointIndex(params);
    if (idx !== null) {
      onPointClick(idx);
    }
  };

  return (
    <ReactECharts
      option={option}
      style={{ height, width: '100%' }}
      notMerge
      lazyUpdate
      onEvents={onPointClick ? { click: handleClick } : undefined}
      data-testid={testId}
    />
  );
}

/**
 * 渲染控制图（含副图）。
 *
 * @param props 组件属性
 * @returns 图表元素
 */
export default function ControlChart({
  series,
  violations = [],
  onPointClick,
  height = 320,
}: ControlChartProps): ReactElement {
  const model = useMemo(
    () => buildControlChartOption(series, violations),
    [series, violations],
  );

  return (
    <div className="print-chart" data-testid="control-chart">
      <PanelChart
        panel={model.primary}
        height={height}
        onPointClick={onPointClick}
        testId="control-chart-primary"
      />
      {model.secondary ? (
        <PanelChart
          panel={model.secondary}
          height={Math.round(height * 0.7)}
          onPointClick={undefined}
          testId="control-chart-secondary"
        />
      ) : null}
    </div>
  );
}
