/**
 * NumberCell —— 数值格式化单元格（精度约定）。
 *
 * 出处：架构文档 §8.2。所有表格数值统一经此渲染，确保精度一致。
 * 不可计算量显示 'N/A'（能力指数）或 '—'（一般单元格）。
 */

import { Typography } from '@mui/material';
import type { ReactElement } from 'react';
import {
  formatIndex,
  formatNumber,
  formatPpm,
  formatRatio,
  formatSigmaLevel,
  DASH_TEXT,
  NA_TEXT,
} from '@/ui/format';

/** 单元格渲染的数值语义类型。 */
export type NumberCellKind = 'index' | 'sigmaLevel' | 'ratio' | 'ppm' | 'plain' | 'measurement';

export interface NumberCellProps {
  value: number | null | undefined;
  kind?: NumberCellKind;
  /** 小数位（kind 为 plain 时生效，默认 4）。 */
  decimals?: number;
  /** 是否右对齐（默认 true，表格数值列）。 */
  alignRight?: boolean;
  /** 不可计算时的占位文案（默认按 kind 决定）。 */
  placeholder?: string;
}

/**
 * 按语义类型格式化并渲染一个数值。
 *
 * @param props 组件属性
 * @returns 数值文本元素
 */
export default function NumberCell({
  value,
  kind = 'plain',
  decimals = 4,
  alignRight = true,
  placeholder,
}: NumberCellProps): ReactElement {
  let text: string;
  switch (kind) {
    case 'index':
      text = formatIndex(value);
      break;
    case 'sigmaLevel':
      text = formatSigmaLevel(value);
      break;
    case 'ratio':
      text = formatRatio(value);
      break;
    case 'ppm':
      text = formatPpm(value);
      break;
    case 'measurement':
      text = formatNumber(value, decimals, placeholder ?? DASH_TEXT);
      break;
    case 'plain':
    default:
      text = formatNumber(value, decimals, placeholder ?? DASH_TEXT);
      break;
  }

  // 若指定了 placeholder 且当前不可计算，则强制使用 placeholder。
  if (
    placeholder !== undefined &&
    (value === null || value === undefined || !Number.isFinite(value))
  ) {
    text = placeholder;
  }

  const isNa = text === NA_TEXT;

  return (
    <Typography
      component="span"
      variant="body2"
      sx={{
        fontVariantNumeric: 'tabular-nums',
        display: 'inline-block',
        minWidth: 56,
        textAlign: alignRight ? 'right' : 'left',
        color: isNa ? 'text.disabled' : 'text.primary',
      }}
    >
      {text}
    </Typography>
  );
}
