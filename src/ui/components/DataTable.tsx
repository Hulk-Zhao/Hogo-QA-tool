/**
 * DataTable —— 通用表格。
 *
 * 轻量封装 MUI Table，支持列定义、空状态与行点击。
 */

import {
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
} from '@mui/material';
import type { ReactElement, ReactNode } from 'react';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** 单元格渲染。 */
  render: (row: T, index: number) => ReactNode;
  /** 列宽。 */
  width?: number | string;
  /** 对齐。 */
  align?: 'left' | 'center' | 'right';
  /** 是否小尺寸（行内数值列常用）。 */
  dense?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  /** 行唯一键。 */
  rowKey: (row: T, index: number) => string;
  /** 行点击回调。 */
  onRowClick?: (row: T, index: number) => void;
  /** 空状态渲染。 */
  emptyContent?: ReactNode;
  maxHeight?: number | string;
  'data-testid'?: string;
}

/**
 * 渲染通用表格。
 *
 * @param props 组件属性
 * @returns 表格元素
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  emptyContent,
  maxHeight,
  'data-testid': testId,
}: DataTableProps<T>): ReactElement {
  return (
    <TableContainer component={Paper} variant="outlined" sx={{ maxHeight }}>
      <Table size="small" stickyHeader data-testid={testId}>
        <TableHead>
          <TableRow>
            {columns.map((col) => (
              <TableCell
                key={col.key}
                align={col.align ?? 'left'}
                sx={{ width: col.width, fontWeight: 600, whiteSpace: 'nowrap' }}
              >
                {col.header}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} align="center" sx={{ py: 3 }}>
                {emptyContent ?? '暂无数据'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow
                key={rowKey(row, index)}
                hover={Boolean(onRowClick)}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                sx={{ cursor: onRowClick ? 'pointer' : 'default' }}
              >
                {columns.map((col) => (
                  <TableCell key={col.key} align={col.align ?? 'left'} sx={{ py: col.dense ? 0.5 : 1 }}>
                    {col.render(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
