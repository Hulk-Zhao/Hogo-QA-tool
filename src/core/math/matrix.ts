/**
 * 数学辅助：Shapiro-Wilk 所需的多项式与排序工具。
 *
 * 出处：Royston (1995), JRSS-C 44(4):547–551。
 */

/**
 * 升序排序（返回新数组，不修改入参）。
 */
export function sortedAscending(xs: number[]): number[] {
  return [...xs].sort((a, b) => a - b);
}

/**
 * 求和。
 */
export function sum(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) {
    s += xs[i];
  }
  return s;
}

/**
 * 平方和 Σ x_i²。
 */
export function sumOfSquares(xs: number[]): number {
  let s = 0;
  for (let i = 0; i < xs.length; i += 1) {
    s += xs[i] * xs[i];
  }
  return s;
}

/**
 * 均值。
 *
 * @throws {RangeError} 空数组
 */
export function average(xs: number[]): number {
  if (xs.length === 0) {
    throw new RangeError('average 输入不能为空数组。');
  }
  return sum(xs) / xs.length;
}

/**
 * 极差 R = max - min。
 *
 * @throws {RangeError} 空数组
 */
export function range(xs: number[]): number {
  if (xs.length === 0) {
    throw new RangeError('range 输入不能为空数组。');
  }
  let min = xs[0];
  let max = xs[0];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] < min) min = xs[i];
    if (xs[i] > max) max = xs[i];
  }
  return max - min;
}

/**
 * 判断数组是否全为有限数。
 */
export function allFinite(xs: number[]): boolean {
  for (let i = 0; i < xs.length; i += 1) {
    if (!Number.isFinite(xs[i])) return false;
  }
  return true;
}
