/**
 * ChatChartRefs —— 把 AI 回复里引用的图表渲染成**真图**（P8）。
 *
 * 用户指令：「同时可以引用或者生成图表来参考解释」。
 *
 * 设计口径：
 *  - 图**不来自模型**：模型只给 id，数据一律现算自 `projectStore`（与「控制图 / 能力分析 / 柏拉图」
 *    页同一套 core 函数），所以聊天里的图和页面上那张图逐点一致；
 *  - 算不出来就不渲染（子组不足、没有缺陷记录等），不画空图、不报错打断对话；
 *  - 复用现有图表组件，因此打印快照（.print-chart）与主题色都自动跟随。
 *
 * 出处：用户指令「修改问答的逻辑…同时可以引用或者生成图表来参考解释」。
 */

import { useMemo, type ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { buildHistogram, buildPareto, type HistogramResult, type ParetoResult } from '@/core';
import type { SpecLimits } from '@/core';
import type { Dataset } from '@/data/schema';
import type { RuleToggleConfig } from '@/core';
import { parseChartRefId, deriveChartType } from '@/services/ai/analysisContext';
import { computeControlChartState } from '@/ui/hooks/useControlChart';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useSettingsStore } from '@/store/settingsStore';
import ControlChart from '@/ui/charts/ControlChart';
import HistogramChart from '@/ui/charts/HistogramChart';
import ParetoChart from '@/ui/charts/ParetoChart';

/** 解析后的图表（要么能画，要么为 null）。 */
type Resolved =
  | {
      id: string;
      kind: 'control';
      title: string;
      series: NonNullable<ReturnType<typeof computeControlChartState>['series']>;
      violations: NonNullable<ReturnType<typeof computeControlChartState>['evaluation']>['violations'];
    }
  | { id: string; kind: 'histogram'; title: string; histogram: HistogramResult; spec: SpecLimits }
  | { id: string; kind: 'pareto'; title: string; pareto: ParetoResult };

/** 取某特性的有效测量值（与各分析页同口径：未排除 + 有限值）。 */
function valuesOf(dataset: Dataset | null, name: string): number[] {
  const characteristic = dataset?.characteristics.find((c) => c.name === name);
  if (!characteristic) {
    return [];
  }
  return characteristic.measurements
    .filter((m) => m.excluded !== true)
    .map((m) => m.value)
    .filter((v) => Number.isFinite(v));
}

/** 把图表 id 解析成「能画的东西」；解析不了返回 null。 */
export function resolveChartRef(
  id: string,
  dataset: Dataset | null,
  capacity: number,
  rulesConfig: RuleToggleConfig,
): Resolved | null {
  const parsed = parseChartRefId(id);
  if (parsed === null) {
    return null;
  }

  if (parsed.kind === 'pareto') {
    if (!dataset || dataset.defectRecords.length === 0) {
      return null;
    }
    return { id, kind: 'pareto', title: '缺陷类型 Pareto', pareto: buildPareto(dataset.defectRecords) };
  }

  const characteristic = dataset?.characteristics.find((c) => c.name === parsed.characteristic);
  if (!characteristic) {
    return null;
  }
  const values = valuesOf(dataset, parsed.characteristic);
  if (values.length === 0) {
    return null;
  }

  if (parsed.kind === 'histogram') {
    try {
      return {
        id,
        kind: 'histogram',
        title: `${parsed.characteristic} · 直方图`,
        histogram: buildHistogram(values),
        spec: characteristic.specLimits as SpecLimits,
      };
    } catch {
      return null;
    }
  }

  const state = computeControlChartState(values, deriveChartType(capacity), capacity, rulesConfig);
  if (!state.series || !state.evaluation) {
    return null;
  }
  return {
    id,
    kind: 'control',
    title: `${parsed.characteristic} · ${state.series.primary.name} 控制图`,
    series: state.series,
    violations: state.evaluation.violations,
  };
}

/** ChatChartRefs 属性。 */
export interface ChatChartRefsProps {
  /** 模型引用到的图表 id（来自 {@link resolveChartRef} 的合法 id）。 */
  ids: string[];
}

/**
 * 渲染 AI 回复中引用的图表。
 *
 * @param props 组件属性
 * @returns 图表区（无可用图表时返回 null，不留空框）
 */
export default function ChatChartRefs({ ids }: ChatChartRefsProps): ReactElement | null {
  const dataset = useProjectStore((s) => s.dataset);
  const capacity = useAnalysisStore((s) => s.subgroupCapacity);
  const rulesConfig = useSettingsStore((s) => s.rulesConfig);

  const charts = useMemo(
    () =>
      ids
        .map((id) => resolveChartRef(id, dataset, capacity, rulesConfig))
        .filter((c): c is Resolved => c !== null),
    [ids, dataset, capacity, rulesConfig],
  );

  if (charts.length === 0) {
    return null;
  }

  return (
    <Stack spacing={1} sx={{ mt: 1 }} data-testid="ai-chart-refs">
      {charts.map((chart) => (
        <Box
          key={chart.id}
          sx={{
            border: 1,
            borderColor: 'divider',
            borderRadius: 1,
            p: 1,
            bgcolor: 'background.paper',
            '@media print': { breakInside: 'avoid' },
          }}
        >
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>
            图表（按引用生成）：{chart.title}
          </Typography>
          {chart.kind === 'control' ? (
            <ControlChart series={chart.series} violations={chart.violations} height={260} />
          ) : null}
          {chart.kind === 'histogram' ? (
            <HistogramChart histogram={chart.histogram} spec={chart.spec} height={240} />
          ) : null}
          {chart.kind === 'pareto' ? <ParetoChart pareto={chart.pareto} height={260} /> : null}
        </Box>
      ))}
    </Stack>
  );
}