/**
 * CapabilityPage —— 能力分析页（P0-12 / P0-13 / P0-14）。
 *
 * 出处：架构文档 §2.8、§8.2；PRD P0-12/P0-13/P0-14。
 *
 * 功能：
 * 1. 特性选择器 + 配置卡（子组容量默认 n=5 / 划分方式 / 异常值方法 / 单双侧规格）；
 * 2. 结果表：均值、双口径 σ、Ca、Cp、Cpk、Pp、Ppk、双西格玛水平、PPM；
 * 3. 直方图叠 USL/LSL/目标线；
 * 4. 正态性结论卡（AD / S-W 统计量与 p 值，p<0.05 告警）；
 * 5. 异常值两步处理：标注 → 人工勾选确认（可撤销）。
 *
 * 数值格式：均值/σ/指数 4 位，西格玛水平 2 位，PPM 整数；不可计算显示 N/A 或 —。
 */

import { useEffect, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import Checkbox from '@mui/material/Checkbox';
import { WarningAmber as WarningAmberIcon } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { normalityConclusion, type CapabilityWarning } from '@/core';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useUiStore } from '@/store/uiStore';
import { useCapabilityAnalysis } from '@/ui/hooks/useCapabilityAnalysis';
import { useProjectPersistence } from '@/ui/hooks/useProjectPersistence';
import NumberCell from '@/ui/components/NumberCell';
import StatCard from '@/ui/components/StatCard';
import EmptyState from '@/ui/components/EmptyState';
import HistogramChart from '@/ui/charts/HistogramChart';
import { formatIndex, formatNumber, formatPpm, formatSigmaLevel } from '@/ui/format';

/** 告警文案映射。 */
const WARNING_TEXT: Record<CapabilityWarning, string> = {
  NO_SUBGROUP_STRUCTURE: '无子组结构，Cp/Cpk 不可计算（已尝试 I-MR 降级估计 σ_within）。',
  ONLY_ONE_SIDED_SPEC: '仅提供单侧规格，Cp / Pp 不可计算（显示 N/A）。',
  SIGMA_WITHIN_ZERO: '组内 σ 为 0，相关指数不可计算。',
  NON_NORMAL_DATA: '数据非正态，Cpk/PPM 基于正态假设，建议参考非正态能力分析。',
  INSUFFICIENT_SAMPLE: '样本量不足，结果仅供参考。',
};

/**
 * 渲染能力分析页。
 *
 * @returns 页面元素
 */
