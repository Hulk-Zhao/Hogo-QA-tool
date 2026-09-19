/**
 * RuleViolationTable —— 判异违规明细表（含去重与 Wk/Nk 等效标注）。
 *
 * 出处：架构文档 T04；§9.3（去重层）；PRD P0-10（可点击定位）、P0-11（逐条开关）。
 *
 * 设计要点（可测性）：违规行与「规则号 / 涉及点 / 消息」的纯映射抽为
 * `toViolationRows()`，可在 node 环境直接测试；React 组件只做渲染 +
 * 行点击回调。
 */

import { Chip, Stack, Typography } from '@mui/material';
import type { ReactElement } from 'react';
import type { RuleId, RuleViolation } from '@/core';
import { RULE_META } from '@/core';
import DataTable, { type DataTableColumn } from '@/ui/components/DataTable';

/** 违规明细行（纯数据，可测）。 */
export interface ViolationRow {
  /** 稳定 key（windowStart + ruleId + 涉及点）。 */
  key: string;
  ruleId: RuleId;
  /** 规则短名（如「1点超3σ」）。 */
  shortName: string;
  /** 规则组中文名。 */
  groupLabel: string;
  /** 涉及点（1-based 展示）。 */
  pointsText: string;
  /** 窗口起点（1-based）。 */
  windowStartText: string;
  message: string;
  severity: RuleViolation['severity'];
  /** 主定位点（windowStart）。 */
  pointIndex: number;
}

const GROUP_LABEL: Record<RuleViolation['ruleGroup'], string> = {
  westernElectric: '西方电气',
  nelson: '尼尔森',
};

const SEVERITY_LABEL: Record<RuleViolation['severity'], string> = {
  high: '高',
  medium: '中',
  low: '低',
};

const SEVERITY_COLOR: Record<RuleViolation['severity'], 'error' | 'warning' | 'default'> = {
  high: 'error',
  medium: 'warning',
  low: 'default',
};

/**
 * 把违规列表转换为展示行（纯函数）。
 *
 * @param violations 违规列表（建议先经 dedupeViolations 去重）
 * @returns 展示行数组
 */
export function toViolationRows(violations: RuleViolation[]): ViolationRow[] {
  return violations.map((v) => {
    const meta = RULE_META[v.ruleId];
    const points = [...v.pointIndices].sort((a, b) => a - b);
    const pointsText =
      points.length === 1
        ? `第 ${points[0] + 1} 点`
        : `第 ${points.map((p) => p + 1).join(' / ')} 点`;
    return {
      key: `${v.ruleId}-${v.windowStart}-${points.join(',')}`,
      ruleId: v.ruleId,
      shortName: meta?.shortName ?? v.ruleId,
      groupLabel: GROUP_LABEL[v.ruleGroup],
      pointsText,
      windowStartText: `第 ${v.windowStart + 1} 点`,
      message: v.message,
      severity: v.severity,
      pointIndex: v.windowStart,
    };
  });
}

export interface RuleViolationTableProps {
  violations: RuleViolation[];
  /** 点击某行 → 定位到对应点。 */
  onLocate?: (pointIndex: number) => void;
  /** 空状态文案。 */
  emptyContent?: string;
}

/**
 * 渲染违规明细表。
 *
 * @param props 组件属性
 * @returns 明细表元素
 */
export default function RuleViolationTable({
  violations,
  onLocate,
  emptyContent = '当前无判异命中（规则开关全部生效时表示过程受控）。',
}: RuleViolationTableProps): ReactElement {
  const rows = toViolationRows(violations);

  const columns: DataTableColumn<ViolationRow>[] = [
    {
      key: 'rule',
      header: '规则',
      width: 88,
      render: (row) => (
        <Stack direction="row" spacing={0.5} alignItems="center">
          <Chip size="small" label={row.ruleId} variant="outlined" />
        </Stack>
      ),
    },
    {
      key: 'shortName',
      header: '判定',
      render: (row) => (
        <Stack spacing={0} sx={{ minWidth: 120 }}>
          <Typography variant="body2" fontWeight={600}>
            {row.shortName}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.groupLabel}
          </Typography>
        </Stack>
      ),
    },
    { key: 'windowStart', header: '窗口起点', width: 92, render: (row) => row.windowStartText },
    { key: 'points', header: '涉及点', width: 160, render: (row) => row.pointsText },
    {
      key: 'severity',
      header: '严重级',
      width: 80,
      render: (row) => (
        <Chip size="small" color={SEVERITY_COLOR[row.severity]} label={SEVERITY_LABEL[row.severity]} />
      ),
    },
    {
      key: 'message',
      header: '说明',
      render: (row) => (
        <Typography variant="body2" color="text.secondary">
          {row.message}
        </Typography>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.key}
      onRowClick={onLocate ? (row) => onLocate(row.pointIndex) : undefined}
      emptyContent={emptyContent}
      maxHeight={420}
      data-testid="rule-violation-table"
    />
  );
}
