/**
 * ReportPage —— 报表导出页（P0-18；第五轮需求 #11）。
 *
 * 出处：架构文档 T04；PRD P0-18；PRD §4「报表导出页：导出项勾选（CPK汇总/
 * 不良统计/原始尺寸/原始不良/控制图截图/柏拉图截图）」。
 *
 * 功能：
 *   1. 导出范围 7 项勾选（4 表 + 3 图），状态进 `settingsStore` **并持久化**
 *      （第五轮用户明确要求「不要 useState」）；
 *   2. 预览当前日报：复选框勾了哪几项，页面就渲染哪几项 → **所见即打印所得**；
 *   3. 一键导出 Excel（固定 4 个数据 sheet，**永不含图片**）；
 *   4. 浏览器原生打印 / 输出 PDF（不引入 jsPDF）。
 *
 * 第五轮缺陷修复说明（为什么此前「勾了图表却一张图都没有」）：
 *   旧版全库无任何图表 import，`includeChartImagesInPrint` 只是给 body 加一个
 *   CSS 类，作用于**不存在的元素**；且勾选项由本页 `useState` 管理，刷新即丢。
 *   本版把「勾选 → 真实渲染」直接接上，并对每项给出可证伪测试。
 *
 * 关于 `getDataURL`：架构提示「ECharts 在 display:none 容器 init 会得 0 尺寸空图」。
 * 本页因此**不做隐藏容器截图**，而是让图表以真实尺寸渲染在报表版面上（打印样式
 * `.print-chart` 控制分页与缩放），从根本上规避 0 尺寸问题，同时避免
 * 「DOM 更新 → 等图片 decode → 再 window.print()」的时序竞态。
 */

import { useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Divider,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactElement } from 'react';
import { buildPareto } from '@/core';
import {
  buildProjectFromDataset,
  findCharacteristic,
  useProjectStore,
} from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useUiStore } from '@/store/uiStore';
import { selectCapability } from '@/store/selectors';
import DataTable, { type DataTableColumn } from '@/ui/components/DataTable';
import EmptyState from '@/ui/components/EmptyState';
import NumberCell from '@/ui/components/NumberCell';
import ControlChart from '@/ui/charts/ControlChart';
import ParetoChart from '@/ui/charts/ParetoChart';
import HistogramChart from '@/ui/charts/HistogramChart';
import { computeControlChartState } from '@/ui/hooks/useControlChart';
import AiExportPanel from '@/ui/components/AiExportPanel';
import {
  CHART_OPTION_KEYS,
  TABLE_OPTION_KEYS,
  buildModel,
  exportExcelReportDetailed,
  hasAnyExportOption,
  printReport,
  PRINT_PREVIEW_LIMIT,
  RAW_PREVIEW_LIMIT,
  type ExportOptions,
} from '@/services/report';
import type {
  CpKSummaryRow,
  DefectStatRow,
  RawDefectRow,
  RawDimensionRow,
} from '@/data/exporter/reportModel';

/** 报表数据集规模摘要。 */
interface ScaleSummary {
  characteristicCount: number;
  measurementCount: number;
  defectTypeCount: number;
}


/** 导出项中文名（顺序与 EXPORT_OPTION_KEYS 一致）。 */
const OPTION_LABEL: Record<keyof ExportOptions, string> = {
  cpkSummary: 'CPK 汇总表',
  defectStats: '不良统计表',
  rawDimensions: '原始尺寸表',
  rawDefects: '原始不良表',
  controlChartImage: '控制图',
  paretoChartImage: '柏拉图',
  capabilityChartImage: '能力图（直方图 + 规格线）',
};

/**
 * 渲染报表导出页。
 *
 * @returns 页面元素
 */
