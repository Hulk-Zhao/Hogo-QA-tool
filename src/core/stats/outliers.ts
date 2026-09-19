/**
 * 异常值识别：Grubbs（默认）与 1.5 IQR。
 *
 * 出处：
 * - Grubbs (1969), Technometrics 11(1):1–21（单侧/双侧 Grubbs 检验）。
 * - Tukey (1977) 箱线图 1.5 IQR 规则。
 *
 * 只标注不删除（PRD §4.5）。
 */

import type { OutlierFlag } from '../types';
import { mean as meanOf, median, stdDev } from './descriptive';
import { sortedAscending } from '../math/matrix';

/**
 * Grubbs 检验（迭代式，双侧）。
 *
 * 对每个候选点计算 G = |x_i - x̄| / s，与临界值
 * G_crit = ((n-1)/√n) · √( t²_{α/(2n), n-2} / (n - 2 + t²_{α/(2n), n-2}) )
 * 比较（Grubbs 1969）。本实现一次性对当前样本计算全部超过临界值的点，
 * 返回其 index 与统计量（不迭代剔除，符合「只标注不删除」）。
 *
 * @param values 数值数组
 * @param alpha 显著性水平，默认 0.05
 * @returns 异常点标注数组（按 index 升序）
 */
export function grubbsTest(values: number[], alpha = 0.05): OutlierFlag[] {
  const n = values.length;
  if (n < 3) {
    return [];
  }
  const mu = meanOf(values);
  const s = stdDev(values, 1);
  if (s === 0) {
    return [];
  }

  // 临界值（双侧）
  const t = tCritical(alpha / (2 * n), n - 2);
  const t2 = t * t;
  const gCrit = ((n - 1) / Math.sqrt(n)) * Math.sqrt(t2 / (n - 2 + t2));

  const flags: OutlierFlag[] = [];
  for (let i = 0; i < n; i += 1) {
    const g = Math.abs(values[i] - mu) / s;
    if (g > gCrit) {
      flags.push({
        index: i,
        method: 'grubbs',
        statistic: g,
        threshold: gCrit,
        confirmed: false,
      });
    }
  }
  return flags;
}

/**
 * t 分布临界值（双侧尾部概率 p），基于 Hill (1970) 近似。
 *
 * 用于 Grubbs 临界值计算；n-2 >= 30 时退化为正态分位数。
 */
function tCritical(p: number, df: number): number {
  if (df <= 0) {
    return 0;
  }
  // 内联实现，避免 core 内新增循环依赖。
  const z = inverseNormal(p);
  const z3 = z * z * z;
  return (
    z +
    (z3 + z) / (4 * df) +
    (5 * z3 * z * z + 16 * z3 + 3 * z) / (96 * df * df)
  );
}

/** 标准正态逆 CDF（A&S 26.2.23）。与 normalCdf.normalInvCdf 等价，内联以避免依赖方向问题。 */
function inverseNormal(p: number): number {
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
 * 1.5 IQR 异常值识别（Tukey 箱线图规则）。
 *
 * 出处：Tukey (1977)。四分位用线性插值法（与常见实现一致）；
 * 下界 = Q1 - 1.5·IQR，上界 = Q3 + 1.5·IQR；超出者为异常。
 *
 * @param values 数值数组
 * @returns 异常点标注数组（按 index 升序）
 */
export function iqrTest(values: number[]): OutlierFlag[] {
  const n = values.length;
  if (n < 4) {
    return [];
  }
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const flags: OutlierFlag[] = [];
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v < lower || v > upper) {
      // statistic 取超出边界的距离，threshold 取对应边界距离
      const exceed = v > upper ? v - upper : lower - v;
      flags.push({
        index: i,
        method: 'iqr',
        statistic: exceed,
        threshold: 1.5 * iqr,
        confirmed: false,
      });
    }
  }
  return flags;
}

/**
 * 分位数（线性插值法，Type-7，与 R/NumPy 默认一致）。
 */
function quantile(values: number[], p: number): number {
  const s = sortedAscending(values);
  const n = s.length;
  if (n === 1) {
    return s[0];
  }
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/**
 * 异常值识别统一入口。
 *
 * @param values 数值数组
 * @param method 'grubbs'（默认）或 'iqr'
 * @param alpha Grubbs 显著性水平，默认 0.05
 */
export function detectOutliers(
  values: number[],
  method: 'grubbs' | 'iqr',
  alpha = 0.05,
): OutlierFlag[] {
  switch (method) {
    case 'grubbs':
      return grubbsTest(values, alpha);
    case 'iqr':
      return iqrTest(values);
    default:
      throw new TypeError(`未知异常值识别方法：${String(method)}。`);
  }
}

/** 中位数导出（供直方图/箱线图使用）。 */
export { median };
