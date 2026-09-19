/**
 * 数学辅助与描述性统计测试。
 */

import { describe, expect, it } from 'vitest';
import {
  normalCdf,
  normalPdf,
  normalInvCdf,
  tQuantile,
} from '../math/normalCdf';
import { mean, stdDev, median, skewness, kurtosis, rangeOf } from '../stats/descriptive';
import {
  isMissingSpec,
  isOneSidedSpec,
  isTwoSidedSpec,
  specCenter,
  specHalfWidth,
} from '../stats/specLimits';
import type { SpecLimits } from '../types';

describe('正态分布函数', () => {
  it('Φ(0)=0.5', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 8);
  });

  it('Φ(1.96)≈0.975', () => {
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
  });

  it('Φ(-1.96)≈0.025', () => {
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 3);
  });

  it('Φ 单调递增', () => {
    let prev = 0;
    for (let z = -4; z <= 4; z += 0.5) {
      const c = normalCdf(z);
      expect(c).toBeGreaterThanOrEqual(prev);
      prev = c;
    }
  });

  it('φ(0)=1/√(2π)', () => {
    expect(normalPdf(0)).toBeCloseTo(1 / Math.sqrt(2 * Math.PI), 8);
  });

  it('Φ^{-1} 与 Φ 互逆', () => {
    for (const p of [0.025, 0.1, 0.5, 0.9, 0.975]) {
      const z = normalInvCdf(p);
      expect(normalCdf(z)).toBeCloseTo(p, 4);
    }
  });

  it('Φ^{-1}(0.975)≈1.96', () => {
    expect(normalInvCdf(0.975)).toBeCloseTo(1.96, 2);
  });

  it('Φ^{-1} 越界抛 RangeError', () => {
    expect(() => normalInvCdf(0)).toThrow(RangeError);
    expect(() => normalInvCdf(1)).toThrow(RangeError);
  });

  it('t 分位数 df 非法抛 RangeError', () => {
    expect(() => tQuantile(0.05, 0)).toThrow(RangeError);
  });

  it('t 分位数近似：df 越大越接近正态', () => {
    const t5 = tQuantile(0.025, 5);
    const t100 = tQuantile(0.025, 100);
    const z = normalInvCdf(0.025);
    expect(Math.abs(t100 - z)).toBeLessThan(Math.abs(t5 - z));
  });
});

describe('描述性统计', () => {
  it('mean', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it('stdDev ddof=1 与 ddof=0', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    // 总体标准差 ddof=0 = 2
    expect(stdDev(xs, 0)).toBeCloseTo(2, 10);
    // 样本标准差 ddof=1
    expect(stdDev(xs, 1)).toBeCloseTo(Math.sqrt(32 / 7), 10);
  });

  it('median 奇偶', () => {
    expect(median([1, 3, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it('rangeOf', () => {
    expect(rangeOf([1, 5, 3])).toBe(4);
  });

  it('symmetric 数据偏度约 0', () => {
    expect(Math.abs(skewness([1, 2, 3, 4, 5]))).toBeLessThan(1e-9);
  });

  it('对称数据超额峰度约 -1.3（均匀近似）', () => {
    const k = kurtosis([1, 2, 3, 4, 5]);
    expect(k).toBeLessThan(0);
  });

  it('空数组抛 RangeError', () => {
    expect(() => mean([])).toThrow(RangeError);
    expect(() => median([])).toThrow(RangeError);
  });

  it('stdDev n<=ddof 抛 RangeError', () => {
    expect(() => stdDev([1], 1)).toThrow(RangeError);
  });
});

describe('规格限判定', () => {
  it('双侧规格', () => {
    const s: SpecLimits = { usl: 10, lsl: 8, target: 9, unit: 'mm' };
    expect(isTwoSidedSpec(s)).toBe(true);
    expect(isOneSidedSpec(s)).toBe(false);
    expect(isMissingSpec(s)).toBe(false);
    expect(specCenter(s)).toBe(9);
    expect(specHalfWidth(s)).toBe(1);
  });

  it('单侧规格', () => {
    const s: SpecLimits = { usl: 10, lsl: null, target: null, unit: 'mm' };
    expect(isTwoSidedSpec(s)).toBe(false);
    expect(isOneSidedSpec(s)).toBe(true);
    expect(specCenter(s)).toBeNull();
    expect(specHalfWidth(s)).toBeNull();
  });

  it('缺失规格', () => {
    const s: SpecLimits = { usl: null, lsl: null, target: null, unit: 'mm' };
    expect(isMissingSpec(s)).toBe(true);
    expect(isOneSidedSpec(s)).toBe(false);
  });
});
