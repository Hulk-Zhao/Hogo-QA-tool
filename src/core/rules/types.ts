/**
 * 判异规则内部共享类型与底层谓词。
 *
 * 出处：Western Electric (1956) 与 Nelson (1984), JQT 16(4):244–250。
 *
 * 统一约定（架构文档 §9）：CL 上的点（|v-CL| <= EQUAL_EPS）打断同侧/递增/交替序列。
 */

import { EQUAL_EPS } from '../constants/ruleMeta';

/** 点相对中心线的位置：+1 上方、-1 下方、0 在中心线上。 */
export type Side = 1 | -1 | 0;

/**
 * 判定点相对 CL 的侧别。
 *
 * @param v 点值
 * @param cl 中心线
 * @returns +1（v > CL + EPS）、-1（v < CL - EPS）、0（在中心线上）
 */
export function sideOf(v: number, cl: number): Side {
  const d = v - cl;
  if (Math.abs(d) <= EQUAL_EPS) {
    return 0;
  }
  return d > 0 ? 1 : -1;
}

/**
 * 点到 CL 的距离 |v - CL| 所属区域。
 *
 * 出处：架构文档 §9 分区定义（A: [2σ,3σ)、B: [1σ,2σ)、C: <1σ）。
 * @returns 'A' | 'B' | 'C'
 */
export function zoneOf(value: number, cl: number, sigma: number): 'A' | 'B' | 'C' {
  const d = Math.abs(value - cl);
  if (sigma <= 0) {
    return 'C';
  }
  if (d >= 2 * sigma) {
    return 'A';
  }
  if (d >= 1 * sigma) {
    return 'B';
  }
  return 'C';
}

/**
 * 判定窗口内是否全部位于 CL 同一侧（任一为 0 则失败）。
 *
 * 出处：W2 / N2 判定逻辑。
 */
export function isAllSameSide(values: number[], cl: number): boolean {
  if (values.length === 0) {
    return false;
  }
  const first = sideOf(values[0], cl);
  if (first === 0) {
    return false;
  }
  for (let i = 1; i < values.length; i += 1) {
    const s = sideOf(values[i], cl);
    if (s === 0 || s !== first) {
      return false;
    }
  }
  return true;
}

/**
 * 判定窗口内是否严格单调递增（相等即打断）。
 *
 * 出处：W3 / N3 判定逻辑。
 */
export function isMonotonicIncreasing(values: number[]): boolean {
  if (values.length < 2) {
    return false;
  }
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i] > values[i - 1] + EQUAL_EPS)) {
      return false;
    }
  }
  return true;
}

/**
 * 判定窗口内是否严格单调递减（相等即打断）。
 */
export function isMonotonicDecreasing(values: number[]): boolean {
  if (values.length < 2) {
    return false;
  }
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i] < values[i - 1] - EQUAL_EPS)) {
      return false;
    }
  }
  return true;
}

/**
 * 判定窗口内相邻差符号是否严格交替（不允许相等）。
 *
 * 出处：W4 / N4 判定逻辑。要求窗口内所有 d[j] ∈ {+1,-1} 且 d[j] != d[j-1]。
 */
export function isAlternating(values: number[]): boolean {
  if (values.length < 3) {
    return false;
  }
  let prevSign = 0;
  for (let i = 1; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (Math.abs(diff) <= EQUAL_EPS) {
      return false;
    }
    const sign: number = diff > 0 ? 1 : -1;
    if (prevSign !== 0 && sign === prevSign) {
      return false;
    }
    prevSign = sign;
  }
  return true;
}

/**
 * 统计窗口内位于指定侧且 |v-CL| >= threshold 的点数。
 *
 * 用于 N5（threshold=2σ，同侧 ≥2 点）与 N6（threshold=1σ，同侧 ≥4 点）。
 *
 * @param values 窗口内点值
 * @param cl 中心线
 * @param sigma 标准差
 * @param thresholdSigma 阈值倍数（如 2 表示 ≥2σ）
 * @param side 目标侧别（+1 / -1）
 */
export function countSameSideInZone(
  values: number[],
  cl: number,
  sigma: number,
  thresholdSigma: number,
  side: 1 | -1,
): number {
  if (sigma <= 0) {
    return 0;
  }
  let count = 0;
  for (const v of values) {
    if (sideOf(v, cl) === side && Math.abs(v - cl) >= thresholdSigma * sigma) {
      count += 1;
    }
  }
  return count;
}

/**
 * 判定窗口内是否全部在 C 区（|v-CL| < 1σ）。
 *
 * 出处：N7 判定逻辑。
 */
export function isAllInZoneC(values: number[], cl: number, sigma: number): boolean {
  if (sigma <= 0) {
    return false;
  }
  for (const v of values) {
    if (!(Math.abs(v - cl) < sigma)) {
      return false;
    }
  }
  return true;
}

/**
 * 判定窗口内是否全部在 C 区外（|v-CL| >= 1σ）。
 *
 * 出处：N8 判定逻辑（不限同侧）。
 */
export function isAllOutsideZoneC(values: number[], cl: number, sigma: number): boolean {
  if (sigma <= 0) {
    return false;
  }
  for (const v of values) {
    if (!(Math.abs(v - cl) >= sigma)) {
      return false;
    }
  }
  return true;
}

/**
 * 窗口内是否至少存在一「侧」满足：该侧 ≥2 点在 A 区或以外（|v-CL| >= 2σ）。
 *
 * 用于 N5：
 * 出处：Nelson 1984 规则 5「3 点中有 2 点在同一侧的 A 区或更外」。
 */
