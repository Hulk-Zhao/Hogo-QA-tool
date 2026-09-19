/**
 * Cpk 门槛判定（本轮 P2-D，全项目唯一真源）。
 *
 * 门槛出处：PRD 判定口径 1.33 合格 / 1.67 优秀（与 AI 提示词、Markdown 报告一致）。
 *
 * 证伪立场：把 `>=` 改成 `>`、或改动三个门槛常量，边界用例（1.00 / 1.33 / 1.67）变红。
 */

import { describe, expect, it } from 'vitest';
import {
  capabilityGrade,
  capabilityVerdictText,
  CPK_EXCELLENT,
  CPK_LOW,
  CPK_QUALIFIED,
} from '../stats/capabilityVerdict';

describe('capabilityGrade —— 门槛边界', () => {
  it('优秀：>= 1.67（含边界）', () => {
    expect(capabilityGrade(CPK_EXCELLENT)).toBe('excellent');
    expect(capabilityGrade(1.68)).toBe('excellent');
    expect(capabilityGrade(3.6521)).toBe('excellent');
  });

  it('合格：1.33 <= Cpk < 1.67（含下边界）', () => {
    expect(capabilityGrade(CPK_QUALIFIED)).toBe('qualified');
    expect(capabilityGrade(1.4)).toBe('qualified');
    expect(capabilityGrade(1.669)).toBe('qualified');
  });

  it('偏低：1.00 <= Cpk < 1.33', () => {
    expect(capabilityGrade(CPK_LOW)).toBe('low');
    expect(capabilityGrade(1.32)).toBe('low');
  });

  it('不合格：Cpk < 1.00', () => {
    expect(capabilityGrade(0.99)).toBe('fail');
    expect(capabilityGrade(0)).toBe('fail');
    expect(capabilityGrade(-0.5)).toBe('fail');
  });

  it('无法判定：null / NaN / Infinity 不得被当成合格', () => {
    expect(capabilityGrade(null)).toBe('unknown');
    expect(capabilityGrade(Number.NaN)).toBe('unknown');
    expect(capabilityGrade(Number.POSITIVE_INFINITY)).toBe('unknown');
  });
});

describe('capabilityVerdictText —— 判定文案', () => {
  it('五档文案齐备', () => {
    expect(capabilityVerdictText(1.7)).toBe('优秀（≥1.67）');
    expect(capabilityVerdictText(1.33)).toBe('合格（≥1.33）');
    expect(capabilityVerdictText(1.1)).toContain('偏低');
    expect(capabilityVerdictText(0.8)).toContain('不合格');
    expect(capabilityVerdictText(null)).toBe('规格限不足，无法判定');
  });

  it('门槛常量为 PRD 口径', () => {
    expect(CPK_LOW).toBe(1.0);
    expect(CPK_QUALIFIED).toBe(1.33);
    expect(CPK_EXCELLENT).toBe(1.67);
  });
});
