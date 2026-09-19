/**
 * 判异准则测试（架构文档 §7 T01 验收要点 4、§9）。
 *
 * 覆盖：
 * - W1..W4 与 N1..N8 逐条正/负样本；
 * - 显式断言 Wk ≡ Nk（k=1..4）在相同输入下 pointIndices 完全一致；
 * - 边界用例：恰好等于 3σ（不触发 W1）、恰好落在 CL（打断序列）、恰好等于 1σ/2σ。
 */

import { describe, expect, it } from 'vitest';
import type { RuleContext, RuleId } from '../types';
import { evaluateW1, evaluateW2, evaluateW3, evaluateW4 } from '../rules/westernElectric';
import {
  evaluateN1,
  evaluateN2,
  evaluateN3,
  evaluateN4,
  evaluateN5,
  evaluateN6,
  evaluateN7,
  evaluateN8,
} from '../rules/nelson';
import { dedupeViolations, evaluateRules, resolveEnabledRules } from '../rules/index';
import { defaultToggleConfig } from '../constants/ruleMeta';
import { buildImr } from '../charts/imr';

/** 构造 RuleContext 的辅助函数。 */
function ctxOf(values: number[], cl: number, sigma: number): RuleContext {
  return {
    values,
    centerLine: cl,
    sigma,
    sigmaByPoint: new Array<number>(values.length).fill(sigma),
    subgroupSizes: new Array<number>(values.length).fill(1),
  };
}

describe('W1 / N1 —— 1 点超 3σ', () => {
  it('超出 3σ 触发', () => {
    const ctx = ctxOf([0, 0, 0, 3.5, 0, 0], 0, 1);
    expect(evaluateW1(ctx).length).toBe(1);
    expect(evaluateW1(ctx)[0].pointIndices).toEqual([3]);
    expect(evaluateN1(ctx)[0].pointIndices).toEqual([3]);
  });

  it('边界：恰好等于 3σ 不触发（严格大于）', () => {
    const ctx = ctxOf([0, 3, 0, -3, 0], 0, 1);
    expect(evaluateW1(ctx).length).toBe(0);
    expect(evaluateN1(ctx).length).toBe(0);
  });

  it('负样本：全在 3σ 内不触发', () => {
    const ctx = ctxOf([0.5, -0.5, 1.2, -1.8, 2.9, -2.9], 0, 1);
    expect(evaluateW1(ctx).length).toBe(0);
  });
});

