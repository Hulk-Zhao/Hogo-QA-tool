/**
 * 尼尔森 8 条判异准则。
 *
 * 出处：Nelson, L. S. (1984). "The Shewhart Control Chart — Tests for Special Causes."
 * Journal of Quality Technology, 16(4), 237–239。
 * 精确可编程逻辑见架构文档 §9.2。
 *
 * 说明：N1..N4 与 W1..W4 等价，因此复用 rules/types.ts 的**相同底层谓词**，
 * 保证「同输入下 Wk 与 Nk 的 pointIndices 完全一致」（架构文档 §9.3）。
 */

import type { RuleContext, RuleViolation } from '../types';
import {
  hasFourInZoneBAtPoint,
  hasTwoInZoneAAtPoint,
  isAllInZoneCAtPoint,
  isAllOutsideZoneCAtPoint,
  isAllSameSide,
  isAlternating,
  isMonotonicDecreasing,
  isMonotonicIncreasing,
} from './types';
import { makeViolation, scanWindows } from './windowScanner';

/** 生成 [start, end] 闭区间索引列表。 */
function rangeList(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) {
    out.push(i);
  }
  return out;
}

/**
 * 截取窗口 [start, end] 对应的逐点 σ 子序列。
 *
 * sigmaByPoint 与整条主图等长；窗口扫描时取窗口对应的切片，
 * 使窗口内第 localIndex 点与全局 sigmaByPoint[start+localIndex] 对齐。
 */
function sliceSigma(sigmaByPoint: number[], start: number, end: number): number[] {
  return sigmaByPoint.slice(start, end + 1);
}

/**
 * N1：1 点超 3σ（同 W1）。
 *
 * 出处：Nelson 1984 规则 1。
 */
export function evaluateN1(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint } = ctx;
  const violations: RuleViolation[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const sigma = sigmaByPoint[i] ?? ctx.sigma;
    if (sigma > 0 && Math.abs(values[i] - cl) > 3 * sigma) {
      violations.push(
        makeViolation('N1', 'nelson', [i], i, `第 ${i + 1} 点超出 ±3σ 控制限`, 'high'),
      );
    }
  }
  return violations;
}

/** N2：连续 9 点同侧（同 W2）。 */
export function evaluateN2(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl } = ctx;
  return scanWindows(
    values,
    9,
    (win) => isAllSameSide(win, cl),
    (start, end) =>
      makeViolation(
        'N2',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 9 点在中心线同一侧`,
        'high',
      ),
  );
}

/** N3：连续 6 点递增或递减（同 W3）。 */
export function evaluateN3(ctx: RuleContext): RuleViolation[] {
  const { values } = ctx;
  return scanWindows(
    values,
    6,
    (win) => isMonotonicIncreasing(win) || isMonotonicDecreasing(win),
    (start, end) => {
      const win = values.slice(start, end + 1);
      const dir = isMonotonicIncreasing(win) ? '递增' : '递减';
      return makeViolation(
        'N3',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 6 点${dir}`,
        'medium',
      );
    },
  );
}

/** N4：连续 14 点交替（同 W4）。 */
export function evaluateN4(ctx: RuleContext): RuleViolation[] {
  const { values } = ctx;
  return scanWindows(
    values,
    14,
    (win) => isAlternating(win),
    (start, end) =>
      makeViolation(
        'N4',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 14 点上下交替`,
        'medium',
      ),
  );
}

/**
 * N5：连续 3 点中有 2 点在同一侧的 A 区或以外（≥2σ）。
 *
 * 出处：Nelson 1984 规则 5；变限时按架构文档 §9.4 使用**逐点 σ_i** 判定。
 */
export function evaluateN5(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint, sigma } = ctx;
  return scanWindowsByIndex(
    values,
    3,
    (start, end) => {
      const win = values.slice(start, end + 1);
      const sigmas = sliceSigma(sigmaByPoint, start, end);
      return hasTwoInZoneAAtPoint(win, cl, sigmas, sigma);
    },
    (start, end) =>
      makeViolation(
        'N5',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点中至少 2 点落在中心线同一侧的 A 区（≥2σ）`,
        'high',
      ),
  );
}

