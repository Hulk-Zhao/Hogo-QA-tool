/**
 * QA 独立验证套件 —— 第三轮：判异准则边界 + Wk≡Nk + 变限 P/U 逐点 σ。
 */

import { describe, expect, it } from 'vitest';
import type { RuleContext } from '../types';
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
import { evaluateRules } from '../rules/index';
import { defaultToggleConfig } from '../constants/ruleMeta';
import { buildP } from '../charts/attributes';

function ctxOf(values: number[], cl: number, sigma: number, sigmaByPoint?: number[]): RuleContext {
  return {
    values,
    centerLine: cl,
    sigma,
    sigmaByPoint: sigmaByPoint ?? new Array<number>(values.length).fill(sigma),
    subgroupSizes: new Array<number>(values.length).fill(1),
  };
}

describe('QA-9 W1/N1 严格大于 3σ 边界', () => {
  it('恰好 3σ 不触发；略超触发', () => {
    expect(evaluateW1(ctxOf([0, 3, 0], 0, 1)).length).toBe(0);
    expect(evaluateW1(ctxOf([0, 3.0000001, 0], 0, 1)).length).toBe(1);
    expect(evaluateN1(ctxOf([0, -3, 0], 0, 1)).length).toBe(0);
    expect(evaluateN1(ctxOf([0, -3.0000001, 0], 0, 1)).length).toBe(1);
  });
});

describe('QA-10 等于 CL 的点打断序列（已拍板口径）', () => {
  it('W2：CL 点插入后两侧均不足 9 点 → 不触发', () => {
    const v = [1, 1, 1, 1, 0, 1, 1, 1, 1, 1]; // 左4+右5
    expect(evaluateW2(ctxOf(v, 0, 1)).length).toBe(0);
    expect(evaluateN2(ctxOf(v, 0, 1)).length).toBe(0);
  });
  it('W3：含相等值打断递增 → 不触发', () => {
    expect(evaluateW3(ctxOf([1, 2, 3, 3, 4, 5, 6], 0, 1)).length).toBe(0);
  });
  it('W4：含相等值打断交替 → 不触发', () => {
    const v = [1, -1, 1, -1, 1, 1, -1, 1, -1, 1, -1, 1, -1, 1];
    expect(evaluateW4(ctxOf(v, 0, 1)).length).toBe(0);
  });
});

describe('QA-11 Wk ≡ Nk (k=1..4) 独立验证', () => {
  const cases: Array<[string, number[], number, number]> = [
    ['W1/N1', [0, 4.5, 0, -4.5, 0], 0, 1],
    ['W2/N2', new Array(11).fill(1), 0, 1],
    ['W3/N3', [1, 2, 3, 4, 5, 6, 7], 3, 1],
    ['W4/N4', Array.from({ length: 16 }, (_, i) => (i % 2 === 0 ? 1 : -1)), 0, 1],
  ];
  it.each(cases)('%s：pointIndices/message 完全一致', (_n, values, cl, sigma) => {
    const ctx = ctxOf(values, cl, sigma);
    const w = [evaluateW1, evaluateW2, evaluateW3, evaluateW4].map((f) => f(ctx));
    const n = [evaluateN1, evaluateN2, evaluateN3, evaluateN4].map((f) => f(ctx));
    for (let k = 0; k < 4; k += 1) {
      expect(n[k].map((v) => v.pointIndices.join(','))).toEqual(w[k].map((v) => v.pointIndices.join(',')));
      expect(n[k].map((v) => v.message)).toEqual(w[k].map((v) => v.message));
    }
  });
});

describe('QA-12 N5 边界：恰好 2σ 算 A 区，差一点不算', () => {
  it('恰好 2 点 = 2σ（同侧）触发', () => {
    expect(evaluateN5(ctxOf([0, 2, 2, 0], 0, 1)).length).toBeGreaterThan(0);
  });
  it('仅 1 点达 2σ 不触发', () => {
    expect(evaluateN5(ctxOf([0, 2, 1.99, 0], 0, 1)).length).toBe(0);
  });
  it('2 点分处两侧不触发', () => {
    expect(evaluateN5(ctxOf([2.5, 0, -2.6, 0], 0, 1)).length).toBe(0);
  });
});