describe('W2 / N2 —— 连续 9 点同侧', () => {
  it('连续 9 点在 CL 上方触发', () => {
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 0];
    const ctx = ctxOf(values, 0, 1);
    const w = evaluateW2(ctx);
    expect(w.length).toBe(1);
    expect(w[0].pointIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(evaluateN2(ctx)[0].pointIndices).toEqual(w[0].pointIndices);
  });

  it('边界：恰好落在 CL 的点打断同侧序列', () => {
    const values = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1];
    const ctx = ctxOf(values, 0, 1);
    // 两侧各 4 点 + 1 点，均不足 9 点
    expect(evaluateW2(ctx).length).toBe(0);
  });

  it('负样本：交替上下不触发', () => {
    const values = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateW2(ctx).length).toBe(0);
  });

  it('区间合并：连续 10 点同侧只产出 1 条合并违规', () => {
    const values = new Array<number>(10).fill(1);
    const ctx = ctxOf(values, 0, 1);
    const w = evaluateW2(ctx);
    expect(w.length).toBe(1);
    expect(w[0].pointIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('W3 / N3 —— 连续 6 点递增/递减', () => {
  it('严格递增 6 点触发', () => {
    const values = [1, 2, 3, 4, 5, 6, 0];
    const ctx = ctxOf(values, 3, 1);
    const w = evaluateW3(ctx);
    expect(w.length).toBe(1);
    expect(w[0].message).toContain('递增');
    expect(evaluateN3(ctx)[0].pointIndices).toEqual(w[0].pointIndices);
  });

  it('严格递减 6 点触发', () => {
    const values = [6, 5, 4, 3, 2, 1, 7];
    const ctx = ctxOf(values, 3, 1);
    const w = evaluateW3(ctx);
    expect(w.length).toBe(1);
    expect(w[0].message).toContain('递减');
  });

  it('边界：含相等值即打断（不触发）', () => {
    const values = [1, 2, 3, 3, 4, 5, 6];
    const ctx = ctxOf(values, 3, 1);
    expect(evaluateW3(ctx).length).toBe(0);
  });

  it('负样本：无 6 点单调序列不触发', () => {
    const values = [1, 3, 2, 4, 3, 5, 4, 6];
    const ctx = ctxOf(values, 3, 1);
    expect(evaluateW3(ctx).length).toBe(0);
  });
});

describe('W4 / N4 —— 连续 14 点交替', () => {
  it('14 点严格交替触发', () => {
    const values = Array.from({ length: 14 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const ctx = ctxOf(values, 0, 1);
    const w = evaluateW4(ctx);
    expect(w.length).toBe(1);
    expect(w[0].pointIndices).toEqual(Array.from({ length: 14 }, (_, i) => i));
    expect(evaluateN4(ctx)[0].pointIndices).toEqual(w[0].pointIndices);
  });

  it('边界：序列中含相等值则打断', () => {
    const values = [1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateW4(ctx).length).toBe(0);
  });

  it('负样本：不足 14 点不触发', () => {
    const values = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateW4(ctx).length).toBe(0);
  });
});

describe('N5 —— 3 点中 2 点在 A 区（同侧）', () => {
  it('3 点中 2 点同侧超 2σ 触发', () => {
    const values = [0, 2.5, 2.6, 0];
    const ctx = ctxOf(values, 0, 1);
    const n5 = evaluateN5(ctx);
    expect(n5.length).toBeGreaterThan(0);
    expect(n5[0].pointIndices).toContain(1);
    expect(n5[0].pointIndices).toContain(2);
  });

  it('负样本：2 点分处两侧不触发', () => {
    const values = [2.5, 0, -2.6, 0];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN5(ctx).length).toBe(0);
  });

  it('边界：恰好等于 2σ 算 A 区（>=2σ）', () => {
    const values = [0, 2, 2, 0];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN5(ctx).length).toBeGreaterThan(0);
  });
});

describe('N6 —— 5 点中 4 点在 B 区或以外（同侧）', () => {
  it('5 点中 4 点同侧超 1σ 触发', () => {
    const values = [1.5, 1.6, 1.7, 0.5, 1.8];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN6(ctx).length).toBeGreaterThan(0);
  });

  it('边界：恰好等于 1σ 算 B 区（>=1σ）', () => {
    const values = [1, 1, 1, 1, 0];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN6(ctx).length).toBeGreaterThan(0);
  });

  it('负样本：仅 3 点同侧超 1σ 不触发', () => {
    const values = [1, 1, 1, 0.5, 0.5];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN6(ctx).length).toBe(0);
  });
});

describe('N7 —— 连续 15 点在 C 区', () => {
  it('15 点全部 <1σ 触发', () => {
    const values = new Array<number>(15).fill(0.5);
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN7(ctx).length).toBe(1);
  });

  it('边界：恰好等于 1σ 不算 C 区（不触发）', () => {
    const values = new Array<number>(15).fill(1);
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN7(ctx).length).toBe(0);
  });

  it('负样本：含 1 点超 1σ 不触发', () => {
    const values = new Array<number>(15).fill(0.5);
    values[7] = 1.2;
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN7(ctx).length).toBe(0);
  });
});

describe('N8 —— 连续 8 点在 C 区外（两侧）', () => {
  it('8 点全部 >=1σ（可两侧混合）触发', () => {
    const values = [1.1, -1.2, 1.3, -1.1, 1.4, -1.5, 1.2, -1.6, 0];
    const ctx = ctxOf(values, 0, 1);
    const n8 = evaluateN8(ctx);
    expect(n8.length).toBeGreaterThan(0);
    expect(n8[0].pointIndices[0]).toBe(0);
  });

  it('边界：恰好等于 1σ 算 C 区外（触发）', () => {
    const values = [1, -1, 1, -1, 1, -1, 1, -1, 0];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN8(ctx).length).toBeGreaterThan(0);
  });

  it('负样本：含 1 点在 C 区内不触发', () => {
    const values = [1.1, -1.2, 1.3, -1.1, 0.3, -1.5, 1.2, -1.6, 0];
    const ctx = ctxOf(values, 0, 1);
    expect(evaluateN8(ctx).length).toBe(0);
  });
});

