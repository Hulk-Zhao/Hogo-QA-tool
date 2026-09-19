/**
 * ReportPage —— 报表导出页（P0-18）。
 *
 * 出处：架构文档 T04；PRD P0-18。
 *
 * 功能：
 *   1. 预览报表关键指标（CPK 汇总 / 不良统计 / 原始数据规模）；
 *   2. 一键导出 Excel（≥4 sheet，**不含图片**）；
 *   3. 浏览器原生打印 / 输出 PDF（不引入 jsPDF）；
 *   4. 「含控制图/柏拉图截图」勾选项**仅作用于打印**，不影响 Excel。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  FormControlLabel,
  Stack,
  Typography,
} from '@mui/material';
import type { ReactElement } from 'react';
import { useProjectStore, buildProjectFromDataset } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import DataTable, { type DataTableColumn } from '@/ui/components/DataTable';
import EmptyState from '@/ui/components/EmptyState';
import NumberCell from '@/ui/components/NumberCell';
import {
  buildModel,
  exportExcelReport,
  printReport,
  type ExportOptions,
} from '@/services/report';
import type { CpKSummaryRow, DefectStatRow } from '@/data/exporter/reportModel';

/** 报表数据集规模摘要。 */
interface ScaleSummary {
  characteristicCount: number;
  measurementCount: number;
  defectTypeCount: number;
}

/**
 * 渲染报表导出页。
 *
 * @returns 页面元素
 */
export default function ReportPage(): ReactElement {
  const dataset = useProjectStore((s) => s.dataset);
  const project = useProjectStore((s) => s.project);
  const projectName = useProjectStore((s) => s.projectName);
  const pushToast = useUiStore((s) => s.pushToast);

  const [options, setOptions] = useState<ExportOptions>({
    includeChartImagesInPrint: true,
    includeTables: true,
  });

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

  /** 导出 Excel。 */
  const handleExportExcel = (): void => {
    if (!model) {
      pushToast('无可用数据，无法导出报表', 'warning');
      return;
    }
    try {
      const fileName = exportExcelReport(model);
      pushToast(`已导出 Excel：${fileName}（4 sheet，不含图片）`, 'success');
    } catch (e) {
      pushToast(`导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 打印 / 导出 PDF。 */
  const handlePrint = (): void => {
    pushToast(
      options.includeChartImagesInPrint
        ? '已唤起打印，输出将包含图表'
        : '已唤起打印，输出将不含图表',
      'info',
    );
    printReport(options);
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

  if (!dataset || dataset.characteristics.length === 0) {
    return (
      <EmptyState
        title="尚无可导出的数据"
        description="请先在「数据导入」页导入测量数据，再回到本页生成质量日报。"
      />
    );
  }

  return (
    <Stack spacing={2.5} data-testid="report-page">
      <Typography variant="h6" fontWeight={600}>
        一键质量日报导出
      </Typography>

      {/* 导出操作卡 */}
      <Card variant="outlined" className="no-print">
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1" fontWeight={600}>
              导出方式
            </Typography>
            <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
              <Button variant="contained" onClick={handleExportExcel} data-testid="export-excel">
                导出 Excel（≥4 sheet）
              </Button>
              <Button variant="outlined" onClick={handlePrint} data-testid="print-report">
                打印 / 输出 PDF
              </Button>
            </Stack>

            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={options.includeChartImagesInPrint}
                  onChange={(_, checked) =>
                    setOptions((o) => ({ ...o, includeChartImagesInPrint: checked }))
                  }
                  data-testid="include-chart-images"
                />
              }
              label="打印/PDF 中包含控制图与柏拉图截图（仅作用于打印，Excel 永不含图片）"
            />
            <FormControlLabel
              control={
                <Checkbox
                  size="small"
                  checked={options.includeTables}
                  onChange={(_, checked) => setOptions((o) => ({ ...o, includeTables: checked }))}
                />
              }
              label="打印/PDF 中包含数据表"
            />

            <Alert severity="info" icon={false}>
              Excel 导出的 4 个 sheet：CPK汇总 / 不良统计 / 原始尺寸 / 原始不良，均为纯数据，
              <strong>不含图片</strong>。PDF 通过浏览器原生打印生成（不引入 jsPDF，避免中文字体撑大体积）。
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

      {/* 预览：不良统计 */}
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
    </Stack>
  );
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
