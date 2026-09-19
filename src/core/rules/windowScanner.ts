/**
 * 滑动窗口扫描工具（判异准则区间型规则共用）。
 *
 * 出处：架构文档 §9「区间型规则以滑动窗口扫描，一个窗口命中即产出 1 条违规；
 * 为避免刷屏，对同规则连续命中做合并：仅当窗口起点与上一命中窗口不重叠时新增，
 * 否则扩展上一命中的 windowStart / pointIndices」。
 */

import type { RuleGroup, RuleId, RuleViolation } from '../types';

/** 窗口命中判定谓词。 */
export type WindowPredicate = (window: number[], startIndex: number) => boolean;

/**
 * 滑动窗口扫描并按「合并策略」产出违规。
 *
 * 合并策略（在 rules.spec.ts 中固定）：
 * - 若当前命中窗口起点 `start` 与上一次命中窗口的结束索引 `lastEnd` 满足
 *   `start <= lastEnd + 1`（即重叠或紧邻）→ 扩展上一条违规的 pointIndices 到 max(end)，
 *   不新增。
 * - 否则新增一条违规。
 *
 * @param values 主图数值序列
 * @param windowSize 窗口长度
 * @param predicate 窗口命中谓词（入参为窗口内数值切片与窗口起点）
 * @param buildViolation 命中时构造违规对象
 * @returns 违规数组（按窗口起点升序）
 */
export function scanWindows(
  values: number[],
  windowSize: number,
  predicate: WindowPredicate,
  buildViolation: (windowStart: number, windowEnd: number) => RuleViolation,
): RuleViolation[] {
  const violations: RuleViolation[] = [];
  if (values.length < windowSize) {
    return violations;
  }
  let lastEnd = -1;
  for (let start = 0; start + windowSize <= values.length; start += 1) {
    const window = values.slice(start, start + windowSize);
    if (!predicate(window, start)) {
      continue;
    }
    const end = start + windowSize - 1;
    if (violations.length > 0 && start <= lastEnd + 1) {
      // 合并：扩展上一条违规覆盖范围
      const prev = violations[violations.length - 1];
      const merged: number[] = [];
      for (let i = prev.windowStart; i <= end; i += 1) {
        merged.push(i);
      }
      prev.pointIndices = merged;
      const rebuilt = buildViolation(prev.windowStart, end);
      prev.message = rebuilt.message;
      lastEnd = end;
    } else {
      violations.push(buildViolation(start, end));
      lastEnd = end;
    }
  }
  return violations;
}

/** 便捷构造违规对象。 */
export function makeViolation(
  ruleId: RuleId,
  ruleGroup: RuleGroup,
  pointIndices: number[],
  windowStart: number,
  message: string,
  severity: RuleViolation['severity'],
): RuleViolation {
  return { ruleId, ruleGroup, pointIndices, windowStart, message, severity };
}
