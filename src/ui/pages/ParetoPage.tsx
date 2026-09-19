/**
 * ParetoPage —— 柏拉图页（P0-17）。
 *
 * 出处：架构文档 §2.8、§6；PRD P0-17。
 *
 * 功能：
 * 1. ECharts 交互式：柱状（左轴数量）+ 累计占比折线（右轴 %）+ 80% 分界线；
 * 2. 悬浮 tooltip 显示频数与累计占比；
 * 3. 降序排列；
 * 4. 「其他」合并阈值可调。
 *
 * 数据来源：当前数据集的 defectRecords（缺陷记录）。
 * T02/T03 对接：defect sheet 由 `@/data/importer` 的 xlsx/csv 解析经
 * `buildModel` 写入 `dataset.defectRecords`，本页直接消费，无需自带解析。
 * 若数据集无 defectRecords，则提供「示例数据」以便演示链路。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Slider,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { ReactElement } from 'react';
import { buildPareto, type ParetoItem } from '@/core';
import { useProjectStore } from '@/store/projectStore';
import ParetoChart from '@/ui/charts/ParetoChart';
import DataTable, { type DataTableColumn } from '@/ui/components/DataTable';
import EmptyState from '@/ui/components/EmptyState';
import NumberCell from '@/ui/components/NumberCell';

/**
 * buildPareto 的输入记录类型（从 core 公开签名派生，避免修改冻结的 core）。
 */
type DefectRecordInput = Parameters<typeof buildPareto>[0][number];

/** 示例缺陷数据（供无 defectRecords 时演示）。 */
const SAMPLE_DEFECTS: DefectRecordInput[] = [
  { defectType: '划伤', count: 42, category: '外观' },
  { defectType: '毛边', count: 31, category: '外观' },
  { defectType: '尺寸超差', count: 18, category: '尺寸' },
  { defectType: '气孔', count: 12, category: '材质' },
  { defectType: '色差', count: 6, category: '外观' },
  { defectType: '其他小类', count: 3, category: '其他' },
];

/**
 * 渲染柏拉图页。
 *
 * @returns 页面元素
 */
export default function ParetoPage(): ReactElement {
  const dataset = useProjectStore((s) => s.dataset);
  const [useSample, setUseSample] = useState(false);
  const [otherThreshold, setOtherThreshold] = useState(5); // 单位 %
  const [crossingThreshold, setCrossingThreshold] = useState(80);

  const records: DefectRecordInput[] = useMemo(() => {
    if (dataset && dataset.defectRecords.length > 0) {
      return dataset.defectRecords.map((d) => ({
        defectType: d.defectType,
        count: d.count,
        category: d.category,
      }));
    }
    return useSample ? SAMPLE_DEFECTS : [];
  }, [dataset, useSample]);

  const pareto = useMemo(
    () => (records.length > 0 ? buildPareto(records, crossingThreshold, '其他', otherThreshold / 100) : null),
    [records, otherThreshold, crossingThreshold],
  );

  const columns: DataTableColumn<ParetoItem>[] = [
    { key: 'type', header: '缺陷类型', render: (row) => row.defectType },
    { key: 'count', header: '数量', align: 'right', render: (row) => row.count },
    {
      key: 'ratio',
      header: '占比',
      align: 'right',
      render: (row) => <NumberCell value={row.ratio} kind="ratio" />,
    },
    {
      key: 'cum',
      header: '累计占比',
      align: 'right',
      render: (row) => <NumberCell value={row.cumRatio} kind="ratio" />,
    },
    {
      key: 'other',
      header: '备注',
      render: (row) => (row.isOther ? '已合并' : ''),
    },
  ];

  return (
    <Stack spacing={2.5} data-testid="pareto-page">
      <Typography variant="h6" fontWeight={600}>
        柏拉图分析
      </Typography>

      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} alignItems="center">
            <Box sx={{ minWidth: 240, flexGrow: 1 }}>
              <Typography variant="body2" gutterBottom>
                「其他」合并阈值：{otherThreshold}%（低于最大值该比例的类型合并）
              </Typography>
              <Slider
                size="small"
                value={otherThreshold}
                min={0}
                max={20}
                step={1}
                onChange={(_, v) => setOtherThreshold(Array.isArray(v) ? v[0] : v)}
                valueLabelDisplay="auto"
              />
            </Box>
            <TextField
              size="small"
              type="number"
              label="80% 分界线"
              value={crossingThreshold}
              onChange={(e) => setCrossingThreshold(Number(e.target.value) || 80)}
              sx={{ width: 140 }}
              inputProps={{ min: 1, max: 100 }}
            />
            {!dataset || dataset.defectRecords.length === 0 ? (
              <Button variant="outlined" onClick={() => setUseSample((v) => !v)}>
                {useSample ? '隐藏示例数据' : '使用示例数据'}
              </Button>
            ) : null}
          </Stack>
        </CardContent>
      </Card>

      {!pareto ? (
        <EmptyState
          title="暂无缺陷数据"
          description="柏拉图需要「缺陷类型 + 数量」数据。请导入含缺陷统计的文件，或点击上方「使用示例数据」查看效果。"
        />
      ) : (
        <>
          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  柏拉图（降序）
                </Typography>
                {pareto.crossingIndex !== null ? (
                  <Typography variant="body2" color="text.secondary">
                    累计占比首次达到 {pareto.threshold}% 位于第 {pareto.crossingIndex + 1} 项
                  </Typography>
                ) : null}
              </Stack>
              <ParetoChart pareto={pareto} />
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                明细表
              </Typography>
              <DataTable
                columns={columns}
                rows={pareto.items}
                rowKey={(row) => row.defectType}
                emptyContent="无数据"
                data-testid="pareto-table"
              />
            </CardContent>
          </Card>

          <Alert severity="info" icon={false}>
            共 {pareto.total} 条缺陷记录，聚合为 {pareto.items.length} 个类型。降序排列，累计占比以竖线
            {pareto.threshold}% 为分界。
          </Alert>
        </>
      )}
    </Stack>
  );
}
