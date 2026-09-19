/**
 * Xbar-S 控制图控制限计算。
 *
 * 出处：AIAG SPC 手册第 4 版 §III。
 */

import type { ControlChartSeries, ControlLine, ChartPoint, SubgroupStats } from '../types';
import { getConstants } from '../constants/controlChartConstants';
import { maxOf } from '../math/matrix';
import { constLine, xbarCenter } from './xbarR';

/**
 * 构造 Xbar-S 控制图。
 *
 * Xbar 图：CL=X̄，UCL/LCL = X̄ ± A3·S̄
 * S 图：CL=S̄，UCL=B4·S̄，LCL=B3·S̄（B3 无定义时 LCL 为 null 表示不画）
 *
 * @throws {RangeError} 子组容量越界
 */
export function buildXbarS(subgroups: SubgroupStats[]): ControlChartSeries {
  const usable = subgroups.filter((g) => g.size >= 2);
  if (usable.length === 0) {
    throw new RangeError('Xbar-S 要求至少一个容量 >= 2 的子组。');
  }
  const maxN = maxOf(usable.map((g) => g.size));
  const constants = getConstants(maxN);
  const sBar = usable.reduce((acc, g) => acc + g.std, 0) / usable.length;
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
    value: g.std,
    subgroupId: g.id,
    subgroupSize: g.size,
  }));

  const xbarUcl = xBar + constants.A3 * sBar;
  const xbarLcl = xBar - constants.A3 * sBar;

  const primaryLimits: ControlLine[] = [
    constLine('CL', xBar, usable.length),
    constLine('UCL', xbarUcl, usable.length),
    constLine('LCL', xbarLcl, usable.length),
  ];

  const sUcl = constants.B4 * sBar;
  const sLcl = constants.B3 !== null ? constants.B3 * sBar : null;
  const secondaryLimits: ControlLine[] = [
    constLine('CL', sBar, usable.length),
    constLine('UCL', sUcl, usable.length),
  ];
  if (sLcl !== null) {
    secondaryLimits.push(constLine('LCL', sLcl, usable.length));
  }

  return {
    primary: { name: 'X̄', points: primaryPoints },
    secondary: { name: 'S', points: secondaryPoints },
    limits: { primary: primaryLimits, secondary: secondaryLimits },
    sigmaZones: { centerLine: xBar, oneSigma: sBar / constants.c4 },
    constantsUsed: { ...constants },
    selectedType: 'Xbar-S',
  };
}
