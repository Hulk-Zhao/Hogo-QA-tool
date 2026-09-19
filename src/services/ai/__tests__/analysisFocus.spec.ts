/**
 * analysisFocus 测试（P4-B：AI 分析方向）。
 *
 * 证伪立场：
 *  - 若 normalizeFocusIds 不再丢弃未知 id → 「未知 id 被丢弃」变红；
 *  - 若它按用户点击顺序而不是固定顺序输出 → 「顺序固定」变红（结果不可复现）；
 *  - 若 focusInstructionText 漏掉某条方向的 instruction → 「逐条覆盖」变红；
 *  - 若默认方向被清空 → 「默认至少 3 条且包含稳定性/能力/改善」变红。
 */

import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_FOCUSES,
  DEFAULT_FOCUS_IDS,
  findFocus,
  focusInstructionText,
  focusLabels,
  intersectFocus,
  normalizeFocusIds,
} from '../analysisFocus';

describe('analysisFocus', () => {
  it('方向清单非空、id 唯一、每条都有标签/说明/指令', () => {
    expect(ANALYSIS_FOCUSES.length).toBeGreaterThanOrEqual(5);
    const ids = ANALYSIS_FOCUSES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of ANALYSIS_FOCUSES) {
      expect(f.label.length).toBeGreaterThan(0);
      expect(f.hint.length).toBeGreaterThan(0);
      expect(f.instruction.length).toBeGreaterThan(10);
    }
  });

  it('默认方向至少 3 条，且覆盖稳定性 / 能力 / 改善', () => {
    expect(DEFAULT_FOCUS_IDS.length).toBeGreaterThanOrEqual(3);
    expect(DEFAULT_FOCUS_IDS).toContain('stability');
    expect(DEFAULT_FOCUS_IDS).toContain('capability');
    expect(DEFAULT_FOCUS_IDS).toContain('improvement');
  });

  it('★ intersectFocus：只保留模块适用的方向，顺序仍按固定清单（否则模块会收到无意义方向）', () => {
    expect(intersectFocus(['capability', 'defectPareto'], ['defectPareto', 'riskWarning'])).toEqual([
      'defectPareto',
    ]);
    // 顺序与用户勾选顺序无关，永远按 ANALYSIS_FOCUSES
    expect(intersectFocus(['improvement', 'capability'], ['capability', 'improvement'])).toEqual([
      'capability',
      'improvement',
    ]);
    // 完全不适用 → 空集（调用方据此跳过该模块，不发请求）
    expect(intersectFocus(['defectPareto'], ['capability'])).toEqual([]);
    expect(intersectFocus(['nope'], ['capability'])).toEqual([]);
  });

  it('归一化：丢弃未知 id 与非字符串、去重、保持清单固定顺序', () => {
    expect(normalizeFocusIds(['improvement', 'stability', 'improvement'])).toEqual([
      'stability',
      'improvement',
    ]);
    expect(normalizeFocusIds(['nope', 42, null, undefined, {}])).toEqual([]);
    // 输入顺序与输出顺序无关：永远按 ANALYSIS_FOCUSES 的顺序
    const reversed = [...ANALYSIS_FOCUSES].reverse().map((f) => f.id);
    expect(normalizeFocusIds(reversed)).toEqual(ANALYSIS_FOCUSES.map((f) => f.id));
  });

  it('findFocus 命中 / 未命中', () => {
    expect(findFocus('delivery')?.label).toBe('客户交付口径');
    expect(findFocus('不存在')).toBeUndefined();
  });

  it('指令块逐条覆盖选中的方向，且顺序与清单一致', () => {
    const text = focusInstructionText(['improvement', 'stability']);
    const stabilityAt = text.indexOf(findFocus('stability')!.instruction);
    const improvementAt = text.indexOf(findFocus('improvement')!.instruction);
    expect(stabilityAt).toBeGreaterThan(-1);
    expect(improvementAt).toBeGreaterThan(-1);
    expect(stabilityAt).toBeLessThan(improvementAt);
    expect(text).toContain('分析方向');
    // 未选中的方向不得出现
    expect(text).not.toContain(findFocus('delivery')!.instruction);
  });

  it('一个方向都没选 → 指令块为空串（调用方据此拒绝生成）', () => {
    expect(focusInstructionText([])).toBe('');
    expect(focusInstructionText(['bogus'])).toBe('');
  });

  it('focusLabels 返回中文标签', () => {
    expect(focusLabels(['stability', 'capability'])).toEqual(['过程稳定性', '过程能力达标']);
  });
});
