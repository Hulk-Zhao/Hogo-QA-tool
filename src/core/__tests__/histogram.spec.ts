/**
 * 直方图测试。
 */

import { describe, expect, it } from 'vitest';
import { buildHistogram, sturgesBinCount } from '../stats/histogram';

describe('直方图', () => {
  it('Sturges 分箱数 = ceil(log2(n)) + 1', () => {
    expect(sturgesBinCount(1)).toBe(1);
    expect(sturgesBinCount(8)).toBe(4);
    expect(sturgesBinCount(100)).toBe(8);
  });

  it('频数之和等于样本数', () => {
    const values = Array.from({ length: 100 }, (_, i) => Math.sin(i));
    const h = buildHistogram(values);
    const total = h.bins.reduce((a, b) => a + b.count, 0);
    expect(total).toBe(100);
    expect(h.binCount).toBe(sturgesBinCount(100));
    expect(h.rule).toBe('sturges');
  });

  it('最大值落在最后一箱', () => {
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const h = buildHistogram(values, 5);
    expect(h.bins[h.bins.length - 1].count).toBeGreaterThanOrEqual(1);
    expect(h.bins[0].count).toBeGreaterThanOrEqual(1);
  });

  it('全部相等数据退化为单箱', () => {
    const h = buildHistogram([5, 5, 5, 5]);
    expect(h.binCount).toBe(1);
    expect(h.bins[0].count).toBe(4);
  });

  it('显式分箱数', () => {
    const values = Array.from({ length: 20 }, (_, i) => i);
    const h = buildHistogram(values, 4);
    expect(h.binCount).toBe(4);
    expect(h.rule).toBe(4);
  });

  it('空数组抛 RangeError', () => {
    expect(() => buildHistogram([])).toThrow(RangeError);
  });

  it('非法分箱数抛 RangeError', () => {
    expect(() => buildHistogram([1, 2, 3], 0)).toThrow(RangeError);
  });
});
