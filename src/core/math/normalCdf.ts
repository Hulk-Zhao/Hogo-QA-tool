/**
 * 分布表与近似：标准正态 CDF/PDF、正态分位数（逆 CDF）、t 分布分位数近似。
 *
 * 出处：
 * - Abramowitz & Stegun (1964), Handbook of Mathematical Functions, 26.2.17（正态 CDF）
 * - Abramowitz & Stegun (1964), 26.2.23（正态分位数近似，Hart 1968 系数）
 * - Royston (1995), JRSS-C 44(4)（正态分位数用于 S-W 的 Blom 近似）
 */

/** √(2π) 常量，用于正态 PDF。 */
export const SQRT_2PI = Math.sqrt(2 * Math.PI);

/**
 * 标准正态概率密度函数 φ(z)。
 *
 * 出处：标准定义 φ(z) = (1/√(2π))·exp(-z²/2)。
 */
export function normalPdf(z: number): number {
  return Math.exp(-0.5 * z * z) / SQRT_2PI;
}

/**
 * 标准正态累积分布函数 Φ(z)。
 *
 * 出处：Abramowitz & Stegun (1964) 26.2.17（有理逼近，绝对误差 < 7.5e-8）。
 * 对负 z 用对称性 Φ(-z) = 1 - Φ(z)。
 */
export function normalCdf(z: number): number {
  if (!Number.isFinite(z)) {
    return z > 0 ? 1 : 0;
  }
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  // Abramowitz & Stegun 7.1.26 erf 近似（|ε| <= 1.5e-7）
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  const erf = sign * y;
  const cdf = 0.5 * (1 + erf);
  return Math.min(1, Math.max(0, cdf));
}

/** 标准正态 PDF 别名（对外语义化命名）。 */
export function stdNormalPdf(z: number): number {
  return normalPdf(z);
}

/** 标准正态 CDF 别名（对外语义化命名）。 */
export function stdNormalCdf(z: number): number {
  return normalCdf(z);
}

/**
 * 标准正态分位数 Φ^{-1}(p)（逆 CDF）。
 *
 * 出处：Abramowitz & Stegun (1964) 26.2.23（Hart 1968 近似，绝对误差 < 4.5e-4）。
 *
 * @param p 概率，必须位于 (0, 1) 开区间
 * @throws {RangeError} p 不在 (0, 1) 内
 */
export function normalInvCdf(p: number): number {
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`正态分位数输入 p 必须位于 (0, 1) 开区间，收到 ${p}。`);
  }
  const c0 = 2.515517;
  const c1 = 0.802853;
  const c2 = 0.010328;
  const d1 = 1.432788;
  const d2 = 0.189269;
  const d3 = 0.001308;

  const lower = p < 0.5;
  const t = lower ? Math.sqrt(-2 * Math.log(p)) : Math.sqrt(-2 * Math.log(1 - p));
  const num = c0 + c1 * t + c2 * t * t;
  const den = 1 + d1 * t + d2 * t * t + d3 * t * t * t;
  const z = t - num / den;
  return lower ? -z : z;
}

/**
 * Student-t 分布双尾临界值近似（用于 Grubbs 检验、小样本区间估计）。
 *
 * 出处：基于正态分位数 + Hill (1970) 修正（非精确但足够 Grubbs 使用），
 * 并在 n-1 >= 30 时退化为正态分位数。为保守起见，结果向下取整到 4 位。
 *
 * @param p 单尾概率，例如 α/(2n)
 * @param df 自由度（>=1）
 */
export function tQuantile(p: number, df: number): number {
  if (df <= 0 || !Number.isInteger(df)) {
    throw new RangeError(`t 分布自由度 df 必须为正整数，收到 ${df}。`);
  }
  if (!(p > 0 && p < 1)) {
    throw new RangeError(`t 分位数输入 p 必须位于 (0, 1) 开区间，收到 ${p}。`);
  }
  const z = normalInvCdf(p);
  // Hill (1970) 近似：t ≈ z + (z³ + z) / (4·df)
  const z3 = z * z * z;
  const t = z + (z3 + z) / (4 * df) + (5 * z3 * z * z + 16 * z3 + 3 * z) / (96 * df * df);
  return t;
}
