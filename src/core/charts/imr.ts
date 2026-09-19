/**
 * I-MR（单值 - 移动极差）控制图控制限计算。
 *
 * 出处：AIAG SPC 手册第 4 版 §III（Individuals and Moving Range Chart）。
 * MR_i = |x_i - x_{i-1}|（i>=1），共 m-1 个；E2(2)=2.66；D3(2) 无定义 → LCL 不画。
 */

import type { ControlChartSeries, ControlLine, ChartPoint } from '../types';
import { getConstants } from '../constants/controlChartConstants';
import { constLine } from './xbarR';
import { mean as meanOf } from '../stats/descriptive';

/**
 * 计算移动极差序列 MR_i = |x_i - x_{i-1}|。
 *
 * @throws {RangeError} 数值数组长度 < 2
 */
export function movingRanges(values: number[]): number[] {
  if (values.length < 2) {
    throw new RangeError(`I-MR 要求至少 2 个单值，收到 ${values.length}。`);
  }
  const mr: number[] = [];
  for (let i = 1; i < values.length; i += 1) {
    mr.push(Math.abs(values[i] - values[i - 1]));
  }
  return mr;
}

/**
 * 构造 I-MR 控制图。
 *
 * I 图：CL=X̄，UCL/LCL = X̄ ± E2(2)·MR̄
 * MR 图：CL=MR̄，UCL=D4(2)·MR̄；LCL=D3(2)·MR̄（D3(2) 无定义 → 不画）
 *
 * @throws {RangeError} 单值数量 < 2
 */
export function buildImr(values: number[]): ControlChartSeries {
  if (values.length < 2) {
    throw new RangeError(`I-MR 要求至少 2 个单值，收到 ${values.length}。`);
  }
  const constants = getConstants(2);
  const xBar = meanOf(values);
  const mr = movingRanges(values);
  const mrBar = mr.reduce((acc, v) => acc + v, 0) / mr.length;

  const primaryPoints: ChartPoint[] = values.map((v, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: v,
    subgroupSize: 1,
  }));
  // MR 图点数 = values.length - 1，index 与 I 图第 2 点起对齐，xLabel 从 #2 开始。
  const secondaryPoints: ChartPoint[] = mr.map((v, i) => ({
    index: i + 1,
    xLabel: `#${i + 2}`,
    value: v,
    subgroupSize: 2,
  }));

  const iUcl = xBar + constants.E2 * mrBar;
  const iLcl = xBar - constants.E2 * mrBar;

  const primaryLimits: ControlLine[] = [
    constLine('CL', xBar, values.length),
    constLine('UCL', iUcl, values.length),
    constLine('LCL', iLcl, values.length),
  ];

  const mrUcl = constants.D4 * mrBar;
  const secondaryLimits: ControlLine[] = [
    constLine('CL', mrBar, mr.length),
    constLine('UCL', mrUcl, mr.length),
  ];
  if (constants.D3 !== null) {
    secondaryLimits.push(constLine('LCL', constants.D3 * mrBar, mr.length));
  }

  return {
    primary: { name: 'I', points: primaryPoints },
    secondary: { name: 'MR', points: secondaryPoints },
    limits: { primary: primaryLimits, secondary: secondaryLimits },
    sigmaZones: { centerLine: xBar, oneSigma: mrBar / constants.d2 },
    constantsUsed: { ...constants },
    selectedType: 'I-MR',
  };
}
