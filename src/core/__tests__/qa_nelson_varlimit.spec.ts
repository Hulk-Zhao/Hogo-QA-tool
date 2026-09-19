/**
 * QA 独立验证：N5/N6/N7/N8 在「变限」（逐点不同 σ_i）下的分区判定。
 *
 * 架构 §9.4 明文约定：
 *   「N5/N6/N8 的分区判定用 |v[i]-CL| 与该点 sigma_i 比较。
 *    此约定写进测试（用变样本量的 P 图 fixture）。」
 *
 * 这些用例最初用于证伪：修复前 src/core/rules/nelson.ts 的 N5/N6/N7/N8 误用
 * averageSigma(窗口平均 σ)，本文件用「差异可判别」的构造使其失败（已确认源码 Bug）。
 * 寇豆码已改为逐点 σ_i（rules/types.ts 新增 *AtPoint 谓词），本文件现作为
 * **回归护栏**：断言区间判定严格采用逐点 σ_i 口径。
 */

import { describe, expect, it } from 'vitest';
import type { RuleContext } from '../types';
import { evaluateN5, evaluateN6, evaluateN7, evaluateN8 } from '../rules/nelson';

function ctx(values: number[], cl: number, sigmaByPoint: number[], sigma = sigmaByPoint[0] ?? 1): RuleContext {
  return {
    values,
    centerLine: cl,
    sigma,
    sigmaByPoint,
    subgroupSizes: values.map(() => 100),
  };
}

describe('QA-VL N5/N6/N7/N8 变限逐点 σ 口径', () => {
  it('N5：窗口内 σ_i 差异大时，逐点口径应命中而窗口平均口径落空（3 点中 2 点在 A 区）', () => {
    // CL=0。窗口 3 点。第 0、2 点距离 2.5、2.5（同侧上方）；
    // 但这两点的 σ_i 很小(=1)，窗口内第 1 点 σ_i 很大(=10)。
    // 逐点 σ_i 口径：|2.5-0| >= 2*1 → 两点都在 A 区 → 命中 N5。
    // 窗口平均口径：(1+10+1)/3 = 4 → 2*4=8 > 2.5 → 落空。
    const values = [2.5, 0.1, 2.5];
    const sigmaByPoint = [1, 10, 1];
    const c = ctx(values, 0, sigmaByPoint);

    const atPoint = evaluateN5(c);
    // 期望（按架构 §9.4 逐点口径）：命中
    expect(atPoint.length).toBeGreaterThanOrEqual(1);
  });

  it('N5：逐点口径命中（同侧两点各按自身 σ_i ≥2σ），窗口平均口径落空', () => {
    // CL=0，3 点窗口。第 0、2 点同在上方，距离分别 3、3；二者 σ_i=1（≥2σ 成立）。
    // 中间第 1 点 σ_i=100，把窗口平均 σ 拉高到 (1+100+1)/3=34 → 平均口径阈值 68 → 落空。
    // 逐点口径：第 0、2 点 |3|>=2*1 ✓✓ → 同侧 2 点在 A 区 → 命中。
    const values = [3, 0.1, 3];
    const sigmaByPoint = [1, 100, 1];
    const c = ctx(values, 0, sigmaByPoint);
    const atPoint = evaluateN5(c);
    expect(atPoint.length).toBeGreaterThanOrEqual(1);
  });

  it('N6：5 点中 4 点同侧 ≥1σ_i，逐点口径应命中', () => {
    // CL=0，5 点窗口。前 4 点在上方距离约 1.2（σ_i=1 → ≥1σ），第 5 点 σ 很大。
    const values = [1.2, 1.3, 1.1, 1.4, 0.05];
    const sigmaByPoint = [1, 1, 1, 1, 50];
    const c = ctx(values, 0, sigmaByPoint);
    const r = evaluateN6(c);
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it('N7：15 点全部 <1σ_i，逐点口径应命中', () => {
    const values = new Array(15).fill(0).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    // 若某点 σ_i 很小（=1）则 0.5<1 ✓；若用平均 σ=1 同样命中。
    const sigmaByPoint = new Array(15).fill(1);
    const r = evaluateN7(ctx(values, 0, sigmaByPoint));
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it('N7：混入一个大 σ 点，逐点口径下仍要求所有点 < sigma_i（构造不命中）', () => {
    const values = new Array(15).fill(0).map((_, i) => (i % 2 === 0 ? 0.5 : -0.5));
    // 第 7 点 σ_i=0.1 → 0.5 < 0.1? 否 → 逐点口径应落空；
    // 而平均 σ=(14*1+0.1)/15≈0.94 → 0.5<0.94 ✓ → 平均口径命中。二者发散。
    const sigmaByPoint = new Array(15).fill(1);
    sigmaByPoint[7] = 0.1;
    const r = evaluateN7(ctx(values, 0, sigmaByPoint));
    // 按架构逐点口径：应落空（不命中）
    expect(r.length).toBe(0);
  });

  it('N8：8 点全部 ≥1σ_i，逐点口径应命中', () => {
    const values = new Array(8).fill(0).map((_, i) => (i % 2 === 0 ? 1.5 : -1.5));
    const sigmaByPoint = new Array(8).fill(1);
    const r = evaluateN8(ctx(values, 0, sigmaByPoint));
    expect(r.length).toBeGreaterThanOrEqual(1);
  });

  it('变限 P 图 fixture：逐点 σ 与窗口平均 σ 给出相反结论（可判别）', () => {
    // 直接对比：同一 values/sigmaByPoint，逐点实现 vs 平均实现。
    // 第 0、2 点同侧上方距离 3，σ_i=1；中间点 σ_i=100 抬高平均 σ。
    const values = [3, 0.1, 3];
    const sigmaByPoint = [1, 100, 1];
    // 逐点口径（架构要求）：第 0、2 点 |3-0|=3 >= 2*1 → 同侧两点 A 区 → 命中。
    const perPointHit = (() => {
      const cl = 0;
      let above = 0;
      for (let i = 0; i < values.length; i += 1) {
        if (values[i] > cl && Math.abs(values[i] - cl) >= 2 * sigmaByPoint[i]) above += 1;
      }
      return above >= 2;
    })();
    // 窗口平均口径（当前源码实现）：
    const avg = (sigmaByPoint[0] + sigmaByPoint[1] + sigmaByPoint[2]) / 3;
    const avgHit = (() => {
      const cl = 0;
      let above = 0;
      for (const v of values) {
        if (v > cl && Math.abs(v - cl) >= 2 * avg) above += 1;
      }
      return above >= 2;
    })();

    // 两口径结论相反 → 可判别。源码实际返回应与 avgHit 一致。
    expect(perPointHit).toBe(true);
    expect(avgHit).toBe(false);

    const actual = evaluateN5(ctx(values, 0, sigmaByPoint)).length > 0;
    // 记录源码实际口径：true=逐点（正确），false=平均（与 §9.4 不符）
    expect(actual).toBe(perPointHit);
  });
});