export function hasTwoInZoneA(values: number[], cl: number, sigma: number): boolean {
  return (
    countSameSideInZone(values, cl, sigma, 2, 1) >= 2 ||
    countSameSideInZone(values, cl, sigma, 2, -1) >= 2
  );
}

/**
 * 窗口内是否至少存在一「侧」满足：该侧 ≥4 点在 B 区或以外（|v-CL| >= 1σ）。
 *
 * 用于 N6：
 * 出处：Nelson 1984 规则 6「5 点中有 4 点在同一侧的 B 区或更外」。
 */
export function hasFourInZoneB(values: number[], cl: number, sigma: number): boolean {
  return (
    countSameSideInZone(values, cl, sigma, 1, 1) >= 4 ||
    countSameSideInZone(values, cl, sigma, 1, -1) >= 4
  );
}

// ---------------------------------------------------------------------------
// 变限（逐点 σ_i）分区谓词 —— 架构文档 §9.4。
//
// 「N5/N6/N8 的分区判定用 |v[i]-CL| 与该点 sigma_i 比较」，故窗口内每个点
// i 使用各自的 sigmaByPoint[i]（而非窗口平均 σ）。以下谓词与上面的常量 σ
// 版本语义一一对应，只是把单一 sigma 换成逐点数组；当 sigmaByPoint 全相同时
// 二者等价（W/N 一致性由 rules.spec.ts 固定）。
// ---------------------------------------------------------------------------

/**
 * 返回窗口内第 i 点应使用的 σ。
 *
 * 逐点数组优先；缺失（长度不足或非正）时回退到常量 σ。用于变限 P/U。
 */
function perPointSigma(sigmaByPoint: number[], localIndex: number, fallback: number): number {
  const s = sigmaByPoint[localIndex];
  if (typeof s === 'number' && Number.isFinite(s) && s > 0) {
    return s;
  }
  return fallback;
}

/**
 * 逐点 σ 版 N5 谓词：窗口内是否存在一侧，其 ≥2 点满足 |v[i]-CL| >= 2·σ_i。
 *
 * 出处：架构文档 §9.4（变限 P/U 逐点 σ_i 口径）；Nelson 1984 规则 5。
 *
 * @param values 窗口内点值
 * @param cl 中心线
 * @param sigmaByPoint 与窗口等长的逐点 σ（localIndex 从 0 起）
 * @param fallback 逐点 σ 缺失时的回退值
 */
export function hasTwoInZoneAAtPoint(
  values: number[],
  cl: number,
  sigmaByPoint: number[],
  fallback: number,
): boolean {
  return (
    countSameSideAtPoint(values, cl, sigmaByPoint, fallback, 2, 1) >= 2 ||
    countSameSideAtPoint(values, cl, sigmaByPoint, fallback, 2, -1) >= 2
  );
}

/**
 * 逐点 σ 版 N6 谓词：窗口内是否存在一侧，其 ≥4 点满足 |v[i]-CL| >= 1·σ_i。
 *
 * 出处：架构文档 §9.4；Nelson 1984 规则 6。
 */
export function hasFourInZoneBAtPoint(
  values: number[],
  cl: number,
  sigmaByPoint: number[],
  fallback: number,
): boolean {
  return (
    countSameSideAtPoint(values, cl, sigmaByPoint, fallback, 1, 1) >= 4 ||
    countSameSideAtPoint(values, cl, sigmaByPoint, fallback, 1, -1) >= 4
  );
}

/**
 * 逐点 σ 版 N7 谓词：窗口内**每一点**都满足 |v[i]-CL| < σ_i（严格）。
 *
 * 出处：架构文档 §9.4；Nelson 1984 规则 7。
 */
export function isAllInZoneCAtPoint(
  values: number[],
  cl: number,
  sigmaByPoint: number[],
  fallback: number,
): boolean {
  for (let i = 0; i < values.length; i += 1) {
    const sigma = perPointSigma(sigmaByPoint, i, fallback);
    if (!(sigma > 0)) {
      return false;
    }
    if (!(Math.abs(values[i] - cl) < sigma)) {
      return false;
    }
  }
  return true;
}

/**
 * 逐点 σ 版 N8 谓词：窗口内**每一点**都满足 |v[i]-CL| >= σ_i（不限同侧）。
 *
 * 出处：架构文档 §9.4；Nelson 1984 规则 8。
 */
export function isAllOutsideZoneCAtPoint(
  values: number[],
  cl: number,
  sigmaByPoint: number[],
  fallback: number,
): boolean {
  for (let i = 0; i < values.length; i += 1) {
    const sigma = perPointSigma(sigmaByPoint, i, fallback);
    if (!(sigma > 0)) {
      return false;
    }
    if (!(Math.abs(values[i] - cl) >= sigma)) {
      return false;
    }
  }
  return true;
}

/**
 * 逐点 σ 版计数：统计窗口内位于指定侧且 |v[i]-CL| >= threshold·σ_i 的点数。
 *
 * @param values 窗口内点值
 * @param cl 中心线
 * @param sigmaByPoint 与窗口等长的逐点 σ
 * @param fallback 逐点 σ 缺失时的回退值
 * @param thresholdSigma 阈值倍数（如 2 表示 ≥2σ_i）
 * @param side 目标侧别（+1 / -1）
 */
export function countSameSideAtPoint(
  values: number[],
  cl: number,
  sigmaByPoint: number[],
  fallback: number,
  thresholdSigma: number,
  side: 1 | -1,
): number {
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const sigma = perPointSigma(sigmaByPoint, i, fallback);
    if (!(sigma > 0)) {
      continue;
    }
    if (sideOf(values[i], cl) === side && Math.abs(values[i] - cl) >= thresholdSigma * sigma) {
      count += 1;
    }
  }
  return count;
}
