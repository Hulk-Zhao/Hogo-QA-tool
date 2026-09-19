/**
 * Anderson-Darling 正态性检验。
 *
 * 出处：
 * - Anderson & Darling (1954), JASA 49(268):765–769（A² 统计量）。
 * - Stephens (1986) / D'Agostino & Stephens (1986) Goodness-of-Fit Techniques
 *   （小样本修正 A²* 与分档 p 值近似）。
 */

import type { NormalityResult } from '../types';
import { normalCdf } from '../math/normalCdf';
import { mean as meanOf, stdDev } from '../stats/descriptive';
import { sortedAscending } from '../math/matrix';

/**
 * Anderson-Darling 正态性检验（参数估计修正版）。
 *
 * 步骤（架构文档 §10.1）：
 * 1. 标准化 z_i = (x_(i) - x̄) / s
 * 2. p_i = Φ(z_i)
 * 3. A² = -n - (1/n)·Σ (2i-1)·[ln p_i + ln(1-p_{n+1-i})]
 * 4. A²* = A² · (1 + 0.75/n + 2.25/n²)
 * 5. 分档 p 值近似
 *
 * @param values 数值数组
 */
export function andersonDarling(values: number[]): NormalityResult {
  const n = values.length;
  if (n < 2) {
    return {
      method: 'AD',
      statistic: Number.NaN,
      pValue: Number.NaN,
      isNormal: false,
      note: '样本量过小，无法执行 AD 检验',
    };
  }

  const mu = meanOf(values);
  let s: number;
  try {
    s = stdDev(values, 1);
  } catch {
    s = 0;
  }

  if (s === 0) {
    return {
      method: 'AD',
      statistic: Number.POSITIVE_INFINITY,
      pValue: 0,
      isNormal: false,
      note: '数据无波动（标准差为 0），视为非正态退化数据',
    };
  }

  const sorted = sortedAscending(values);

  let sumTerm = 0;
  for (let i = 1; i <= n; i += 1) {
    const zLo = (sorted[i - 1] - mu) / s;
    const zHi = (sorted[n - i] - mu) / s;
    let pLo = normalCdf(zLo);
    let pHi = normalCdf(zHi);
    // 防止 ln(0)
    const eps = 1e-12;
    pLo = Math.min(1 - eps, Math.max(eps, pLo));
    pHi = Math.min(1 - eps, Math.max(eps, pHi));
    sumTerm += (2 * i - 1) * (Math.log(pLo) + Math.log(1 - pHi));
  }

  const a2 = -n - sumTerm / n;
  const a2Star = a2 * (1 + 0.75 / n + 2.25 / (n * n));
  const p = adPValue(a2Star);

  const result: NormalityResult = {
    method: 'AD',
    statistic: a2Star,
    pValue: p,
    isNormal: p >= 0.05,
  };
  if (n < 8) {
    result.note = '样本量过小（n<8），AD 结果仅供参考';
  }
  return result;
}

/**
 * AD 统计量的 p 值近似（D'Agostino & Stephens 1986 分档公式）。
 *
 * 出处：架构文档 §10.1 步骤 5。
 */
export function adPValue(a2Star: number): number {
  let p: number;
  if (a2Star < 0.2) {
    p = 1 - Math.exp(-13.436 + 101.14 * a2Star - 223.73 * a2Star * a2Star);
  } else if (a2Star < 0.34) {
    p = 1 - Math.exp(-8.318 + 42.796 * a2Star - 59.938 * a2Star * a2Star);
  } else if (a2Star < 0.6) {
    p = Math.exp(0.9177 - 4.279 * a2Star - 1.38 * a2Star * a2Star);
  } else {
    p = Math.exp(1.2937 - 5.709 * a2Star + 0.0186 * a2Star * a2Star);
  }
  return Math.min(1, Math.max(0, p));
}
