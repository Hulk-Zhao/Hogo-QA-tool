/**
 * ControlChartPage —— 控制图页 + 判异准则 UI（P0-03~P0-06、P0-08~P0-11）。
 *
 * 出处：架构文档 T04；PRD §4.3、P0-10/P0-11。
 *
 * 功能：
 *   1. 图型选择（Xbar-R / Xbar-S / I-MR / P / NP / C / U）；
 *   2. 控制图渲染（控制限 / 分区带 / 违规高亮 / 点击定位）；
 *   3. 违规明细表（去重 + Wk/Nk 等效标注）→ 点击定位到侧栏子组明细；
 *   4. 12 条规则逐条开关（即时生效）；
 *   5. 变限 P/U 逐点变限提示；n 越界报错提示。
 */

import { useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  Typography,
} from '@mui/material';
import type { ReactElement } from 'react';
import {
  RULE_META,
  defaultToggleConfig,
  type ChartType,
  type NelsonRuleId,
  type RuleId,
  type RuleToggleConfig,
  type WesternRuleId,
} from '@/core';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useControlChart, isAttributeChart } from '@/ui/hooks/useControlChart';
import ControlChart from '@/ui/charts/ControlChart';
import RuleViolationTable from '@/ui/charts/RuleViolationTable';
import EmptyState from '@/ui/components/EmptyState';
import { formatNumber } from '@/ui/format';

/** 可选图型与中文标签。 */
const CHART_TYPE_LABEL: Record<ChartType, string> = {
  'Xbar-R': 'X̄-R 图（计量型，n≤10）',
  'Xbar-S': 'X̄-S 图（计量型，n>10）',
  'I-MR': 'I-MR 图（单值-移动极差）',
  P: 'P 图（不合格品率，可变 n）',
  NP: 'NP 图（不合格品数，恒定 n）',
  C: 'C 图（缺陷数，恒定区域）',
  U: 'U 图（单位缺陷数，可变 n）',
};

/** 全部图型（顺序固定）。 */
const CHART_TYPES: ChartType[] = ['Xbar-R', 'Xbar-S', 'I-MR', 'P', 'NP', 'C', 'U'];

/**
 * 渲染控制图页。
 *
 * @returns 页面元素
 */
