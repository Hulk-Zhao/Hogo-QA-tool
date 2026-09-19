/**
 * 判异准则统一入口：按开关求值、聚合、去重。
 *
 * 出处：架构文档 §9.3（重叠处理与去重决策）、§9.5（模块导出）。
 */

import type {
  ControlChartSeries,
  NelsonRuleId,
  RuleEvaluationResult,
  RuleId,
  RuleToggleConfig,
  RuleViolation,
  WesternRuleId,
} from '../types';
import { ALL_RULE_IDS, EQUIVALENT_RULE, defaultToggleConfig } from '../constants/ruleMeta';
import { sigmaByPointOf } from '../charts/controlChart';
import { evaluateW1, evaluateW2, evaluateW3, evaluateW4 } from './westernElectric';
import {
  evaluateN1,
  evaluateN2,
  evaluateN3,
  evaluateN4,
  evaluateN5,
  evaluateN6,
  evaluateN7,
  evaluateN8,
} from './nelson';
import type { RuleContext } from '../types';

export { RULE_META, defaultToggleConfig } from '../constants/ruleMeta';

/**
 * 根据开关配置求值全部启用的规则。
 *
 * @param series 控制图序列
 * @param sigmaByPoint 逐点 σ（变限 P/U 用；常量时全部相同）
 * @param toggles 规则开关
 * @returns 求值结果（含违规、逐点规则映射、启用规则列表）
 */
export function evaluateRules(
  series: ControlChartSeries,
  sigmaByPoint: number[],
  toggles: RuleToggleConfig,
): RuleEvaluationResult {
  const values = series.primary.points.map((p) => p.value);
  const subgroupSizes = series.primary.points.map((p) => p.subgroupSize);
  const clLine = series.limits.primary.find((l) => l.label === 'CL');
  if (!clLine) {
    throw new RangeError('控制图缺少 CL 中心线，无法执行判异。');
  }
  const centerLine = clLine.values[0];
  const sigmaConst = series.sigmaZones?.oneSigma ?? (sigmaByPoint[0] ?? 0);

  const ctx: RuleContext = {
    values,
    centerLine,
    sigma: sigmaConst,
    sigmaByPoint: sigmaByPoint.length === values.length ? sigmaByPoint : new Array<number>(values.length).fill(sigmaConst),
    subgroupSizes,
  };

  const enabledRules = resolveEnabledRules(toggles);
  const violations: RuleViolation[] = [];

  for (const ruleId of enabledRules) {
    switch (ruleId) {
      case 'W1':
        violations.push(...evaluateW1(ctx));
        break;
      case 'W2':
        violations.push(...evaluateW2(ctx));
        break;
      case 'W3':
        violations.push(...evaluateW3(ctx));
        break;
      case 'W4':
        violations.push(...evaluateW4(ctx));
        break;
      case 'N1':
        violations.push(...evaluateN1(ctx));
        break;
      case 'N2':
        violations.push(...evaluateN2(ctx));
        break;
      case 'N3':
        violations.push(...evaluateN3(ctx));
        break;
      case 'N4':
        violations.push(...evaluateN4(ctx));
        break;
      case 'N5':
        violations.push(...evaluateN5(ctx));
        break;
      case 'N6':
        violations.push(...evaluateN6(ctx));
        break;
      case 'N7':
        violations.push(...evaluateN7(ctx));
        break;
      case 'N8':
        violations.push(...evaluateN8(ctx));
        break;
      default:
        break;
    }
  }

  violations.sort((a, b) => a.windowStart - b.windowStart || a.ruleId.localeCompare(b.ruleId));

  return {
    violations,
    pointRuleMap: buildPointRuleMap(violations),
    enabledRules,
  };
}

/** 由开关配置解析出启用的规则 id 列表（顺序固定）。 */
export function resolveEnabledRules(toggles: RuleToggleConfig): RuleId[] {
  const enabled: RuleId[] = [];
  for (const id of ALL_RULE_IDS) {
    if (id.startsWith('W')) {
      if (toggles.westernElectric[id as WesternRuleId]) {
        enabled.push(id);
      }
    } else if (toggles.nelson[id as NelsonRuleId]) {
      enabled.push(id);
    }
  }
  return enabled;
}

/** 构造逐点规则映射。 */
export function buildPointRuleMap(violations: RuleViolation[]): Record<number, RuleId[]> {
  const map: Record<number, RuleId[]> = {};
  for (const v of violations) {
    for (const idx of v.pointIndices) {
      if (!map[idx]) {
        map[idx] = [];
      }
      if (!map[idx].includes(v.ruleId)) {
        map[idx].push(v.ruleId);
      }
    }
  }
  return map;
}

/**
 * 去重：同一 (pointIndices 排序后) 同时命中 Wk 与 Nk（k=1..4）时，
 * 优先展示 W，并在 message 追加「(亦符合尼尔森 Nk)」。
 *
 * 出处：架构文档 §9.3 去重层。
 *
 * @param violations 原始违规列表
 * @param showEquivalent 是否保留等效规则标注（false 时完全丢弃 N 侧副本）
 */
export function dedupeViolations(
  violations: RuleViolation[],
  showEquivalent: boolean,
): RuleViolation[] {
  const seen = new Map<string, RuleViolation>();
  const result: RuleViolation[] = [];

  for (const v of violations) {
    const key = `${[...v.pointIndices].sort((a, b) => a - b).join(',')}`;
    const equivalent = EQUIVALENT_RULE[v.ruleId];
    const isWestern = v.ruleId.startsWith('W');
    const counterpartKey = equivalent ? `${key}` : null;

    if (counterpartKey !== null && equivalent !== undefined) {
      const existing = seen.get(counterpartKey);
      if (existing) {
        // 已存在等效规则命中：若已有为 W（或本次为 N），保留 W。
        const existingIsWestern = existing.ruleId.startsWith('W');
        if (existingIsWestern && !isWestern) {
          if (showEquivalent) {
            existing.message = `${existing.message}（亦符合尼尔森 ${v.ruleId}）`;
          }
          continue;
        }
        if (!existingIsWestern && isWestern) {
          // 用 W 替换 N
          const replaced = { ...v };
          if (showEquivalent) {
            replaced.message = `${v.message}（亦符合尼尔森 ${existing.ruleId}）`;
          }
          const idx = result.indexOf(existing);
          seen.delete(counterpartKey);
          seen.set(counterpartKey, replaced);
          if (idx >= 0) {
            result[idx] = replaced;
          }
          continue;
        }
        continue;
      }
    }

    seen.set(key, v);
    result.push(v);
  }

  return result;
}

/** 从控制图序列推导逐点 σ（转发），供调用方便捷使用。 */
export { sigmaByPointOf };

/** 便捷：无开关时用默认开关。 */
export function evaluateRulesDefault(series: ControlChartSeries, sigmaByPoint: number[]): RuleEvaluationResult {
  return evaluateRules(series, sigmaByPoint, defaultToggleConfig());
}
