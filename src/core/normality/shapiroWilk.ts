/**
 * Shapiro-Wilk 正态性检验。
 *
 * 出处：
 * - Shapiro & Wilk (1965), Biometrika 52(3/4):591–611（W 统计量）。
 * - Royston (1995), JRSS-C 44(4):547–551（系数多项式近似与 p 值近似，n=3..5000）。
 */

import type { NormalityResult } from '../types';
import { normalCdf, normalInvCdf } from '../math/normalCdf';
import { sumOfSquares } from '../math/matrix';

/** S-W 支持的样本量上限。 */
export const SW_MAX_N = 5000;

/**
 * 生成 Royston (1995) 的 S-W 系数 a_i。
 *
 * 出处：Royston 1995 §2；架构文档 §10.2 步骤 3。
 * m_i 用 Blom 近似 (i-0.375)/(n+0.25)；对 i<=n/2 计算，再对称。
 *
 * @returns 按升序对齐的系数数组（长度 n，a[0] 对应最小值）
 */
export function shapiroWilkCoefficients(n: number): number[] {
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i <= n; i += 1) {
    m[i - 1] = normalInvCdf((i - 0.375) / (n + 0.25));
  }
  const mSumSq = sumOfSquares(m);
  const mNorm = Math.sqrt(mSumSq);
  const c = m.map((mi) => mi / mNorm); // Blom 归一化 m_j

  const u = 1 / Math.sqrt(n);
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u2 * u2;
  const u5 = u4 * u;

  // a_n（最大值的系数）
  const aNraw =
    -2.706056 * u5 +
    4.434685 * u4 -
    2.07119 * u3 -
    0.147981 * u2 +
    0.221157 * u +
    c[n - 1];

  if (n > 5) {
    const aNm1raw =
      -3.582633 * u5 +
      5.682633 * u4 -
      1.752461 * u3 -
      0.293762 * u2 +
      0.042981 * u +
      c[n - 2];

    const phi = (mSumSq - 2 * m[n - 1] * m[n - 1] - 2 * m[n - 2] * m[n - 2]) / (1 - 2 * aNraw * aNraw - 2 * aNm1raw * aNm1raw);
    const scale = Math.sqrt(phi);
    const a = new Array<number>(n).fill(0);
    for (let i = 3; i <= n - 2; i += 1) {
      a[i - 1] = m[i - 1] / scale;
    }
    // 对称填充小端
    for (let i = 1; i <= 2; i += 1) {
      a[i - 1] = -a[n - i];
    }
    a[n - 1] = aNraw;
    a[n - 2] = aNm1raw;
    // 对称规则：a_1 = -a_n, a_2 = -a_{n-1}
    a[0] = -a[n - 1];
    a[1] = -a[n - 2];
    return a;
  }

  // n <= 5：整体归一化修正
  const phi = (mSumSq - 2 * m[n - 1] * m[n - 1]) / (1 - 2 * aNraw * aNraw);
  const scale = Math.sqrt(phi);
  const a = new Array<number>(n).fill(0);
  for (let i = 1; i <= n - 1; i += 1) {
    a[i - 1] = m[i - 1] / scale;
  }
  a[n - 1] = aNraw;
  a[0] = -a[n - 1];
  return a;
}

/**
 * Shapiro-Wilk 正态性检验。
 *
 * 出处：Royston (1995)；架构文档 §10.2。
 *
 * @param values 数值数组
 */
export function shapiroWilk(values: number[]): NormalityResult {
  const n = values.length;
  if (n < 3) {
    return {
      method: 'SW',
      statistic: Number.NaN,
      pValue: Number.NaN,
      isNormal: false,
      note: '样本量不足，无法执行 S-W（需 n>=3）',
    };
  }

  if (n > SW_MAX_N) {
    return {
      method: 'SW',
      statistic: Number.NaN,
      pValue: Number.NaN,
      isNormal: false,
      note: `n=${n} 过大，S-W 精度下降，建议改看 AD`,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  let mu = 0;
  for (let i = 0; i < n; i += 1) {
    mu += sorted[i];
  }
  mu /= n;

  const ss = sorted.reduce((acc, x) => acc + (x - mu) * (x - mu), 0);
  if (ss === 0) {
    return {
      method: 'SW',
      statistic: 1,
      pValue: 1,
      isNormal: true,
      note: '数据无波动（SS=0），视为正态退化数据',
    };
  }

  const a = shapiroWilkCoefficients(n);
  let numerator = 0;
  for (let i = 0; i < n; i += 1) {
    numerator += a[i] * sorted[i];
  }
  let w = (numerator * numerator) / ss;
  // 数值边界保护
  if (w > 1) {
    w = 1;
  }
  if (w < 0) {
    w = 0;
  }

  const p = swPValue(w, n);
  return {
    method: 'SW',
    statistic: w,
    pValue: p,
    isNormal: p >= 0.05,
  };
}

/**
 * S-W 的 p 值近似（Royston 1995 正态化变换）。
 *
 * 出处：架构文档 §10.2 步骤 5。
 */
export function swPValue(w: number, n: number): number {
  if (w >= 1) {
    return 1;
  }
  if (w <= 0) {
    return 0;
  }
  const lnN = Math.log(n);
  const lnN2 = lnN * lnN;
  const lnN3 = lnN2 * lnN;
  const m = 0.0038915 * lnN3 - 0.083751 * lnN2 - 0.31082 * lnN - 1.5861;
  const s = Math.exp(0.0030302 * lnN2 - 0.082676 * lnN - 0.4803);
  const z = (Math.log(1 - w) - m) / s;
  const p = 1 - normalCdf(z);
  return Math.min(1, Math.max(0, p));
}