export default function CapabilityPage(): ReactElement {
  const dataset = useProjectStore((s) => s.dataset);
  const selectedId = useProjectStore((s) => s.selectedCharacteristicId);
  const selectCharacteristic = useProjectStore((s) => s.selectCharacteristic);
  const setMeasurementsExcluded = useProjectStore((s) => s.setMeasurementsExcluded);
  const pushToast = useUiStore((s) => s.pushToast);

  const capacity = useAnalysisStore((s) => s.subgroupCapacity);
  const setCapacity = useAnalysisStore((s) => s.setSubgroupCapacity);
  const subgroupMode = useAnalysisStore((s) => s.subgroupMode);
  const setSubgroupMode = useAnalysisStore((s) => s.setSubgroupMode);
  const outlierMethod = useAnalysisStore((s) => s.outlierMethod);
  const setOutlierMethod = useAnalysisStore((s) => s.setOutlierMethod);
  const spec = useAnalysisStore((s) => s.spec);
  const setSpec = useAnalysisStore((s) => s.setSpec);
  const candidates = useAnalysisStore((s) => s.outlierCandidates);
  const detectOutliersFor = useAnalysisStore((s) => s.detectOutliersFor);
  const toggleOutlierSelection = useAnalysisStore((s) => s.toggleOutlierSelection);
  const setAllOutlierConfirmed = useAnalysisStore((s) => s.setAllOutlierConfirmed);
  const resetOutliers = useAnalysisStore((s) => s.resetOutliers);

  const { persist } = useProjectPersistence();
  const { analysis } = useCapabilityAnalysis();

  // 挂载或切换特性时自动标注异常值（步骤 1：仅标注，不删除）。
  useEffect(() => {
    if (analysis && analysis.values.length > 0) {
      detectOutliersFor(analysis.values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, outlierMethod]);

  const cap = analysis?.capability ?? null;

  const confirmedCount = useMemo(
    () => candidates.filter((c) => c.confirmed).length,
    [candidates],
  );

  /** 步骤 3：应用勾选（写入 projectStore 真实排除）。 */
  const applyExclusions = (): void => {
    if (!selectedId) {
      return;
    }
    const indices = candidates.filter((c) => c.confirmed).map((c) => c.index);
    setMeasurementsExcluded(selectedId, indices);
    pushToast(`已确认排除 ${indices.length} 个异常值`, 'success');
    void persist();
  };

  /** 撤销：清空勾选并恢复测量值。 */
  const undoExclusions = (): void => {
    if (!selectedId) {
      return;
    }
    setMeasurementsExcluded(selectedId, []);
    resetOutliers();
    pushToast('已撤销异常值排除，恢复全部数据', 'info');
    if (analysis && analysis.values.length > 0) {
      detectOutliersFor(analysis.values);
    }
  };

  if (!dataset || dataset.characteristics.length === 0) {
    return (
      <EmptyState
        title="尚无可分析的数据"
        description="请先在「数据导入」页导入测量数据，再回到本页进行过程能力分析。"
      />
    );
  }

  return (
    <Stack spacing={2.5} data-testid="capability-page">
      <Typography variant="h6" fontWeight={600}>
        过程能力分析
      </Typography>

      {/* 特性选择 + 配置卡 */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="char-label">特性</InputLabel>
              <Select
                labelId="char-label"
                label="特性"
                value={selectedId ?? ''}
                onChange={(e) => selectCharacteristic(String(e.target.value))}
                data-testid="characteristic-select"
              >
                {dataset.characteristics.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}（n={c.measurements.length}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="mode-label">划分方式</InputLabel>
              <Select
                labelId="mode-label"
                label="划分方式"
                value={subgroupMode}
                onChange={(e) => setSubgroupMode(e.target.value as 'fixed' | 'byColumn' | 'manual')}
              >
                <MenuItem value="fixed">固定容量</MenuItem>
                <MenuItem value="byColumn">按列</MenuItem>
                <MenuItem value="manual">手动</MenuItem>
              </Select>
            </FormControl>

            <TextField
              size="small"
              type="number"
              label="子组容量 n"
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value))}
              inputProps={{ min: 2, max: 25, 'data-testid': 'capacity-input' }}
              sx={{ width: 130 }}
            />

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="outlier-label">异常值方法</InputLabel>
              <Select
                labelId="outlier-label"
                label="异常值方法"
                value={outlierMethod}
                onChange={(e) => setOutlierMethod(e.target.value as 'grubbs' | 'iqr')}
              >
                <MenuItem value="grubbs">Grubbs（默认）</MenuItem>
                <MenuItem value="iqr">1.5 IQR</MenuItem>
              </Select>
            </FormControl>

            <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', md: 'block' } }} />

            <TextField
              size="small"
              type="number"
              label="USL（上限）"
              value={spec.usl ?? ''}
              onChange={(e) => setSpec({ usl: e.target.value === '' ? null : Number(e.target.value) })}
              sx={{ width: 130 }}
            />
            <TextField
              size="small"
              type="number"
              label="LSL（下限）"
              value={spec.lsl ?? ''}
              onChange={(e) => setSpec({ lsl: e.target.value === '' ? null : Number(e.target.value) })}
              sx={{ width: 130 }}
            />
            <TextField
              size="small"
              type="number"
              label="目标值"
              value={spec.target ?? ''}
              onChange={(e) => setSpec({ target: e.target.value === '' ? null : Number(e.target.value) })}
              sx={{ width: 120 }}
            />
            <TextField
              size="small"
              label="单位"
              value={spec.unit}
              onChange={(e) => setSpec({ unit: e.target.value })}
              sx={{ width: 100 }}
            />
          </Stack>
        </CardContent>
      </Card>

      {!analysis || !cap ? (
        <Alert severity="info">无有效测量值（可能全部被排除或为空），请检查数据。</Alert>
      ) : (
        <>
          {/* 告警 */}
          {cap.warnings.length > 0 ? (
            <Stack spacing={1}>
              {cap.warnings.map((w) => (
                <Alert key={w} severity="warning" icon={<WarningAmberIcon />}>
                  {WARNING_TEXT[w]}
                </Alert>
              ))}
            </Stack>
          ) : null}

          {/* 结果表：双口径 σ + 指数 */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1.5 }}>
                能力指数结果
              </Typography>
              <Table size="small" data-testid="capability-table">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 600 }}>指标</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 600 }}>
                      数值
                    </TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>说明</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  <ResultRow label="测量数 n" value={String(cap.n)} hint="参与计算的有效测量数" />
                  <ResultRow label="均值 X̄" value={formatNumber(cap.mean, 4)} hint="4 位小数" />
                  <ResultRow
                    label="组内 σ (within)"
                    value={formatNumber(cap.sigma.within, 4)}
                    hint={`用于 Cp/Cpk；估计法：${cap.sigma.basis}`}
                  />
                  <ResultRow
                    label="整体 σ (overall)"
                    value={formatNumber(cap.sigma.overall, 4)}
                    hint="用于 Pp/Ppk；ddof=1"
                  />
                  <ResultRow label="Ca 准确度" value={formatIndex(cap.ca)} hint="有符号；无目标中心时为 N/A" />
                  <ResultRow
                    label="Cp"
                    value={formatIndex(cap.cp)}
                    hint={cap.cp === null ? '单侧规格不可计算（N/A）' : '基于组内 σ'}
                    testId="cp-cell"
                  />
                  <ResultRow label="Cpk" value={formatIndex(cap.cpk)} hint="min(Cpu, Cpl)" testId="cpk-cell" />
                  <ResultRow
                    label="Pp"
                    value={formatIndex(cap.pp)}
                    hint={cap.pp === null ? '单侧规格不可计算（N/A）' : '基于整体 σ'}
                    testId="pp-cell"
                  />
                  <ResultRow label="Ppk" value={formatIndex(cap.ppk)} hint="min(Ppu, Ppl)" testId="ppk-cell" />
                  <ResultRow
                    label="西格玛水平（短期）"
                    value={formatSigmaLevel(cap.sigmaLevelShort)}
                    hint="短期能力(3×Cpk)"
                    testId="sigma-short-cell"
                  />
                  <ResultRow
                    label="西格玛水平（工程）"
                    value={formatSigmaLevel(cap.sigmaLevelBench)}
                    hint="工程口径(含1.5σ漂移)"
                    testId="sigma-bench-cell"
                  />
                  <ResultRow
                    label="PPM（整体口径）"
                    value={formatPpm(cap.ppmOverall)}
                    hint="基于整体 σ 的双侧期望不良率"
                  />
                  <ResultRow
                    label="PPM（组内口径）"
                    value={formatPpm(cap.ppmWithin)}
                    hint="基于组内 σ 的潜在不良率"
                  />
                </TableBody>
              </Table>
              <Alert severity="info" icon={false} sx={{ mt: 1.5, py: 0.5 }}>
                两个西格玛水平相差 1.5σ，用于不同场景，请勿混用：短期能力(3×Cpk) 反映当前过程潜力，
                工程口径(含1.5σ漂移) 反映长期可期望水平。
              </Alert>
            </CardContent>
          </Card>

          {/* 概览卡 */}
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' },
              gap: 1.5,
            }}
          >
            <StatCard label="Cp" value={formatIndex(cap.cp)} alert={cap.cp !== null && cap.cp < 1.33} />
            <StatCard label="Cpk" value={formatIndex(cap.cpk)} alert={cap.cpk !== null && cap.cpk < 1.33} />
            <StatCard label="Pp" value={formatIndex(cap.pp)} />
            <StatCard label="Ppk" value={formatIndex(cap.ppk)} alert={cap.ppk !== null && cap.ppk < 1.33} />
          </Box>

          {/* 直方图 */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                直方图（含规格限）
              </Typography>
              <HistogramChart histogram={analysis.histogram} spec={cap.spec} />
            </CardContent>
          </Card>

          {/* 正态性结论卡 */}
          <Card variant="outlined" data-testid="normality-card">
            <CardContent>
              <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  正态性检验
                </Typography>
                <Chip
                  size="small"
                  color={analysis.normality.primary.pValue < 0.05 ? 'error' : 'success'}
                  label={analysis.normality.primary.pValue < 0.05 ? '非正态告警' : '未拒绝正态'}
                  variant="outlined"
                />
              </Stack>
              <Stack spacing={0.5}>
                <Typography variant="body2">
                  主方法（{analysis.normality.primary.method}）：统计量 =
                  {formatNumber(analysis.normality.primary.statistic, 4)}，p =
                  {formatNumber(analysis.normality.primary.pValue, 4)}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  AD：统计量 ={formatNumber(analysis.normality.ad.statistic, 4)}，p =
                  {formatNumber(analysis.normality.ad.pValue, 4)}
                  {analysis.normality.sw
                    ? ` ｜ S-W：统计量 =${formatNumber(analysis.normality.sw.statistic, 4)}，p =${formatNumber(
                        analysis.normality.sw.pValue,
                        4,
                      )}`
                    : ' ｜ S-W：样本量不足或过大，未计算'}
                </Typography>
                <Typography
                  variant="body2"
                  color={analysis.normality.primary.pValue < 0.05 ? 'error.main' : 'text.secondary'}
                >
                  {normalityConclusion(analysis.normality.primary)}
                </Typography>
              </Stack>
            </CardContent>
          </Card>

          {/* 异常值两步处理 */}
          <Card variant="outlined" data-testid="outlier-card">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 0.5 }}>
                异常值处理（标注 → 人工确认）
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                系统仅「标注」疑似异常值，不会自动删除。请勾选确认要排除的测量值，确认后才从计算中剔除；可随时撤销。
              </Typography>
              {candidates.length === 0 ? (
                <Alert severity="success" icon={false}>
                  未检测到异常值（方法：{outlierMethod === 'grubbs' ? 'Grubbs' : '1.5 IQR'}）。
                </Alert>
              ) : (
                <>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                    <Chip size="small" label={`候选 ${candidates.length}`} />
                    <Chip size="small" color="primary" label={`已勾选 ${confirmedCount}`} />
                    <Box sx={{ flexGrow: 1 }} />
                    <Button size="small" onClick={() => setAllOutlierConfirmed(true)}>
                      全选
                    </Button>
                    <Button size="small" onClick={() => setAllOutlierConfirmed(false)}>
                      全不选
                    </Button>
                  </Stack>
                  <Stack direction="row" spacing={1.5} sx={{ mb: 1.5 }}>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={confirmedCount === 0}
                      onClick={applyExclusions}
                      data-testid="apply-exclusions"
                    >
                      确认排除已勾选项
                    </Button>
                    <Button variant="outlined" size="small" color="inherit" onClick={undoExclusions}>
                      撤销全部排除
                    </Button>
                  </Stack>
                  <Table size="small" data-testid="outlier-table">
                    <TableHead>
                      <TableRow>
                        <TableCell padding="checkbox" />
                        <TableCell align="right" sx={{ fontWeight: 600 }}>
                          序号
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>
                          测量值
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>
                          统计量
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 600 }}>
                          临界值
                        </TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {candidates.map((c) => (
                        <TableRow key={`outlier-${c.index}`} hover>
                          <TableCell padding="checkbox">
                            <Checkbox
                              size="small"
                              checked={c.confirmed}
                              onChange={() => toggleOutlierSelection(c.index)}
                              inputProps={{ 'aria-label': `确认排除第 ${c.index + 1} 个测量值` }}
                            />
                          </TableCell>
                          <TableCell align="right">{c.index + 1}</TableCell>
                          <TableCell align="right">
                            <NumberCell value={analysis.values[c.index]} kind="measurement" />
                          </TableCell>
                          <TableCell align="right">{formatNumber(c.statistic, 4)}</TableCell>
                          <TableCell align="right">{formatNumber(c.threshold, 4)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </Stack>
  );
}

/** 结果表的一行。 */
function ResultRow({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId?: string;
}): ReactElement {
  return (
    <TableRow>
      <TableCell>{label}</TableCell>
      <TableCell align="right" data-testid={testId} sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </TableCell>
      <TableCell sx={{ color: 'text.secondary' }}>{hint}</TableCell>
    </TableRow>
  );
}