describe('QA-13 N6 边界：恰好 4 点 = 1σ 触发，3 点不触发', () => {
  it('4 点 = 1σ 同侧触发', () => {
    expect(evaluateN6(ctxOf([1, 1, 1, 1, 0], 0, 1)).length).toBeGreaterThan(0);
  });
  it('仅 3 点达 1σ 不触发', () => {
    expect(evaluateN6(ctxOf([1, 1, 1, 0.99, 0.5], 0, 1)).length).toBe(0);
  });
});

describe('QA-14 N7 边界：恰好 1σ 不算 C 区 → 不触发', () => {
  it('15 点恰在 1σ 不触发', () => {
    expect(evaluateN7(ctxOf(new Array(15).fill(1), 0, 1)).length).toBe(0);
  });
  it('15 点全 < 1σ 触发', () => {
    expect(evaluateN7(ctxOf(new Array(15).fill(0.999), 0, 1)).length).toBe(1);
  });
});

describe('QA-15 N8 边界：恰好 1σ 算 C 区外 → 触发', () => {
  it('8 点 = 1σ（混合侧）触发', () => {
    expect(evaluateN8(ctxOf([1, -1, 1, -1, 1, -1, 1, -1], 0, 1)).length).toBeGreaterThan(0);
  });
  it('含 1 点 < 1σ 不触发', () => {
    expect(evaluateN8(ctxOf([1, -1, 1, -1, 0.99, -1, 1, -1], 0, 1)).length).toBe(0);
  });
});

describe('QA-16 区间合并：连续 10 点同侧合并为 1 条', () => {
  it('W2 连续 10 点 → 1 条且覆盖 0..9', () => {
    const w = evaluateW2(ctxOf(new Array(10).fill(1), 0, 1));
    expect(w.length).toBe(1);
    expect(w[0].pointIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('QA-17 ★ 变限 P 图：N5/N6 必须用逐点 σ_i（架构 §9.4）', () => {
  it('N5 在变限 P 图下按逐点 σ_i 判定，而非窗口平均 σ', () => {
    // 构造样本量差异极大的 P 图：点 0/1 样本量小 → σ_i 大；点 2 样本量大 → σ_i 小。
    const d = [3, 3, 3];
    const n = [10, 10, 1000];
    const series = buildP({ defectivesOrDefects: d, sampleSizes: n });
    // 逐点 σ_i = (UCL_i - CL_i)/3
    const cl = series.limits.primary.find((l) => l.label === 'CL')!;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const sigmaByPoint = ucl.values.map((u, i) => (u - cl.values[i]) / 3);
    // 逐点 σ 明显不一致（差异是设计的核心）
    expect(Math.max(...sigmaByPoint) / Math.min(...sigmaByPoint)).toBeGreaterThan(3);

    const toggles = defaultToggleConfig();
    const res = evaluateRules(series, sigmaByPoint, toggles);
    // 期望：N5 应按每点自身 σ_i 判定；若实现用窗口平均 σ，则与逐点判定结果不一致。
    const pValues = series.primary.points.map((p) => p.value);

    // 手工逐点判定 N5（正确口径）：窗口内同侧且 |v-CL| >= 2*sigma_i 的点数 >= 2
    function correctN5(): boolean {
      for (let i = 0; i + 3 <= pValues.length; i += 1) {
        const win = pValues.slice(i, i + 3);
        for (const side of [1, -1]) {
          let c = 0;
          for (let j = 0; j < 3; j += 1) {
            const idx = i + j;
            const dv = win[j] - cl.values[0];
            const s = sigmaByPoint[idx];
            if (Math.sign(dv) === side && Math.abs(dv) >= 2 * s) c += 1;
          }
          if (c >= 2) return true;
        }
      }
      return false;
    }
    const hasN5 = res.violations.some((v) => v.ruleId === 'N5');
    expect(hasN5).toBe(correctN5());
  });
});