export default function ControlChartPage(): ReactElement {
  const dataset = useProjectStore((s) => s.dataset);
  const selectedId = useProjectStore((s) => s.selectedCharacteristicId);
  const selectCharacteristic = useProjectStore((s) => s.selectCharacteristic);
  const capacity = useAnalysisStore((s) => s.subgroupCapacity);
  const setCapacity = useAnalysisStore((s) => s.setSubgroupCapacity);

  const [chartType, setChartType] = useState<ChartType>('Xbar-R');
  const [toggles, setToggles] = useState<RuleToggleConfig>(() => defaultToggleConfig());
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);

  const state = useControlChart(chartType, toggles);
  const series = state.series;

  /** 切换单条规则开关（即时生效）。 */
  const toggleRule = (ruleId: RuleId, enabled: boolean): void => {
    setToggles((prev) => {
      if (ruleId.startsWith('W')) {
        const we = { ...prev.westernElectric, [ruleId as WesternRuleId]: enabled };
        return { ...prev, westernElectric: we };
      }
      const nelson = { ...prev.nelson, [ruleId as NelsonRuleId]: enabled };
      return { ...prev, nelson };
    });
  };

  /** 启用/停用整个规则组。 */
  const setGroupAll = (group: 'westernElectric' | 'nelson', enabled: boolean): void => {
    setToggles((prev) => {
      if (group === 'westernElectric') {
        return {
          ...prev,
          westernElectric: { W1: enabled, W2: enabled, W3: enabled, W4: enabled },
        };
      }
      return {
        ...prev,
        nelson: {
          N1: enabled,
          N2: enabled,
          N3: enabled,
          N4: enabled,
          N5: enabled,
          N6: enabled,
          N7: enabled,
          N8: enabled,
        },
      };
    });
  };

  const violations = useMemo(
    () => state.evaluation?.violations ?? [],
    [state.evaluation],
  );
  const highCount = useMemo(
    () => violations.filter((v) => v.severity === 'high').length,
    [violations],
  );

  // 侧栏子组明细：以选中点为中心展示相邻点。
  const sidebarRows = useMemo(() => {
    if (!series || selectedPoint === null) {
      return [];
    }
    const points = series.primary.points;
    const start = Math.max(0, selectedPoint - 2);
    const end = Math.min(points.length - 1, selectedPoint + 2);
    const rows: { index: number; xLabel: string; value: number; size: number }[] = [];
    for (let i = start; i <= end; i += 1) {
      rows.push({
        index: i,
        xLabel: points[i].xLabel,
        value: points[i].value,
        size: points[i].subgroupSize,
      });
    }
    return rows;
  }, [series, selectedPoint]);

  if (!dataset || dataset.characteristics.length === 0) {
    return (
      <EmptyState
        testId="control-chart-page"
        title="尚无可分析的数据"
        description="请先在「数据导入」页导入测量数据，再回到本页绘制控制图。"
      />
    );
  }

  return (
    <Stack spacing={2.5} data-testid="control-chart-page">
      <Typography variant="h6" fontWeight={600}>
        控制图与判异准则
      </Typography>

      {/* 图型 + 子组容量选择 */}
      <Card variant="outlined" className="no-print">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} flexWrap="wrap" useFlexGap>
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="char-label">特性</InputLabel>
              <Select
                labelId="char-label"
                label="特性"
                value={selectedId ?? ''}
                onChange={(e) => {
                  selectCharacteristic(String(e.target.value));
                  setSelectedPoint(null);
                }}
                data-testid="cc-characteristic-select"
              >
                {dataset.characteristics.map((c) => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name}（n={c.measurements.length}）
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 240 }}>
              <InputLabel id="type-label">控制图类型</InputLabel>
              <Select
                labelId="type-label"
                label="控制图类型"
                value={chartType}
                onChange={(e) => {
                  setChartType(e.target.value as ChartType);
                  setSelectedPoint(null);
                }}
                data-testid="cc-type-select"
              >
                {CHART_TYPES.map((t) => (
                  <MenuItem key={t} value={t}>
                    {CHART_TYPE_LABEL[t]}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            <FormControl size="small" sx={{ minWidth: 150 }}>
              <InputLabel id="cap-label">子组容量 n</InputLabel>
              <Select
                labelId="cap-label"
                label="子组容量 n"
                value={capacity}
                onChange={(e) => setCapacity(Number(e.target.value))}
                disabled={!['Xbar-R', 'Xbar-S'].includes(chartType)}
                data-testid="cc-capacity-select"
              >
                {Array.from({ length: 24 }, (_, i) => i + 2).map((n) => (
                  <MenuItem key={n} value={n}>
                    n = {n}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
          </Stack>
        </CardContent>
      </Card>

      {/* 错误 / 变限提示 */}
      {state.error ? (
        <Alert severity="warning" data-testid="cc-error">
          {state.error}
        </Alert>
      ) : null}
      {isAttributeChart(chartType) && series?.limits.primary.some((l) => !l.isConstant) ? (
        <Alert severity="info" icon={false} data-testid="cc-variable-limit-hint">
          当前为变样本量 {chartType} 图，控制限按各样本量 n_i **逐点变限**（UCL/LCL 各点不同）。
        </Alert>
      ) : null}

      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 3fr) minmax(280px, 1fr)' }, gap: 2 }}>
        {/* 主区：图表 + 违规表 */}
        <Stack spacing={2.5} sx={{ minWidth: 0 }}>
          {series ? (
            <Card variant="outlined">
              <CardContent>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
                  <Typography variant="subtitle1" fontWeight={600}>
                    {state.characteristicName ?? '控制图'} · {CHART_TYPE_LABEL[chartType].split('（')[0]}
                  </Typography>
                  <Chip size="small" label={`常量表 n=${series.constantsUsed.n}`} variant="outlined" />
                  {violations.length > 0 ? (
                    <Chip size="small" color="error" label={`判异 ${violations.length} 处`} />
                  ) : (
                    <Chip size="small" color="success" label="过程受控" variant="outlined" />
                  )}
                </Stack>
                <ControlChart
                  series={series}
                  violations={violations}
                  onPointClick={(idx) => setSelectedPoint(idx)}
                  height={320}
                />
              </CardContent>
            </Card>
          ) : null}

          <Card variant="outlined">
            <CardContent>
              <Stack direction="row" spacing={1} alignItems="baseline" sx={{ mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={600}>
                  判异明细
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  共 {violations.length} 处（其中高严重级 {highCount} 处）；已按 §9.3 去重，
                  Wk/Nk 等效仅展示其一并标注。
                </Typography>
              </Stack>
              <div className="print-table">
                <RuleViolationTable
                  violations={violations}
                  onLocate={(idx) => setSelectedPoint(idx)}
                />
              </div>
            </CardContent>
          </Card>
        </Stack>

        {/* 侧栏：规则开关 + 子组明细定位 */}
        <Stack spacing={2.5}>
          <Card variant="outlined" className="no-print">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                判异准则开关
              </Typography>
              <FormControl component="fieldset" variant="standard" sx={{ mb: 1.5 }}>
                <FormLabel component="legend" sx={{ fontSize: 13 }}>
                  西方电气（默认全开）
                </FormLabel>
                <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                  <RuleButtons
                    variant="outlined"
                    size="small"
                    onClick={() => setGroupAll('westernElectric', true)}
                  >
                    全开
                  </RuleButtons>
                  <RuleButtons
                    variant="outlined"
                    size="small"
                    onClick={() => setGroupAll('westernElectric', false)}
                  >
                    全关
                  </RuleButtons>
                </Stack>
              </FormControl>

              {/* 西方电气 4 条 */}
              <RuleToggleGroup
                ids={['W1', 'W2', 'W3', 'W4']}
                toggles={toggles}
                onToggle={toggleRule}
                testId="cc-rule-toggles-we"
              />

              <Divider sx={{ my: 1.5 }} />

              <FormControl component="fieldset" variant="standard" sx={{ mb: 1.5 }}>
                <FormLabel component="legend" sx={{ fontSize: 13 }}>
                  尼尔森（N1~N4 默认关，避免与 W 重复）
                </FormLabel>
                <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                  <RuleButtons variant="outlined" size="small" onClick={() => setGroupAll('nelson', true)}>
                    全开
                  </RuleButtons>
                  <RuleButtons variant="outlined" size="small" onClick={() => setGroupAll('nelson', false)}>
                    全关
                  </RuleButtons>
                </Stack>
              </FormControl>

              <RuleToggleGroup
                ids={['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']}
                toggles={toggles}
                onToggle={toggleRule}
                testId="cc-rule-toggles-nelson"
              />
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" fontWeight={600} sx={{ mb: 1 }}>
                子组明细定位
              </Typography>
              {selectedPoint === null || sidebarRows.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                  点击图形上的数据点或判异明细行，可定位到对应子组。
                </Typography>
              ) : (
                <Stack spacing={0.5} data-testid="cc-point-detail">
                  {sidebarRows.map((r) => (
                    <Box
                      key={r.index}
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        px: 1,
                        py: 0.5,
                        borderRadius: 1,
                        bgcolor: r.index === selectedPoint ? 'primary.light' : 'transparent',
                        fontWeight: r.index === selectedPoint ? 600 : 400,
                      }}
                    >
                      <Typography variant="body2">
                        {r.xLabel}
                        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                          (n={r.size})
                        </Typography>
                      </Typography>
                      <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                        {formatNumber(r.value, 4)}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </CardContent>
          </Card>
        </Stack>
      </Box>
    </Stack>
  );
}

/** 规则开关按钮（避免重复样式，统一组件）。 */
function RuleButtons({
  children,
  ...rest
}: {
  children: ReactElement | string;
  variant: 'outlined';
  size: 'small';
  onClick: () => void;
}): ReactElement {
  // 直接使用 MUI Button 语义；此处用 Radio 的 label 风格会误用，改用轻量 Box。
  return (
    <Box
      component="button"
      type="button"
      onClick={rest.onClick}
      sx={{
        cursor: 'pointer',
        fontSize: 12,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        border: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {children}
    </Box>
  );
}

/** 一组规则开关。 */
function RuleToggleGroup({
  ids,
  toggles,
  onToggle,
  testId,
}: {
  ids: RuleId[];
  toggles: RuleToggleConfig;
  onToggle: (ruleId: RuleId, enabled: boolean) => void;
  testId: string;
}): ReactElement {
  return (
    <Stack spacing={0.25} data-testid={testId}>
      {ids.map((id) => {
        const meta = RULE_META[id];
        const enabled = id.startsWith('W')
          ? toggles.westernElectric[id as WesternRuleId]
          : toggles.nelson[id as NelsonRuleId];
        return (
          <FormControlLabel
            key={id}
            sx={{ m: 0, justifyContent: 'space-between', width: '100%' }}
            labelPlacement="start"
            control={
              <Switch
                size="small"
                checked={enabled}
                onChange={(_, checked) => onToggle(id, checked)}
                inputProps={{ 'aria-label': `规则 ${id}` }}
              />
            }
            label={
              <Stack spacing={0}>
                <Typography variant="body2">
                  <strong>{id}</strong> {meta.shortName}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {meta.description}
                </Typography>
              </Stack>
            }
          />
        );
      })}
    </Stack>
  );
}
