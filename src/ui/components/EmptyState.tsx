/**
 * EmptyState —— 空状态占位。
 */

import { Box, Stack, Typography } from '@mui/material';
import { Inbox as InboxIcon } from '@mui/icons-material';
import type { ReactElement, ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** 操作按钮区。 */
  action?: ReactNode;
  /** 测试锚点（可选，便于路由级断言空状态已挂载）。 */
  testId?: string;
}

/**
 * 渲染空状态。
 *
 * @param props 组件属性
 * @returns 空状态元素
 */
export default function EmptyState({
  title,
  description,
  action,
  testId,
}: EmptyStateProps): ReactElement {
  return (
    <Box
      data-testid={testId}
      sx={{
        py: 6,
        px: 3,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: 240,
      }}
    >
      <Stack spacing={1.5} alignItems="center" maxWidth={420}>
        <InboxIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
        <Typography variant="subtitle1" fontWeight={600}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" color="text.secondary" textAlign="center">
            {description}
          </Typography>
        ) : null}
        {action}
      </Stack>
    </Box>
  );
}
