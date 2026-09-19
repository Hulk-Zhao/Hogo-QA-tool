/**
 * cellParsing：单元格数值解析（空值语义，架构 §8.3）。
 *
 * 空值定义：null / undefined / '' / NaN / 非数字字符串 → 缺失，返回
 * `{ value: null, isNull: true }`，**不得用 0 冒充**。
 * 数值保留原始精度，不做任何舍入。
 */

import type { NumericCellParse, RawCell } from './types';

/** 全角数字/符号转半角。 */
function toHalfWidth(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code === 0x3000) {
      out += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else {
      out += s[i];
    }
  }
  return out;
}

/** 去掉千分位逗号与前后空白。 */
function cleanNumericString(s: string): string {
  return toHalfWidth(s).replace(/,/g, '').trim();
}

/**
 * 解析单元格为数值。
 *
 * @param raw 原始单元格
 * @returns NumericCellParse（保留精度；缺失与非法均 value=null）
 */
export function parseNumericCell(raw: RawCell): NumericCellParse {
  if (raw === null || raw === undefined) {
    return { value: null, isNull: true, invalidReason: null };
  }
  if (typeof raw === 'number') {
    if (Number.isNaN(raw)) {
      return { value: null, isNull: true, invalidReason: null };
    }
    if (!Number.isFinite(raw)) {
      return { value: null, isNull: false, invalidReason: `非有限数值（${String(raw)}）` };
    }
    return { value: raw, isNull: false, invalidReason: null };
  }
  const text = cleanNumericString(raw);
  if (text.length === 0) {
    return { value: null, isNull: true, invalidReason: null };
  }
  // 允许常见缺失占位符视作空值（不报错），但明确区分异常字符串。
  if (text === '-' || text === '—' || text === 'n/a' || text === '#n/a' || text === 'na') {
    return { value: null, isNull: true, invalidReason: null };
  }
  const num = Number(text);
  if (Number.isNaN(num)) {
    return { value: null, isNull: false, invalidReason: `非法数值：「${text}」` };
  }
  if (!Number.isFinite(num)) {
    return { value: null, isNull: false, invalidReason: `非有限数值（${text}）` };
  }
  return { value: num, isNull: false, invalidReason: null };
}

/** 解析整数计数（不良数量）：非负整数语义。 */
export function parseCountCell(raw: RawCell): NumericCellParse {
  const parsed = parseNumericCell(raw);
  if (parsed.value === null) {
    return parsed;
  }
  if (!Number.isInteger(parsed.value)) {
    return { value: null, isNull: false, invalidReason: `不良数量必须为整数（收到 ${parsed.value}）` };
  }
  if (parsed.value < 0) {
    return { value: null, isNull: false, invalidReason: `不良数量不能为负（收到 ${parsed.value}）` };
  }
  return parsed;
}

/** 单元格转字符串（用于物料名/不良类型；空白视作空串）。 */
export function cellToString(raw: RawCell): string {
  if (raw === null || raw === undefined) {
    return '';
  }
  if (typeof raw === 'number') {
    return String(raw);
  }
  return raw.trim();
}
