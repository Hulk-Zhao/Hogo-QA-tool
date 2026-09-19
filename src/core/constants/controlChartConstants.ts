/**
 * 控制图常数表（AIAG SPC 手册 第 4 版 Appendix E / ASTM E2587）。
 *
 * 覆盖 n = 2..25 的 A2 / A3 / D3 / D4 / B3 / B4 / d2 / E2 / c4。
 *
 * 关键约定（架构文档 §0.2 #10）：
 * - n 超出 2..25 一律抛 `RangeError`，严禁外插、插值。
 * - `D3`（n <= 6 无定义）与 `B3`（n <= 5 无定义）**返回 null**，不用 0 冒充。
 *   返回 0 会导致下控制限被画成「0 线」，是常见错误。
 */

import type { ControlChartConstants } from '../types';

/** 常数表允许的子组容量下界（含）。 */
export const MIN_SUBGROUP_N = 2;

/** 常数表允许的子组容量上界（含）。 */
export const MAX_SUBGROUP_N = 25;

/**
 * 各 n 对应的常数原始数据表。
 *
 * 数值来源：AIAG《Statistical Process Control》第 4 版 Appendix E
 * （Variables Control Chart Constants），与 ASTM E2587-16 一致。
 * d2 与 c4 取无偏估计常数；E2 = 3 / d2。
 *
 * `D3` / `B3` 无定义时以 `null` 表示（不使用 0）。
 */