describe('★ Wk ≡ Nk (k=1..4) 等价性断言', () => {
  const cases: Array<{ name: string; values: number[]; cl: number; sigma: number }> = [
    { name: 'W1/N1 超3σ', values: [0, 0, 4, 0, -4.2, 0], cl: 0, sigma: 1 },
    { name: 'W2/N2 9点同侧', values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1], cl: 0, sigma: 1 },
    { name: 'W3/N3 6点递增', values: [1, 2, 3, 4, 5, 6, 8, 9], cl: 3, sigma: 1 },
    {
      name: 'W4/N4 14点交替',
      values: Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 1 : -1)),
      cl: 0,
      sigma: 1,
    },
  ];

  it.each(cases)('$name：Wk 与 Nk 的 pointIndices 完全一致', (c) => {
    const ctx = ctxOf(c.values, c.cl, c.sigma);
    const wResults = [evaluateW1(ctx), evaluateW2(ctx), evaluateW3(ctx), evaluateW4(ctx)];
    const nResults = [evaluateN1(ctx), evaluateN2(ctx), evaluateN3(ctx), evaluateN4(ctx)];
    for (let k = 0; k < 4; k += 1) {
      const wPoints = wResults[k].map((v) => v.pointIndices.join(','));
      const nPoints = nResults[k].map((v) => v.pointIndices.join(','));
      expect(nPoints).toEqual(wPoints);
    }
  });
});

describe('evaluateRules —— 开关与去重', () => {
  it('默认开关下启用 W1..W4 + N5..N8', () => {
    const enabled = resolveEnabledRules(defaultToggleConfig());
    expect(enabled).toEqual(['W1', 'W2', 'W3', 'W4', 'N5', 'N6', 'N7', 'N8']);
  });

  it('关闭某规则后不再参与判定', () => {
    const toggles = defaultToggleConfig();
    toggles.westernElectric.W1 = false;
    const enabled = resolveEnabledRules(toggles);
    expect(enabled).not.toContain('W1');
  });

  it('去重：同点窗口同时命中 W1/N1 时优先展示 W 并标注等效', () => {
    const toggles = defaultToggleConfig();
    toggles.nelson.N1 = true; // 同时启用 W1 与 N1
    const values = [0, 0, 4.5, 0, 0];
    const series = buildImr(values);
    // sigma = MR̄/1.128；4.5 相对足够大使超 3σ（此处直接构造 sigmaByPoint）
    const sigma = 1;
    const result = evaluateRules(series, new Array<number>(values.length).fill(sigma), toggles);
    const deduped = dedupeViolations(result.violations, true);
    const w1 = deduped.filter((v) => v.ruleId === 'W1');
    const n1 = deduped.filter((v) => v.ruleId === 'N1');
    expect(w1.length).toBeGreaterThan(0);
    expect(n1.length).toBe(0);
    expect(w1[0].message).toContain('亦符合尼尔森');
  });

  it('去重后展示数量 <= 去重前 unique(pointIndices) 数', () => {
    const toggles = defaultToggleConfig();
    toggles.nelson.N1 = true;
    const values = [0, 0, 4.5, 0, 0];
    const series = buildImr(values);
    const sigma = 1;
    const result = evaluateRules(series, new Array<number>(values.length).fill(sigma), toggles);
    const deduped = dedupeViolations(result.violations, false);
    expect(deduped.length).toBeLessThanOrEqual(result.violations.length);
  });

  it('pointRuleMap 覆盖所有违规点', () => {
    const toggles = defaultToggleConfig();
    const values = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    const series = buildImr(values);
    const result = evaluateRules(series, new Array<number>(values.length).fill(0.5), toggles);
    for (const v of result.violations) {
      for (const idx of v.pointIndices) {
        expect(result.pointRuleMap[idx]).toContain(v.ruleId as RuleId);
      }
    }
  });
});