/**
 * N6：连续 5 点中有 4 点在同一侧的 B 区或以外（≥1σ）。
 *
 * 出处：Nelson 1984 规则 6；变限时按架构文档 §9.4 使用**逐点 σ_i** 判定。
 */
export function evaluateN6(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint, sigma } = ctx;
  return scanWindowsByIndex(
    values,
    5,
    (start, end) => {
      const win = values.slice(start, end + 1);
      const sigmas = sliceSigma(sigmaByPoint, start, end);
      return hasFourInZoneBAtPoint(win, cl, sigmas, sigma);
    },
    (start, end) =>
      makeViolation(
        'N6',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点中有 4 点落在中心线同一侧的 B 区或以外（≥1σ）`,
        'medium',
      ),
  );
}

/**
 * N7：连续 15 点全部落在 C 区（严格 <1σ）。
 *
 * 出处：Nelson 1984 规则 7；变限时按架构文档 §9.4 使用**逐点 σ_i** 判定。
 */
export function evaluateN7(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint, sigma } = ctx;
  return scanWindowsByIndex(
    values,
    15,
    (start, end) => {
      const win = values.slice(start, end + 1);
      const sigmas = sliceSigma(sigmaByPoint, start, end);
      return isAllInZoneCAtPoint(win, cl, sigmas, sigma);
    },
    (start, end) =>
      makeViolation(
        'N7',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 15 点全部落在 C 区（<1σ）`,
        'medium',
      ),
  );
}

/**
 * N8：连续 8 点全部落在 C 区以外（≥1σ，不限同侧）。
 *
 * 出处：Nelson 1984 规则 8；变限时按架构文档 §9.4 使用**逐点 σ_i** 判定。
 */
export function evaluateN8(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint, sigma } = ctx;
  return scanWindowsByIndex(
    values,
    8,
    (start, end) => {
      const win = values.slice(start, end + 1);
      const sigmas = sliceSigma(sigmaByPoint, start, end);
      return isAllOutsideZoneCAtPoint(win, cl, sigmas, sigma);
    },
    (start, end) =>
      makeViolation(
        'N8',
        'nelson',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 8 点全部落在 C 区以外（≥1σ）`,
        'medium',
      ),
  );
}

/** 尼尔森全部 8 条规则求值。 */
export function evaluateNelson(ctx: RuleContext): RuleViolation[] {
  return [
    ...evaluateN1(ctx),
    ...evaluateN2(ctx),
    ...evaluateN3(ctx),
    ...evaluateN4(ctx),
    ...evaluateN5(ctx),
    ...evaluateN6(ctx),
    ...evaluateN7(ctx),
    ...evaluateN8(ctx),
  ];
}

/**
 * 索引感知的滑动窗口扫描（合并策略与 rules/types.ts 的 `scanWindows` 一致）。
 *
 * 与 `scanWindows` 的唯一差别：命中谓词接收 `start`/`end` 索引而非窗口切片，
 * 以便访问与主图等长的 `sigmaByPoint`，支持变限 P/U 的**逐点 σ_i** 判定。
 *
 * @param values 主图数值序列
 * @param windowSize 窗口长度
 * @param predicate 命中谓词（入参为窗口起止索引）
 * @param buildViolation 命中时构造违规对象
 * @returns 违规数组（按窗口起点升序）
 */
function scanWindowsByIndex(
  values: number[],
  windowSize: number,
  predicate: (start: number, end: number) => boolean,
  buildViolation: (start: number, end: number) => RuleViolation,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  if (values.length < windowSize) {
    return violations;
  }
  let lastEnd = -1;
  for (let start = 0; start + windowSize <= values.length; start += 1) {
    const end = start + windowSize - 1;
    if (!predicate(start, end)) {
      continue;
    }
    if (violations.length > 0 && start <= lastEnd + 1) {
      const prev = violations[violations.length - 1];
      const merged: number[] = [];
      for (let i = prev.windowStart; i <= end; i += 1) {
        merged.push(i);
      }
      prev.pointIndices = merged;
      prev.message = buildViolation(prev.windowStart, end).message;
      lastEnd = end;
    } else {
      violations.push(buildViolation(start, end));
      lastEnd = end;
    }
  }
  return violations;
}