export default function ReportPage(): ReactElement {
  const dataset = useProjectStore((s) => s.dataset);
  const project = useProjectStore((s) => s.project);
  const projectName = useProjectStore((s) => s.projectName);
  const selectedId = useProjectStore((s) => s.selectedCharacteristicId);
  const pushToast = useUiStore((s) => s.pushToast);

  const capacity = useAnalysisStore((s) => s.subgroupCapacity);
  const subgroupMode = useAnalysisStore((s) => s.subgroupMode);
  const manualBoundaries = useAnalysisStore((s) => s.manualBoundaries);
  const sigmaMode = useAnalysisStore((s) => s.sigmaMode);
  const spec = useAnalysisStore((s) => s.spec);
  const specOverridden = useAnalysisStore((s) => s.specOverridden);

  // 导出范围与判异开关：均来自持久化的 settingsStore（刷新后保持用户选择）。
  const exportOptions = useSettingsStore((s) => s.exportOptions);
  const setExportOptions = useSettingsStore((s) => s.setExportOptions);
  const rulesConfig = useSettingsStore((s) => s.rulesConfig);

  const model = useMemo(() => {
    if (!dataset) {
      return null;
    }
    const proj = project ?? buildProjectFromDataset('local', projectName, dataset);
    try {
      return buildModel(proj);
    } catch {
      return null;
    }
  }, [dataset, project, projectName]);

  const scale: ScaleSummary = useMemo(() => {
    if (!dataset) {
      return { characteristicCount: 0, measurementCount: 0, defectTypeCount: 0 };
    }
    let measurementCount = 0;
    for (const c of dataset.characteristics) {
      measurementCount += c.measurements.length;
    }
    return {
      characteristicCount: dataset.characteristics.length,
      measurementCount,
      defectTypeCount: dataset.defectRecords.length,
    };
  }, [dataset]);

  /** 报表聚焦特性：优先用户选中项，其次第一个特性。 */
  const focusCharacteristic = useMemo(() => {
    if (!dataset || dataset.characteristics.length === 0) {
      return null;
    }
    return findCharacteristic(dataset, selectedId) ?? dataset.characteristics[0];
  }, [dataset, selectedId]);

  /**
   * 报表实际使用的规格限。
   *
   * 用户手动改过（`specOverridden`）→ 尊重用户输入；否则用**聚焦特性自身导入的**
   * 规格限，保证「报表按特性口径」不被能力页的编辑态串台（本轮 P2 修复）。
   */
  const effectiveSpec = useMemo(
    () => (specOverridden || !focusCharacteristic ? spec : focusCharacteristic.specLimits),
    [specOverridden, focusCharacteristic, spec],
  );

  /** 能力图（直方图）数据。 */
  const capabilityAnalysis = useMemo(
    () =>
      selectCapability(focusCharacteristic, {
        subgroupMode,
        subgroupCapacity: capacity,
        manualBoundaries,
        sigmaMode,
        spec: effectiveSpec,
      }),
    [focusCharacteristic, subgroupMode, capacity, manualBoundaries, sigmaMode, effectiveSpec],
  );

  /** 控制图数据（图型按子组容量自动选择，与实际产线口径一致）。 */
  const controlState = useMemo(() => {
    if (!focusCharacteristic) {
      return null;
    }
    const values = focusCharacteristic.measurements
      .filter((m) => m.excluded !== true)
      .map((m) => m.value);
    const chartType = capacity <= 10 ? 'Xbar-R' : 'Xbar-S';
    return computeControlChartState(values, chartType, capacity, rulesConfig);
  }, [focusCharacteristic, capacity, rulesConfig]);

  /** 柏拉图数据（无不良记录时为 null）。 */
  const pareto = useMemo(() => {
    if (!dataset || dataset.defectRecords.length === 0) {
      return null;
    }
    return buildPareto(
      dataset.defectRecords.map((d) => ({
        defectType: d.defectType,
        count: d.count,
        category: d.category,
      })),
      80,
      '其他',
      0.05,
    );
  }, [dataset]);

  /**
   * AI 分析用的控制图补充信息（P4-B）。
   *
   * 控制限本来可以由均值 ± 3σ 推导，但**判异结论**必须用页面真实算出来的那份，
   * 否则会出现「报表上标了红点、AI 却说过程受控」这种自相矛盾的输出。
   */
  const aiExtras = useMemo(() => {
    const limits = controlState?.series?.limits?.primary ?? [];
    const valueOf = (label: string): number | null => {
      const line = limits.find((l) => l.label === label);
      const v = line?.values?.[0];
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const cl = valueOf('CL');
    const ucl = valueOf('UCL');
    const lcl = valueOf('LCL');
    if (cl === null || ucl === null || lcl === null) {
      return undefined;
    }
    return {
      controlChart: {
        characteristicName: controlState?.characteristicName ?? '当前特性',
        centerLine: cl,
        ucl,
        lcl,
        violations: (controlState?.evaluation?.violations ?? []).map((v) => ({
          rule: v.message,
          pointIndex: v.windowStart,
        })),
      },
    };
  }, [controlState]);

  /** 勾选/取消勾选单个导出项（写入 store，立即落盘）。 */
  const setOption = (key: keyof ExportOptions, value: boolean): void => {
    setExportOptions({ ...exportOptions, [key]: value });
  };

  const anySelected = hasAnyExportOption(exportOptions);

  /** 导出 Excel（4 个数据 sheet + 可选的「图表」sheet 内嵌当前图表图片）。 */
  const handleExportExcel = (): void => {
    if (!model) {
      pushToast('无可用数据，无法导出报表', 'warning');
      return;
    }
    if (!dataset || dataset.characteristics.length === 0) {
      pushToast('无有效测量值，无法导出报表', 'warning');
      return;
    }
    try {
      const { fileName, imageCount } = exportExcelReportDetailed(model);
      pushToast(
        imageCount > 0
          ? `已导出 Excel：${fileName}（4 个数据 sheet + 图表 sheet，内嵌 ${imageCount} 张图）`
          : `已导出 Excel：${fileName}（4 个数据 sheet，本页无图表可内嵌）`,
        'success',
      );
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 打印 / 导出 PDF（内容 = 当前勾选的报表范围）。 */
  const handlePrint = (): void => {
    if (!anySelected) {
      pushToast('请至少勾选一项导出范围', 'warning');
      return;
    }
    const chartCount = CHART_OPTION_KEYS.filter((k) => exportOptions[k]).length;
    pushToast(
      chartCount > 0
        ? `已唤起打印，输出包含 ${chartCount} 张图表`
        : '已唤起打印，本次不含图表',
      'info',
    );
    printReport(exportOptions);
  };

  const cpkColumns: DataTableColumn<CpKSummaryRow>[] = [
    { key: 'char', header: '特性', render: (r) => r.characteristic },
    { key: 'n', header: 'n', align: 'right', render: (r) => r.n },
    { key: 'cpk', header: 'Cpk', align: 'right', render: (r) => <NumberCell value={r.cpk} kind="index" /> },
    { key: 'ppk', header: 'Ppk', align: 'right', render: (r) => <NumberCell value={r.ppk} kind="index" /> },
    { key: 'cp', header: 'Cp', align: 'right', render: (r) => <NumberCell value={r.cp} kind="index" /> },
    { key: 'pp', header: 'Pp', align: 'right', render: (r) => <NumberCell value={r.pp} kind="index" /> },
  ];

  const defectColumns: DataTableColumn<DefectStatRow>[] = [
    { key: 'type', header: '不良类型', render: (r) => r.defectType },
    { key: 'count', header: '数量', align: 'right', render: (r) => r.count },
    { key: 'ratio', header: '占比', align: 'right', render: (r) => <NumberCell value={r.ratio} kind="ratio" /> },
    {
      key: 'cum',
      header: '累计占比',
      align: 'right',
      render: (r) => <NumberCell value={r.cumRatio} kind="ratio" />,
    },
  ];

  const rawDimensionColumns: DataTableColumn<RawDimensionRow>[] = [
    { key: 'char', header: '特性', render: (r) => r.characteristic },
    { key: 'idx', header: '序号', align: 'right', render: (r) => r.index },
    { key: 'value', header: '测量值', align: 'right', render: (r) => r.value },
    { key: 'usl', header: 'USL', align: 'right', render: (r) => r.usl ?? '—' },
    { key: 'lsl', header: 'LSL', align: 'right', render: (r) => r.lsl ?? '—' },
  ];

  const rawDefectColumns: DataTableColumn<RawDefectRow>[] = [
    { key: 'type', header: '不良类型', render: (r) => r.defectType },
    { key: 'count', header: '数量', align: 'right', render: (r) => r.count },
    { key: 'cat', header: '分类', render: (r) => r.category || '—' },
  ];

  if (!dataset || dataset.characteristics.length === 0) {
    return (
      <EmptyState
        title="尚无可导出的数据"
        description="请先在「数据导入」页导入测量数据，再回到本页生成质量日报。"
      />
    );
  }

  const rawDimensions = model?.rawDimensions ?? [];
  const rawDefects = model?.rawDefects ?? [];

  return (
    <Stack spacing={2.5} data-testid="report-page">
      <Typography variant="h6" fontWeight={600}>
        一键质量日报导出
      </Typography>

      {/* 导出范围 + 操作 */}
      <Card variant="outlined" className="no-print">
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1" fontWeight={600}>
              导出范围（勾选状态自动保存，刷新后保持）
            </Typography>

            <Box data-testid="report-export-options">
              <Typography variant="caption" color="text.secondary">
                数据表（作用于页面预览与打印/PDF）
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  columnGap: 2,
                }}
              >
                {TABLE_OPTION_KEYS.map((key) => (
                  <FormControlLabel
                    key={key}
                    control={
                      <Checkbox
                        size="small"
                        checked={exportOptions[key]}
                        onChange={(_, checked) => setOption(key, checked)}
                        data-testid={`export-option-${key}`}
                      />
                    }
                    label={OPTION_LABEL[key]}
                  />
                ))}
              </Box>

              <Divider sx={{ my: 1 }} />

              <Typography variant="caption" color="text.secondary">
                图表（作用于打印/PDF；导出 Excel 时同样会内嵌到「图表」sheet）
              </Typography>
              <Box
                sx={{
                  display: 'grid',
                  gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                  columnGap: 2,
                }}
              >
                {CHART_OPTION_KEYS.map((key) => (
                  <FormControlLabel
                    key={key}
                    control={
                      <Checkbox
                        size="small"
                        checked={exportOptions[key]}
                        onChange={(_, checked) => setOption(key, checked)}
                        data-testid={`export-option-${key}`}
                      />
                    }
                    label={OPTION_LABEL[key]}
                  />
                ))}
              </Box>
            </Box>

            <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
              <Button variant="contained" onClick={handleExportExcel} data-testid="export-excel">
                导出 Excel（数据 + 图表）
              </Button>
              <Button
                variant="outlined"
                onClick={handlePrint}
                disabled={!anySelected}
                data-testid="print-report"
              >
                打印 / 输出 PDF
              </Button>
            </Stack>

            {!anySelected ? (
              <Alert severity="warning" data-testid="export-none-selected">
                已取消全部导出范围，打印/PDF 无内容可输出。请至少勾选一项。
              </Alert>
            ) : null}

            <Alert severity="info" icon={false}>
              Excel 导出含 4 个数据 sheet：CPK汇总 / 不良统计 / 原始尺寸 / 原始不良；若本页已渲染图表，
              会再追加一个「图表」sheet，把当前图表<strong>按原图内嵌</strong>（页面上没有图表时自动退化为纯数据）。
              PDF 通过浏览器原生打印生成（不引入 jsPDF，避免中文字体撑大体积），输出内容 = 上方勾选项。
            </Alert>
          </Stack>
        </CardContent>
      </Card>

      {/* 数据规模概览 */}
      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
            报表数据规模
          </Typography>
          <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
            <ScaleItem label="特性数" value={scale.characteristicCount} />
            <ScaleItem label="测量值" value={scale.measurementCount} />
            <ScaleItem label="不良类型" value={scale.defectTypeCount} />
          </Stack>
          {model && model.warnings.length > 0 ? (
            <Box sx={{ mt: 1.5 }} data-testid="report-warnings">
              {model.warnings.map((w) => (
                <Alert key={w} severity="warning" icon={false} sx={{ mb: 0.5 }}>
                  {w}
                </Alert>
              ))}
            </Box>
          ) : null}
        </CardContent>
      </Card>

      {/* 预览：CPK 汇总 */}
      {exportOptions.cpkSummary ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              CPK 汇总预览（sheet 1）
            </Typography>
            <div className="print-table">
              <DataTable
                columns={cpkColumns}
                rows={model?.cpkSummary ?? []}
                rowKey={(r) => r.characteristic}
                emptyContent="无有效测量值"
                maxHeight={320}
                data-testid="report-cpk-table"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 预览：不良统计 */}
      {exportOptions.defectStats ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              不良统计预览（sheet 2）
            </Typography>
            <div className="print-table">
              <DataTable
                columns={defectColumns}
                rows={model?.defectStats ?? []}
                rowKey={(r) => r.defectType}
                emptyContent="无不良记录"
                maxHeight={320}
                data-testid="report-defect-table"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* AI 分析导出（P4-B）：逐模块 LLM 分析 + Markdown / Excel 出口 */}
      <AiExportPanel model={model} {...(aiExtras ? { extras: aiExtras } : {})} />

      {/* 图表区：真实尺寸渲染，打印时按 .print-chart 分页。
          刻意**不加**打印强制分页（print-page-break）：实测 break-before: page 会让
          Chrome 在第一次打印时多吐一张空白页（见 src/print.css 末尾的 A/B 记录）。 */}
      {hasCharts(exportOptions) ? (
        <Stack spacing={2} data-testid="report-charts">
          <Typography variant="h6" fontWeight={600}>
            图表
          </Typography>

          {exportOptions.controlChartImage ? (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                  控制图{controlState?.characteristicName ? `（${controlState.characteristicName}）` : ''}
                </Typography>
                {controlState?.series ? (
                  <ControlChart
                    series={controlState.series}
                    violations={controlState.evaluation?.violations ?? []}
                    height={300}
                  />
                ) : (
                  <Alert severity="info" icon={false}>
                    {controlState?.error ?? '当前数据无法构造控制图，请确认子组容量与测量值数量。'}
                  </Alert>
                )}
              </CardContent>
            </Card>
          ) : null}

          {exportOptions.paretoChartImage ? (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                  柏拉图（80% 分界线）
                </Typography>
                {pareto ? (
                  <div className="print-chart">
                    <ParetoChart pareto={pareto} height={320} />
                  </div>
                ) : (
                  <Alert severity="info" icon={false}>
                    当前数据集无不良记录，无法生成柏拉图。
                  </Alert>
                )}
              </CardContent>
            </Card>
          ) : null}

          {exportOptions.capabilityChartImage ? (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                  能力图（直方图 + USL/LSL）
                </Typography>
                {capabilityAnalysis && capabilityAnalysis.histogram.bins.length > 0 ? (
                  <div className="print-chart">
                    <HistogramChart
                      histogram={capabilityAnalysis.histogram}
                      spec={effectiveSpec}
                      height={320}
                    />
                  </div>
                ) : (
                  <Alert severity="info" icon={false}>
                    当前特性测量值不足，无法生成能力图。
                  </Alert>
                )}
              </CardContent>
            </Card>
          ) : null}
        </Stack>
      ) : null}

      {/* 预览：原始尺寸（长表，限量渲染） */}
      {exportOptions.rawDimensions ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              原始尺寸预览（sheet 3）
            </Typography>
            {rawDimensions.length > RAW_PREVIEW_LIMIT ? (
              <Typography variant="caption" color="text.secondary" data-testid="raw-dim-truncated">
                共 {rawDimensions.length} 行，此处仅显示前 {RAW_PREVIEW_LIMIT} 行；完整数据请导出 Excel。
              </Typography>
            ) : null}
            {rawDimensions.length > PRINT_PREVIEW_LIMIT ? (
              <Typography
                variant="caption"
                color="text.secondary"
                data-testid="print-cap-note-raw-dimensions"
                sx={{ display: 'none', '@media print': { display: 'block' } }}
              >
                共 {rawDimensions.length} 行，打印仅含前 {PRINT_PREVIEW_LIMIT} 行；完整数据请用「导出 Excel」。
              </Typography>
            ) : null}
            <div className="print-table print-table-split">
              <DataTable
                columns={rawDimensionColumns}
                rows={rawDimensions.slice(0, RAW_PREVIEW_LIMIT)}
                rowKey={(r, i) => `${r.characteristic}-${r.index}-${i}`}
                emptyContent="无测量记录"
                maxHeight={320}
                data-testid="report-raw-dimensions-table"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* 预览：原始不良 */}
      {exportOptions.rawDefects ? (
        <Card variant="outlined">
          <CardContent>
            <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
              原始不良预览（sheet 4）
            </Typography>
            {rawDefects.length > PRINT_PREVIEW_LIMIT ? (
              <Typography
                variant="caption"
                color="text.secondary"
                data-testid="print-cap-note-raw-defects"
                sx={{ display: 'none', '@media print': { display: 'block' } }}
              >
                共 {rawDefects.length} 行，打印仅含前 {PRINT_PREVIEW_LIMIT} 行；完整数据请用「导出 Excel」。
              </Typography>
            ) : null}
            <div className="print-table print-table-split">
              <DataTable
                columns={rawDefectColumns}
                rows={rawDefects}
                rowKey={(r, i) => `${r.defectType}-${i}`}
                emptyContent="无不良记录"
                maxHeight={320}
                data-testid="report-raw-defects-table"
              />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </Stack>
  );
}

/** 是否至少勾选一张图表。 */
function hasCharts(options: ExportOptions): boolean {
  return CHART_OPTION_KEYS.some((key) => options[key]);
}

/** 数据规模项。 */
function ScaleItem({ label, value }: { label: string; value: number }): ReactElement {
  return (
    <Stack spacing={0.25}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </Typography>
    </Stack>
  );
}