/**
 * 数值格式化工具（UI 展示边界的四舍五入）。
 *
 * 出处：架构文档 §8.2 数值精度约定。
 * - 均值 / σ / Cp / Cpk / Pp / Ppk / Ca：4 位小数
 * - 西格玛水平：2 位小数
 * - 占比 %：2 位小数
 * - PPM：整数
 * - 不可计算（null / undefined / NaN / Infinity）：返回占位文案
 *   （能力指数 'N/A'，表格单元格 '—'），**绝不用 0 或 999 冒充**。
 *
 * 重要：core 内部全程使用完整 double 精度计算，舍入只发生在展示边界。
 * 本模块不参与任何统计计算，仅负责把 core 结果渲染为字符串。
 */

/** 指数（Cp/Cpk/Pp/Ppk/Ca）与均值/σ 的小数位。 */
export const DECIMALS_INDEX = 4;

/** 西格玛水平的小数位。 */
export const DECIMALS_SIGMA = 2;

/** 占比 % 的小数位。 */
export const DECIMALS_RATIO = 2;

/** 能力指数不可计算时的占位文案（PRD 要求单侧规格 Cp/Pp 显示 N/A）。 */
export const NA_TEXT = 'N/A';

/** 表格单元格缺失值的占位文案。 */
export const DASH_TEXT = '—';

/**
 * 判断一个数值是否可展示（有限数）。
 *
 * @param value 待判断值
 * @returns 有限数返回 true
 */
export function isRenderable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 按固定小数位格式化数值；不可计算时返回占位文案。
 *
 * @param value 原始数值（可为 null / undefined）
 * @param decimals 小数位
 * @param placeholder 不可计算时的占位文案，默认 '—'
 * @returns 格式化字符串
 */
export function formatNumber(
  value: number | null | undefined,
  decimals: number,
  placeholder: string = DASH_TEXT,
): string {
  if (!isRenderable(value)) {
    return placeholder;
  }
  return value.toFixed(decimals);
}

/**
 * 格式化能力指数（4 位小数）；单侧规格缺失时为 'N/A'。
 *
 * @param value 原始值
 * @returns 格式化字符串
 */
export function formatIndex(value: number | null | undefined): string {
  return formatNumber(value, DECIMALS_INDEX, NA_TEXT);
}

/**
 * 格式化西格玛水平（2 位小数）；不可计算时为 '—'。
 *
 * @param value 原始值
 * @returns 格式化字符串
 */
export function formatSigmaLevel(value: number | null | undefined): string {
  return formatNumber(value, DECIMALS_SIGMA, DASH_TEXT);
}

/**
 * 格式化占比百分比（2 位小数，带 % 后缀）。
 *
 * 不可计算时只返回占位文案（不带 %），避免出现 '—%' 这类误导性输出。
 *
 * @param value 占比（%）
 * @returns 格式化字符串，如 '81.50%'
 */
export function formatRatio(value: number | null | undefined): string {
  if (!isRenderable(value)) {
    return DASH_TEXT;
  }
  return `${formatNumber(value, DECIMALS_RATIO)}%`;
}

/**
 * 格式化 PPM（整数，四舍五入）。
 *
 * @param value PPM 值
 * @returns 整数字符串；不可计算时为 '—'
 */
export function formatPpm(value: number | null | undefined): string {
  if (!isRenderable(value)) {
    return DASH_TEXT;
  }
  return Math.round(value).toString();
}

/**
 * 格式化测量值：保留原始有效数字，不强制小数位。
 *
 * @param value 原始值
 * @returns 字符串；不可计算时为 '—'
 */
export function formatMeasurement(value: number | null | undefined): string {
  if (!isRenderable(value)) {
    return DASH_TEXT;
  }
  return String(value);
}
