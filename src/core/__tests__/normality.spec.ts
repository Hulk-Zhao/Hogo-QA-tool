/**
 * 正态性检验测试（架构文档 §7 T01 验收要点 5、§10.1 / §10.2）。
 *
 * 覆盖 n<8、n<=50、n>50、标准差为 0 的退化情况。
 */

import { describe, expect, it } from 'vitest';
import { andersonDarling } from '../normality/andersonDarling';
import { shapiroWilk } from '../normality/shapiroWilk';
import { testNormality } from '../normality/index';

/** 构造近似标准正态的确定性数据（正弦叠加，低偏度）。 */
function approxNormal(n: number): number[] {
  // 使用对称的三分量正弦，令分布接近对称钟形。
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const t = (i + 0.5) / n;
    const v = Math.sin(2 * Math.PI * t) + 0.5 * Math.sin(4 * Math.PI * t) + 0.25 * Math.sin(6 * Math.PI * t);
    out.push(v);
  }
  return out;
}

/** 构造强偏态数据（指数分布形态）。 */
function stronglySkewed(n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const u = (i + 0.5) / n;
    out.push(-Math.log(1 - u));
  }
  return out;
}

describe('Anderson-Darling', () => {
  it('近似正态数据：p >= 0.05（不拒绝）', () => {
    const r = andersonDarling(approxNormal(100));
    expect(r.method).toBe('AD');
    expect(Number.isFinite(r.statistic)).toBe(true);
    expect(r.pValue).toBeGreaterThanOrEqual(0.05);
    expect(r.isNormal).toBe(true);
  });

  it('强偏态数据：p < 0.05（拒绝）', () => {
    const r = andersonDarling(stronglySkewed(100));
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.isNormal).toBe(false);
  });

  it('n<8：给出 note 提示样本量过小', () => {
    const r = andersonDarling([1, 2, 3, 4, 5]);
    expect(r.note).toBeDefined();
    expect(r.note).toContain('样本量过小');
  });

  it('标准差为 0：statistic=Infinity, pValue=0, isNormal=false', () => {
    const r = andersonDarling([5, 5, 5, 5, 5]);
    expect(r.statistic).toBe(Number.POSITIVE_INFINITY);
    expect(r.pValue).toBe(0);
    expect(r.isNormal).toBe(false);
  });

  it('n<2：无法执行', () => {
    const r = andersonDarling([1]);
    expect(Number.isNaN(r.statistic)).toBe(true);
    expect(r.note).toContain('样本量过小');
  });
});

describe('Shapiro-Wilk', () => {
  it('近似正态数据：p >= 0.05', () => {
    const r = shapiroWilk(approxNormal(50));
    expect(r.method).toBe('SW');
    expect(r.statistic).toBeGreaterThan(0);
    expect(r.statistic).toBeLessThanOrEqual(1);
    expect(r.pValue).toBeGreaterThanOrEqual(0.05);
  });

  it('强偏态数据：p < 0.05', () => {
    const r = shapiroWilk(stronglySkewed(50));
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.isNormal).toBe(false);
  });

  it('中样本 n=100 正常工作', () => {
    const r = shapiroWilk(approxNormal(100));
    expect(Number.isFinite(r.statistic)).toBe(true);
    expect(r.pValue).toBeGreaterThanOrEqual(0);
    expect(r.pValue).toBeLessThanOrEqual(1);
  });

  it('n<3：无法执行，给出 note', () => {
    const r = shapiroWilk([1, 2]);
    expect(Number.isNaN(r.statistic)).toBe(true);
    expect(r.note).toContain('样本量不足');
  });

  it('标准差为 0：W=1, p=1（退化视为正态）', () => {
    const r = shapiroWilk([3, 3, 3, 3]);
    expect(r.statistic).toBe(1);
    expect(r.pValue).toBe(1);
    expect(r.isNormal).toBe(true);
    expect(r.note).toBeDefined();
  });

  it('n>5000：给出 note 建议改看 AD', () => {
    const big = Array.from({ length: 5001 }, (_, i) => (i % 7) - 3);
    const r = shapiroWilk(big);
    expect(r.note).toContain('过大');
  });
});

describe('testNormality 统一入口', () => {
  it('n<=50 时 primary 为 S-W', () => {
    const bundle = testNormality(approxNormal(40));
    expect(bundle.primary.method).toBe('SW');
    expect(bundle.sw).not.toBeNull();
    expect(bundle.ad.method).toBe('AD');
  });

  it('n>50 时 primary 为 AD', () => {
    const bundle = testNormality(approxNormal(80));
    expect(bundle.primary.method).toBe('AD');
  });

  it('n>5000 时 sw 为 null', () => {
    const big = Array.from({ length: 5001 }, (_, i) => (i % 7) - 3);
    const bundle = testNormality(big);
    expect(bundle.sw).toBeNull();
    expect(bundle.primary.method).toBe('AD');
  });
});