interface RawConstants {
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
 * 常数表（n = 2..25）。
 *
 * d2 / c4 / E2 采用 AIAG 标准表值（E2 = 3/d2 已逐项核对）。
 * D3 = max(0, 1 - 3*d3/d2)，B3 = max(0, 1 - 3*c4'/c4)；无定义时按 AIAG
 * 约定置 null（D3: n<=6；B3: n<=5）。
 */
const CONSTANTS_TABLE: Record<number, RawConstants> = {
  2: { A2: 1.880, A3: 2.659, D3: null, D4: 3.267, B3: null, B4: 3.267, d2: 1.128, E2: 2.660, c4: 0.7979 },
  3: { A2: 1.023, A3: 1.954, D3: null, D4: 2.574, B3: null, B4: 2.568, d2: 1.693, E2: 1.772, c4: 0.8862 },
  4: { A2: 0.729, A3: 1.628, D3: null, D4: 2.282, B3: null, B4: 2.266, d2: 2.059, E2: 1.457, c4: 0.9213 },
  5: { A2: 0.577, A3: 1.427, D3: null, D4: 2.114, B3: null, B4: 2.089, d2: 2.326, E2: 1.290, c4: 0.9400 },
  6: { A2: 0.483, A3: 1.287, D3: null, D4: 2.004, B3: 0.030, B4: 1.970, d2: 2.534, E2: 1.184, c4: 0.9515 },
  7: { A2: 0.419, A3: 1.182, D3: 0.076, D4: 1.924, B3: 0.118, B4: 1.882, d2: 2.704, E2: 1.109, c4: 0.9594 },
  8: { A2: 0.373, A3: 1.099, D3: 0.136, D4: 1.864, B3: 0.185, B4: 1.815, d2: 2.847, E2: 1.054, c4: 0.9650 },
  9: { A2: 0.337, A3: 1.032, D3: 0.184, D4: 1.816, B3: 0.239, B4: 1.761, d2: 2.970, E2: 1.010, c4: 0.9693 },
  10: { A2: 0.308, A3: 0.975, D3: 0.223, D4: 1.777, B3: 0.284, B4: 1.716, d2: 3.078, E2: 0.975, c4: 0.9727 },
  11: { A2: 0.285, A3: 0.927, D3: 0.256, D4: 1.744, B3: 0.321, B4: 1.679, d2: 3.173, E2: 0.945, c4: 0.9754 },
  12: { A2: 0.266, A3: 0.886, D3: 0.283, D4: 1.717, B3: 0.354, B4: 1.646, d2: 3.258, E2: 0.921, c4: 0.9776 },
  13: { A2: 0.249, A3: 0.850, D3: 0.307, D4: 1.693, B3: 0.382, B4: 1.618, d2: 3.336, E2: 0.899, c4: 0.9794 },
  14: { A2: 0.235, A3: 0.817, D3: 0.328, D4: 1.672, B3: 0.406, B4: 1.594, d2: 3.407, E2: 0.881, c4: 0.9810 },
  15: { A2: 0.223, A3: 0.789, D3: 0.347, D4: 1.653, B3: 0.428, B4: 1.572, d2: 3.472, E2: 0.864, c4: 0.9823 },
  16: { A2: 0.212, A3: 0.763, D3: 0.363, D4: 1.637, B3: 0.448, B4: 1.552, d2: 3.532, E2: 0.849, c4: 0.9835 },
  17: { A2: 0.203, A3: 0.739, D3: 0.378, D4: 1.622, B3: 0.466, B4: 1.534, d2: 3.588, E2: 0.836, c4: 0.9845 },
  18: { A2: 0.194, A3: 0.718, D3: 0.391, D4: 1.608, B3: 0.482, B4: 1.518, d2: 3.640, E2: 0.824, c4: 0.9854 },
  19: { A2: 0.187, A3: 0.698, D3: 0.403, D4: 1.597, B3: 0.497, B4: 1.503, d2: 3.689, E2: 0.813, c4: 0.9862 },
  20: { A2: 0.180, A3: 0.680, D3: 0.415, D4: 1.585, B3: 0.510, B4: 1.490, d2: 3.735, E2: 0.803, c4: 0.9869 },
  21: { A2: 0.173, A3: 0.663, D3: 0.425, D4: 1.575, B3: 0.523, B4: 1.477, d2: 3.778, E2: 0.794, c4: 0.9876 },
  22: { A2: 0.167, A3: 0.647, D3: 0.434, D4: 1.566, B3: 0.534, B4: 1.466, d2: 3.819, E2: 0.785, c4: 0.9882 },
  23: { A2: 0.162, A3: 0.633, D3: 0.443, D4: 1.557, B3: 0.545, B4: 1.455, d2: 3.858, E2: 0.778, c4: 0.9887 },
  24: { A2: 0.157, A3: 0.619, D3: 0.451, D4: 1.548, B3: 0.555, B4: 1.445, d2: 3.895, E2: 0.770, c4: 0.9892 },
  25: { A2: 0.153, A3: 0.606, D3: 0.459, D4: 1.541, B3: 0.565, B4: 1.435, d2: 3.931, E2: 0.763, c4: 0.9896 },
};

/**
 * 校验子组容量 n 是否在常数表范围内。
 *
 * @param n 子组容量
 * @throws {RangeError} n 非整数或超出 2..25
 */
function assertValidN(n: number): void {
  if (!Number.isInteger(n)) {
    throw new RangeError(`子组容量 n 必须为整数，收到 ${n}。`);
  }
  if (n < MIN_SUBGROUP_N || n > MAX_SUBGROUP_N) {
    throw new RangeError(
      `子组容量 n=${n} 超出常数表范围 [${MIN_SUBGROUP_N}, ${MAX_SUBGROUP_N}]，不允许外插。`,
    );
  }
}

/**
 * 按子组容量 n 查表取得控制图常数。
 *
 * 出处：AIAG SPC 手册第 4 版 Appendix E / ASTM E2587。
 *
 * @param n 子组容量，必须为 2..25 的整数
 * @returns 该 n 对应的全部常数；`D3`/`B3` 无定义时为 null
 * @throws {RangeError} n 非整数或超出 2..25
 */
export function getConstants(n: number): ControlChartConstants {
  assertValidN(n);
  const raw = CONSTANTS_TABLE[n];
  return {
    n,
    A2: raw.A2,
    A3: raw.A3,
    D3: raw.D3,
    D4: raw.D4,
    B3: raw.B3,
    B4: raw.B4,
    d2: raw.d2,
    E2: raw.E2,
    c4: raw.c4,
  };
}

/**
 * 安全地查 d2（供组内 σ 估计使用；n 越界抛 RangeError）。
 *
 * 出处：AIAG SPC 手册 Appendix E（d2 无偏极差常数）。
 */
export function getD2(n: number): number {
  return getConstants(n).d2;
}

/**
 * 安全地查 c4（供组内 σ 估计使用；n 越界抛 RangeError）。
 *
 * 出处：AIAG SPC 手册 Appendix E（c4 无偏标准差常数）。
 */
export function getC4(n: number): number {
  return getConstants(n).c4;
}

/**
 * 判断某 n 的 D3 是否有定义（n >= 7 时有定义）。
 */
export function hasD3(n: number): boolean {
  return getConstants(n).D3 !== null;
}

/**
 * 判断某 n 的 B3 是否有定义（n >= 6 时有定义）。
 */
export function hasB3(n: number): boolean {
  return getConstants(n).B3 !== null;
}

/** 导出原始常数表（只读），供常数表自检用例与设置页展示。 */
export function getAllConstantsRaw(): Readonly<Record<number, RawConstants>> {
  return CONSTANTS_TABLE;
}
