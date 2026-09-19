/**
 * Xbar-R 控制图控制限计算。
 *
 * 出处：AIAG SPC 手册第 4 版 §III（Variables Charts for Subgroups）。
 */

import type { ControlChartSeries, ControlLine, ChartPoint, SubgroupStats } from '../types';
import { getConstants } from '../constants/controlChartConstants';
import { maxOf } from '../math/matrix';

/**
 * 计算 Xbar 中心线。
 *
 * 等容量时 X̄ = 各子组均值的算术平均；不等容量时按容量加权。
 * 出处：AIAG SPC 手册 §III；等容量下二者一致。
 */
export function xbarCenter(subgroups: SubgroupStats[]): number {
  if (subgroups.length === 0) {
    throw new RangeError('xbarCenter 要求至少一个子组。');
  }
  const sizes = new Set(subgroups.map((g) => g.size));
  if (sizes.size === 1) {
    const m = subgroups.reduce((acc, g) => acc + g.mean, 0) / subgroups.length;
    return m;
  }
  const totalN = subgroups.reduce((acc, g) => acc + g.size, 0);
  return subgroups.reduce((acc, g) => acc + g.mean * g.size, 0) / totalN;
}

/**
 * 构造 Xbar-R 控制图。
 *
 * Xbar 图：CL=X̄，UCL/LCL = X̄ ± A2·R̄
 * R 图：CL=R̄，UCL=D4·R̄，LCL=D3·R̄（D3 无定义时 LCL 为 null 表示不画）
 *
 * @throws {RangeError} 子组容量越界
 */
export function buildXbarR(subgroups: SubgroupStats[]): ControlChartSeries {
  const usable = subgroups.filter((g) => g.size >= 2);
  if (usable.length === 0) {
    throw new RangeError('Xbar-R 要求至少一个容量 >= 2 的子组。');
  }
  const maxN = maxOf(usable.map((g) => g.size));
  const constants = getConstants(maxN);
  const rBar = usable.reduce((acc, g) => acc + g.range, 0) / usable.length;
  const xBar = xbarCenter(usable);

  const primaryPoints: ChartPoint[] = usable.map((g, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: g.mean,
    subgroupId: g.id,
    subgroupSize: g.size,
  }));
  const secondaryPoints: ChartPoint[] = usable.map((g, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: g.range,
    subgroupId: g.id,
    subgroupSize: g.size,
  }));

  const xbarUcl = xBar + constants.A2 * rBar;
  const xbarLcl = xBar - constants.A2 * rBar;

  const primaryLimits: ControlLine[] = [
    constLine('CL', xBar, usable.length),
    constLine('UCL', xbarUcl, usable.length),
    constLine('LCL', xbarLcl, usable.length),
  ];

  const rUcl = constants.D4 * rBar;
  const rLcl = constants.D3 !== null ? constants.D3 * rBar : null;
  const secondaryLimits: ControlLine[] = [
    constLine('CL', rBar, usable.length),
    constLine('UCL', rUcl, usable.length),
  ];
  if (rLcl !== null) {
    secondaryLimits.push(constLine('LCL', rLcl, usable.length));
  }

  return {
    primary: { name: 'X̄', points: primaryPoints },
    secondary: { name: 'R', points: secondaryPoints },
    limits: { primary: primaryLimits, secondary: secondaryLimits },
    sigmaZones: { centerLine: xBar, oneSigma: rBar / constants.d2 },
    constantsUsed: { ...constants },
    selectedType: 'Xbar-R',
  };
}

/** 构造恒定控制限序列。 */
export function constLine(label: string, value: number, length: number): ControlLine {
  return { label, values: new Array<number>(length).fill(value), isConstant: true };
}
