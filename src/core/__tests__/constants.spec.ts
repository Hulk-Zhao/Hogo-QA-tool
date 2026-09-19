/**
 * 常数表自检（架构文档 §7 T01 验收要点 2）。
 *
 * 逐项核对 n=2..25 的 A2/A3/D3/D4/B3/B4/d2/E2/c4 与
 * AIAG SPC 手册第 4 版 Appendix E / ASTM E2587 标准值。
 * 并断言 n=1 与 n=26 抛 RangeError；D3/B3 无定义时返回 null。
 */

import { describe, expect, it } from 'vitest';
import {
  getConstants,
  getD2,
  getC4,
  hasB3,
  hasD3,
  MIN_SUBGROUP_N,
  MAX_SUBGROUP_N,
} from '../constants/controlChartConstants';

interface ExpectedRow {
  n: number;
  A2: number;
  A3: number;
  D3: number | null;
  D4: number;
  B3: number | null;
  B4: number;
  d2: number;
  E2: number;
  c4: number;
}

/**
 * AIAG SPC 手册第 4 版 Appendix E 标准常数表（n=2..25）。
 * d2 / c4 / E2 取自标准表；D3/B3 无定义以 null 表示。
 */
const AIAG_TABLE: ExpectedRow[] = [
  { n: 2, A2: 1.88, A3: 2.659, D3: null, D4: 3.267, B3: null, B4: 3.267, d2: 1.128, E2: 2.66, c4: 0.7979 },
  { n: 3, A2: 1.023, A3: 1.954, D3: null, D4: 2.574, B3: null, B4: 2.568, d2: 1.693, E2: 1.772, c4: 0.8862 },
  { n: 4, A2: 0.729, A3: 1.628, D3: null, D4: 2.282, B3: null, B4: 2.266, d2: 2.059, E2: 1.457, c4: 0.9213 },
  { n: 5, A2: 0.577, A3: 1.427, D3: null, D4: 2.114, B3: null, B4: 2.089, d2: 2.326, E2: 1.29, c4: 0.94 },
  { n: 6, A2: 0.483, A3: 1.287, D3: null, D4: 2.004, B3: 0.03, B4: 1.97, d2: 2.534, E2: 1.184, c4: 0.9515 },
  { n: 7, A2: 0.419, A3: 1.182, D3: 0.076, D4: 1.924, B3: 0.118, B4: 1.882, d2: 2.704, E2: 1.109, c4: 0.9594 },
  { n: 8, A2: 0.373, A3: 1.099, D3: 0.136, D4: 1.864, B3: 0.185, B4: 1.815, d2: 2.847, E2: 1.054, c4: 0.965 },
  { n: 9, A2: 0.337, A3: 1.032, D3: 0.184, D4: 1.816, B3: 0.239, B4: 1.761, d2: 2.97, E2: 1.01, c4: 0.9693 },
  { n: 10, A2: 0.308, A3: 0.975, D3: 0.223, D4: 1.777, B3: 0.284, B4: 1.716, d2: 3.078, E2: 0.975, c4: 0.9727 },
  { n: 11, A2: 0.285, A3: 0.927, D3: 0.256, D4: 1.744, B3: 0.321, B4: 1.679, d2: 3.173, E2: 0.945, c4: 0.9754 },
  { n: 12, A2: 0.266, A3: 0.886, D3: 0.283, D4: 1.717, B3: 0.354, B4: 1.646, d2: 3.258, E2: 0.921, c4: 0.9776 },
  { n: 13, A2: 0.249, A3: 0.85, D3: 0.307, D4: 1.693, B3: 0.382, B4: 1.618, d2: 3.336, E2: 0.899, c4: 0.9794 },
  { n: 14, A2: 0.235, A3: 0.817, D3: 0.328, D4: 1.672, B3: 0.406, B4: 1.594, d2: 3.407, E2: 0.881, c4: 0.981 },
  { n: 15, A2: 0.223, A3: 0.789, D3: 0.347, D4: 1.653, B3: 0.428, B4: 1.572, d2: 3.472, E2: 0.864, c4: 0.9823 },
  { n: 16, A2: 0.212, A3: 0.763, D3: 0.363, D4: 1.637, B3: 0.448, B4: 1.552, d2: 3.532, E2: 0.849, c4: 0.9835 },
  { n: 17, A2: 0.203, A3: 0.739, D3: 0.378, D4: 1.622, B3: 0.466, B4: 1.534, d2: 3.588, E2: 0.836, c4: 0.9845 },
  { n: 18, A2: 0.194, A3: 0.718, D3: 0.391, D4: 1.608, B3: 0.482, B4: 1.518, d2: 3.64, E2: 0.824, c4: 0.9854 },
  { n: 19, A2: 0.187, A3: 0.698, D3: 0.403, D4: 1.597, B3: 0.497, B4: 1.503, d2: 3.689, E2: 0.813, c4: 0.9862 },
  { n: 20, A2: 0.18, A3: 0.68, D3: 0.415, D4: 1.585, B3: 0.51, B4: 1.49, d2: 3.735, E2: 0.803, c4: 0.9869 },
  { n: 21, A2: 0.173, A3: 0.663, D3: 0.425, D4: 1.575, B3: 0.523, B4: 1.477, d2: 3.778, E2: 0.794, c4: 0.9876 },
  { n: 22, A2: 0.167, A3: 0.647, D3: 0.434, D4: 1.566, B3: 0.534, B4: 1.466, d2: 3.819, E2: 0.785, c4: 0.9882 },
  { n: 23, A2: 0.162, A3: 0.633, D3: 0.443, D4: 1.557, B3: 0.545, B4: 1.455, d2: 3.858, E2: 0.778, c4: 0.9887 },
  { n: 24, A2: 0.157, A3: 0.619, D3: 0.451, D4: 1.548, B3: 0.555, B4: 1.445, d2: 3.895, E2: 0.77, c4: 0.9892 },
  { n: 25, A2: 0.153, A3: 0.606, D3: 0.459, D4: 1.541, B3: 0.565, B4: 1.435, d2: 3.931, E2: 0.763, c4: 0.9896 },
];

