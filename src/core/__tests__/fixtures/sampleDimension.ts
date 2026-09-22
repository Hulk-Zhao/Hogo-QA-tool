/**
 * 基准数据 fixture（dimension sheet）——**真实数据**。
 *
 * 数据来源：旧版 Python 工具的 quality_data.xlsx（现随仓库提供：`src/data/__tests__/fixtures/quality_data.xlsx`） 的 `dimension` 工作表，
 * 3 个物料各 50 条测量值（共 150 条），保持原始行顺序；均值与样本标准差（ddof=1）
 * 均为对真实数据的实测值。
 *
 * 实测值（与 docs/01-基准数据与验证口径.md 一致，误差仅为该文档的显示精度）：
 *   - 外壳长度：n=50, LSL=49.800, USL=50.200, mean=50.002738, sd=0.02304713, Ppk=2.853023（文档 2.8530）
 *   - 转轴直径：n=50, LSL=11.980, USL=12.020, mean=11.998748, sd=0.00498943, Ppk=1.252515（文档 1.2525）
 *   - 安装孔径：n=50, LSL=7.900, USL=8.100, mean=7.999076, sd=0.01806673, Ppk=1.827964（文档 1.8280）
 *
 * 用途：断言新版内核的 `Ppk` 与基准文档 Cpk 吻合（**未剔除异常值**前提）。
 * 该文档的 Cpk 为**整体标准差**口径（旧工具 Pp==Cpk）。Cp/Cpk 因新版的 σ_within
 * 口径不同而与之不同，属预期差异。
 */

import type { SpecLimits } from '../../../core/types';

export interface BenchmarkCharacteristic {
  name: string;
  spec: SpecLimits;
  /** 实测均值（真实数据） */
  benchmarkMean: number;
  /** 实测样本标准差 ddof=1（真实数据，8 位小数） */
  benchmarkSd: number;
  /** 基准文档给出的 Cpk（整体口径，用于 Ppk 回归断言） */
  benchmarkPpk: number;
  values: number[];
}

/** 外壳长度（真实 50 条，原始顺序）。 */
const SHELL_LENGTH_VALUES: number[] = [
  50.0091, 49.9688, 50.0225, 50.0282, 49.9415, 49.9609, 50.0038, 49.9905, 49.9995, 49.9744,
  50.0264, 50.0233, 50.002, 50.0338, 50.014, 49.9742, 50.0111, 49.9712, 50.0264, 49.9985,
  49.9945, 49.9796, 50.0367, 49.9954, 49.9872, 49.9894, 50.016, 50.011, 50.0124, 50.0129,
  50.0642, 49.9878, 49.9846, 49.9756, 50.0185, 50.0339, 49.9966, 49.9748, 49.9753, 50.0195,
  50.0223, 50.0163, 49.98, 50.007, 50.0035, 50.0066, 50.0261, 50.0067, 50.0204, 50.002,
];

/** 转轴直径（真实 50 条，原始顺序）。 */
const SHAFT_DIAMETER_VALUES: number[] = [
  12.0019, 12.0041, 11.9905, 11.9979, 11.9969, 11.9958, 11.9982, 12.0097, 11.9944, 12.0063,
  11.9891, 11.9978, 12.0011, 12.0038, 12.0046, 12.0052, 11.9977, 11.997, 12.0056, 11.9988,
  11.9917, 11.9926, 11.994, 12.0032, 12.0009, 12.0045, 11.9972, 12.001, 12.0041, 11.998,
  12.003, 11.9957, 11.9976, 11.9975, 11.9922, 12.0032, 11.9969, 12.0001, 12.0031, 12.0029,
  12.0043, 11.9994, 11.9972, 11.9995, 11.989, 11.9906, 11.9914, 11.9935, 12.0026, 11.9941,
];

/** 安装孔径（真实 50 条，原始顺序）。 */
const MOUNT_HOLE_VALUES: number[] = [
  7.9932, 8.0234, 7.9936, 8.0133, 7.9832, 7.9963, 7.9829, 7.9939, 8.0151, 7.9689, 8.0078,
  8.0043, 7.9893, 7.974, 8.0013, 7.9905, 8.0042, 8.0004, 8.0288, 7.9957, 7.9816, 8.0032,
  8.004, 8.0245, 8.015, 8.0064, 8.0263, 7.9786, 7.9885, 7.9833, 7.993, 7.9752, 8.0114, 7.996,
  7.9735, 7.9817, 8.0056, 8.0151, 8.0359, 8.0524, 8.0075, 7.9822, 7.9616, 8.0048, 7.9854,
  7.9925, 7.989, 7.9975, 8.0192, 8.0028,
];

/** 基准特性列表。 */
export const BENCHMARK_CHARACTERISTICS: BenchmarkCharacteristic[] = [
  {
    name: '外壳长度',
    spec: { usl: 50.2, lsl: 49.8, target: 50.0, unit: 'mm' },
    benchmarkMean: 50.002738,
    benchmarkSd: 0.02304713,
    benchmarkPpk: 2.853,
    values: SHELL_LENGTH_VALUES,
  },
  {
    name: '转轴直径',
    spec: { usl: 12.02, lsl: 11.98, target: 12.0, unit: 'mm' },
    benchmarkMean: 11.998748,
    benchmarkSd: 0.00498943,
    benchmarkPpk: 1.2525,
    values: SHAFT_DIAMETER_VALUES,
  },
  {
    name: '安装孔径',
    spec: { usl: 8.1, lsl: 7.9, target: 8.0, unit: 'mm' },
    benchmarkMean: 7.999076,
    benchmarkSd: 0.01806673,
    benchmarkPpk: 1.828,
    values: MOUNT_HOLE_VALUES,
  },
];

/** 便捷导出：按名称取特性。 */
export function getBenchmarkCharacteristic(name: string): BenchmarkCharacteristic {
  const found = BENCHMARK_CHARACTERISTICS.find((c) => c.name === name);
  if (!found) {
    throw new Error(`未找到基准特性：${name}`);
  }
  return found;
}
