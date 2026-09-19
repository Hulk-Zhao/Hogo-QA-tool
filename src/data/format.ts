/**
 * format：序列化/展示边界的精度常量（架构 §8.2）。
 *
 * 原则：core 内部计算全程完整 double 精度，**不在计算中四舍五入**；
 * 仅在序列化/展示边界（NumberCell、导出、AI 摘要）按本表舍入。
 */

/** 均值 / σ / Cp / Cpk / Pp / Ppk / Ca 的展示小数位。 */
export const DECIMALS_INDEX = 4;

/** 西格玛水平展示小数位。 */
export const DECIMALS_SIGMA = 2;

/** 占比 % 展示小数位。 */
export const DECIMALS_RATIO = 2;

/** 判定容差（浮点相等）。 */
export const EQUAL_EPS = 1e-9;

/**
 * 按小数位四舍五入（展示/导出用）。
 *
 * @param value 数值（允许 null，原样返回）
 * @param decimals 小数位
 */
export function roundTo(value: number | null, decimals: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
