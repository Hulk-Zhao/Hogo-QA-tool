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
 * 最大值（O(n) 循环，**不使用** `Math.max(...xs)`）。
 *
 * 为什么必须用循环而不是展开运算符：`Math.max(...xs)` 会把每个元素作为**实参**
 * 压入调用栈，12 万级以上的数组直接抛 `RangeError: Maximum call stack size exceeded`
 * —— 本项目 csvImporter 已在 12 万行真实数据上踩过这个坑。此处统一口径，
 * 消除同类隐患（子组数虽然量级小，但「同一件事只有一种写法」本身就是防线）。
 *
 * @param xs 数值数组
 * @throws {RangeError} 空数组
 */
export function maxOf(xs: number[]): number {
  if (xs.length === 0) {
    throw new RangeError('maxOf 输入不能为空数组。');
  }
  let max = xs[0];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] > max) max = xs[i];
  }
  return max;
}

/**
 * 最小值（O(n) 循环，理由同 {@link maxOf}）。
 *
 * @param xs 数值数组
 * @throws {RangeError} 空数组
 */
export function minOf(xs: number[]): number {
  if (xs.length === 0) {
    throw new RangeError('minOf 输入不能为空数组。');
  }
  let min = xs[0];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] < min) min = xs[i];
  }
  return min;
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
