/**
 * StatCard —— 通用指标卡（能力页 / 概览用）。
 */

import { Card, CardContent, Stack, Typography } from '@mui/material';
import type { ReactElement, ReactNode } from 'react';

export interface StatCardProps {
  label: string;
  /** 主值（已格式化的字符串或元素）。 */
  value: ReactNode;
  /** 提示说明（如「短期能力(3×Cpk)」）。 */
  hint?: string;
  /** 是否告警样式。 */
  alert?: boolean;
}

/**
 * 渲染一个指标卡。
 *
 * @param props 组件属性
 * @returns 指标卡元素
 */
export default function StatCard({ label, value, hint, alert = false }: StatCardProps): ReactElement {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack spacing={0.5}>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
          <Typography
            variant="h6"
            component="div"
            sx={{ fontVariantNumeric: 'tabular-nums', color: alert ? 'error.main' : 'text.primary' }}
          >
            {value}
          </Typography>
          {hint ? (
            <Typography variant="caption" color="text.disabled">
              {hint}
            </Typography>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