describe('控制图常数表（AIAG SPC 手册 / ASTM E2587）', () => {
  it('范围常量为 2..25', () => {
    expect(MIN_SUBGROUP_N).toBe(2);
    expect(MAX_SUBGROUP_N).toBe(25);
  });

  it.each(AIAG_TABLE)('n=$n 全部常数逐项与 AIAG 标准表一致', (row) => {
    const c = getConstants(row.n);
    expect(c.n).toBe(row.n);
    expect(c.A2).toBe(row.A2);
    expect(c.A3).toBe(row.A3);
    expect(c.D4).toBe(row.D4);
    expect(c.B4).toBe(row.B4);
    expect(c.d2).toBe(row.d2);
    expect(c.E2).toBe(row.E2);
    expect(c.c4).toBe(row.c4);
    if (row.D3 === null) {
      expect(c.D3).toBeNull();
    } else {
      expect(c.D3).toBe(row.D3);
    }
    if (row.B3 === null) {
      expect(c.B3).toBeNull();
    } else {
      expect(c.B3).toBe(row.B3);
    }
  });

  it('getD2 / getC4 与表值一致', () => {
    expect(getD2(5)).toBe(2.326);
    expect(getC4(5)).toBe(0.94);
  });

  it('n=1 抛 RangeError（不允许外插）', () => {
    expect(() => getConstants(1)).toThrow(RangeError);
    expect(() => getD2(1)).toThrow(RangeError);
    expect(() => getC4(1)).toThrow(RangeError);
  });

  it('n=26 抛 RangeError（不允许外插）', () => {
    expect(() => getConstants(26)).toThrow(RangeError);
    expect(() => getD2(26)).toThrow(RangeError);
    expect(() => getC4(26)).toThrow(RangeError);
  });

  it('n 为非整数时抛 RangeError', () => {
    expect(() => getConstants(5.5)).toThrow(RangeError);
    expect(() => getConstants(Number.NaN)).toThrow(RangeError);
  });

  it('D3 在 n<=6 时返回 null（不得返回 0）', () => {
    for (let n = 2; n <= 6; n += 1) {
      const c = getConstants(n);
      expect(c.D3).toBeNull();
      expect(hasD3(n)).toBe(false);
    }
    for (let n = 7; n <= 25; n += 1) {
      expect(getConstants(n).D3).not.toBeNull();
      expect(hasD3(n)).toBe(true);
    }
  });

  it('B3 在 n<=5 时返回 null（不得返回 0）', () => {
    for (let n = 2; n <= 5; n += 1) {
      expect(getConstants(n).B3).toBeNull();
      expect(hasB3(n)).toBe(false);
    }
    for (let n = 6; n <= 25; n += 1) {
      expect(getConstants(n).B3).not.toBeNull();
      expect(hasB3(n)).toBe(true);
    }
  });
});
