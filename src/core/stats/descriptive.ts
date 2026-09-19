/**
 * 描述性统计（纯函数）。
 *
 * 出处：基础统计学定义；标准差使用 Bessel 修正（ddof=1，样本标准差）。
 */

import { average, range, sortedAscending, sum } from '../math/matrix';

/**
 * 算术平均 x̄ = (Σ x_i) / n。
 *
 * @throws {RangeError} 空数组
 */
export function mean(xs: number[]): number {
  return average(xs);
}

/**
 * 样本标准差。
 *
 * 出处：Bessel 修正的样本标准差定义。
 * ddof=0 → 总体标准差（除以 n）；ddof=1 → 样本标准差（除以 n-1）。
 *
 * @param xs 数值数组
 * @param ddof 自由度修正，默认 1
 * @throws {RangeError} 数组长度 <= ddof
 */
export function stdDev(xs: number[], ddof = 1): number {
  const n = xs.length;
  if (n <= ddof) {
    throw new RangeError(`标准差计算要求样本数 > ddof，收到 n=${n}, ddof=${ddof}。`);
  }
  const mu = average(xs);
  let ss = 0;
  for (let i = 0; i < n; i += 1) {
    const d = xs[i] - mu;
    ss += d * d;
  }
  return Math.sqrt(ss / (n - ddof));
}

/**
 * 中位数：奇数取中间值，偶数取中间两值平均。
 *
 * @throws {RangeError} 空数组
 */
export function median(xs: number[]): number {
  if (xs.length === 0) {
    throw new RangeError('median 输入不能为空数组。');
  }
  const s = sortedAscending(xs);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) {
    return s[mid];
  }
  return (s[mid - 1] + s[mid]) / 2;
}

/**
 * 极差 R = max - min。
 */
export function rangeOf(xs: number[]): number {
  return range(xs);
}

/**
 * 样本偏度（Fisher 定义，g1 无偏化前的样本偏度）。
 *
 * 出处：Fisher (1930) 样本偏度定义 g1 = m3 / m2^(3/2)，
 * 其中 m_k = (1/n)·Σ(x_i - x̄)^k。
 *
 * @throws {RangeError} n < 3 或 m2 == 0
 */
export function skewness(xs: number[]): number {
  const n = xs.length;
  if (n < 3) {
    throw new RangeError(`偏度计算要求 n >= 3，收到 n=${n}。`);
  }
  const mu = average(xs);
  let m2 = 0;
  let m3 = 0;
  for (let i = 0; i < n; i += 1) {
    const d = xs[i] - mu;
    m2 += d * d;
    m3 += d * d * d;
  }
  m2 /= n;
  m3 /= n;
  if (m2 === 0) {
    throw new RangeError('偏度计算要求方差 > 0，数据无波动。');
  }
  return m3 / Math.pow(m2, 1.5);
}

/**
 * 样本峰度（超额峰度 = g2 - 3，Fisher 定义）。
 *
 * 出处：Fisher (1930)；正态分布的超额峰度为 0。
 *
 * @throws {RangeError} n < 4 或 m2 == 0
 */
export function kurtosis(xs: number[]): number {
  const n = xs.length;
  if (n < 4) {
    throw new RangeError(`峰度计算要求 n >= 4，收到 n=${n}。`);
  }
  const mu = average(xs);
  let m2 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i += 1) {
    const d = xs[i] - mu;
    const d2 = d * d;
    m2 += d2;
    m4 += d2 * d2;
  }
  m2 /= n;
  m4 /= n;
  if (m2 === 0) {
    throw new RangeError('峰度计算要求方差 > 0，数据无波动。');
  }
  return m4 / (m2 * m2) - 3;
}

/** 数组求和（转发）。 */
export function sumOf(xs: number[]): number {
  return sum(xs);
}
