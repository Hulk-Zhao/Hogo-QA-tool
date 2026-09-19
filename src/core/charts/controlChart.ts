/**
 * 控制图工厂：按 ChartType 分发到具体实现。
 *
 * 出处：PRD §4.3、AIAG SPC 手册第 4 版。
 */

import type { AttributeInput, ChartType, ControlChartSeries, SubgroupStats } from '../types';
import { buildXbarR } from './xbarR';
import { buildXbarS } from './xbarS';
import { buildImr } from './imr';
import { buildC, buildNp, buildP, buildU } from './attributes';

/** 计量型输入。 */
export interface VariablesChartInput {
  kind: 'variables';
  subgroups: SubgroupStats[];
}

/** I-MR 输入。 */
export interface ImrChartInput {
  kind: 'imr';
  values: number[];
}

/** 计数型输入。 */
export interface AttributesChartInput {
  kind: 'attributes';
  data: AttributeInput;
}

export type ControlChartInput = VariablesChartInput | ImrChartInput | AttributesChartInput;

/**
 * 构造控制图序列。
 *
 * @param type 控制图类型
 * @param inputs 输入（计量 / I-MR / 计数）
 * @throws {TypeError} 类型与输入不匹配
 */
export function buildControlChart(
  type: ChartType,
  inputs: ControlChartInput,
): ControlChartSeries {
  switch (type) {
    case 'Xbar-R': {
      if (inputs.kind !== 'variables') {
        throw new TypeError('Xbar-R 需要 variables 输入。');
      }
      return buildXbarR(inputs.subgroups);
    }
    case 'Xbar-S': {
      if (inputs.kind !== 'variables') {
        throw new TypeError('Xbar-S 需要 variables 输入。');
      }
      return buildXbarS(inputs.subgroups);
    }
    case 'I-MR': {
      if (inputs.kind !== 'imr') {
        throw new TypeError('I-MR 需要 imr 输入。');
      }
      return buildImr(inputs.values);
    }
    case 'P': {
      if (inputs.kind !== 'attributes') {
        throw new TypeError('P 图需要 attributes 输入。');
      }
      return buildP(inputs.data);
    }
    case 'NP': {
      if (inputs.kind !== 'attributes') {
        throw new TypeError('NP 图需要 attributes 输入。');
      }
      return buildNp(inputs.data);
    }
    case 'C': {
      if (inputs.kind !== 'attributes') {
        throw new TypeError('C 图需要 attributes 输入。');
      }
      return buildC(inputs.data);
    }
    case 'U': {
      if (inputs.kind !== 'attributes') {
        throw new TypeError('U 图需要 attributes 输入。');
      }
      return buildU(inputs.data);
    }
    default: {
      throw new TypeError(`未知控制图类型：${String(type)}。`);
    }
  }
}

/**
 * 由控制图序列推导逐点 σ（用于判异准则）。
 *
 * 计量型：σ = (UCL - CL) / 3（恒定）。
 * 计数型：若为变限，则逐点 σ_i = (UCL_i - CL_i) / 3。
 *
 * 出处：架构文档 §9.4。
 */
export function sigmaByPointOf(series: ControlChartSeries): number[] {
  const primary = series.limits.primary;
  const cl = primary.find((l) => l.label === 'CL');
  const ucl = primary.find((l) => l.label === 'UCL');
  if (!cl || !ucl) {
    throw new RangeError('控制限序列缺少 CL 或 UCL，无法推导 σ。');
  }
  const len = series.primary.points.length;
  const result: number[] = [];
  for (let i = 0; i < len; i += 1) {
    const clValue = cl.values[Math.min(i, cl.values.length - 1)];
    const uclValue = ucl.values[Math.min(i, ucl.values.length - 1)];
    result.push((uclValue - clValue) / 3);
  }
  return result;
}

/** 导出各子模块（便于按类型直接引用）。 */
export { buildXbarR } from './xbarR';
export { buildXbarS } from './xbarS';
export { buildImr, movingRanges } from './imr';
export { buildP, buildNp, buildC, buildU } from './attributes';
