/**
 * 西方电气 4 条判异准则。
 *
 * 出处：Western Electric (1956), Statistical Quality Control Handbook, AT&T。
 * 精确可编程逻辑见架构文档 §9.1。
 */

import type { RuleContext, RuleViolation } from '../types';
import {
  isAllSameSide,
  isAlternating,
  isMonotonicDecreasing,
  isMonotonicIncreasing,
} from './types';
import { makeViolation, scanWindows } from './windowScanner';

/**
 * W1：1 点超 3σ（严格大于；等于 3σ 不触发）。
 *
 * 出处：Western Electric 1956 规则 1。
 */
export function evaluateW1(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl, sigmaByPoint } = ctx;
  const violations: RuleViolation[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const sigma = sigmaByPoint[i] ?? ctx.sigma;
    if (sigma > 0 && Math.abs(values[i] - cl) > 3 * sigma) {
      violations.push(
        makeViolation('W1', 'westernElectric', [i], i, `第 ${i + 1} 点超出 ±3σ 控制限`, 'high'),
      );
    }
  }
  return violations;
}

/**
 * W2：连续 9 点位于中心线同一侧。
 *
 * 出处：Western Electric 1956 规则 2。
 */
export function evaluateW2(ctx: RuleContext): RuleViolation[] {
  const { values, centerLine: cl } = ctx;
  return scanWindows(
    values,
    9,
    (win) => isAllSameSide(win, cl),
    (start, end) =>
      makeViolation(
        'W2',
        'westernElectric',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 9 点在中心线同一侧`,
        'high',
      ),
  );
}

/**
 * W3：连续 6 点严格递增或严格递减（相等即打断）。
 *
 * 出处：Western Electric 1956 规则 3。
 */
export function evaluateW3(ctx: RuleContext): RuleViolation[] {
  const { values } = ctx;
  return scanWindows(
    values,
    6,
    (win) => isMonotonicIncreasing(win) || isMonotonicDecreasing(win),
    (start, end) => {
      const win = values.slice(start, end + 1);
      const dir = isMonotonicIncreasing(win) ? '递增' : '递减';
      return makeViolation(
        'W3',
        'westernElectric',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 6 点${dir}`,
        'medium',
      );
    },
  );
}

/**
 * W4：连续 14 点上下交替。
 *
 * 出处：Western Electric 1956 规则 4。
 */
export function evaluateW4(ctx: RuleContext): RuleViolation[] {
  const { values } = ctx;
  return scanWindows(
    values,
    14,
    (win) => isAlternating(win),
    (start, end) =>
      makeViolation(
        'W4',
        'westernElectric',
        rangeList(start, end),
        start,
        `第 ${start + 1}–${end + 1} 点连续 14 点上下交替`,
        'medium',
      ),
  );
}

/** 生成 [start, end] 闭区间索引列表。 */
function rangeList(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i <= end; i += 1) {
    out.push(i);
  }
  return out;
}

/** 西方电气全部 4 条规则求值。 */
export function evaluateWesternElectric(ctx: RuleContext): RuleViolation[] {
  return [
    ...evaluateW1(ctx),
    ...evaluateW2(ctx),
    ...evaluateW3(ctx),
    ...evaluateW4(ctx),
  ];
}
