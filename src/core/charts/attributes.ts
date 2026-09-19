/**
 * 计数型控制图：P / NP / C / U（含变样本量 P/U 的逐点变限）。
 *
 * 出处：AIAG SPC 手册第 4 版 §IV（Attributes Control Charts）。
 * P:  p̄ = Σd/Σn；CL=p̄；限 = p̄ ± 3·√(p̄(1-p̄)/n_i)（n_i 不等逐点变限）
 * NP: n 恒定；np̄=Σd/N；CL=np̄；限 = np̄ ± 3·√(np̄(1-p̄))
 * C:  CL=c̄=Σc/N；限 = c̄ ± 3·√c̄
 * U:  ū=Σc/Σn；CL=ū；限 = ū ± 3·√(ū/n_i)
 */

import { maxOf } from '../math/matrix';
import type { AttributeInput, ChartPoint, ControlChartSeries, ControlLine } from '../types';

/** 判断数组是否全为有限非负数。 */
function assertNonNegative(values: number[], name: string): void {
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) {
      throw new RangeError(`${name} 必须为非负有限数，收到 ${v}。`);
    }
  }
}

/**
 * 构造逐点（或恒定）控制限序列。
 *
 * @param values 逐点限值（负值截断为 0，因计数型不合格率为负无意义）
 */
function pointwiseLine(label: string, values: number[], clipAtZero: boolean): ControlLine {
  const processed = clipAtZero ? values.map((v) => (v < 0 ? 0 : v)) : values;
  const first = processed[0];
  const isConstant = processed.every((v) => v === first);
  return { label, values: processed, isConstant };
}

/**
 * 构造 P 图（不合格品率）。
 */
export function buildP(input: AttributeInput): ControlChartSeries {
  const { defectivesOrDefects: d, sampleSizes: n } = input;
  if (d.length !== n.length || d.length === 0) {
    throw new RangeError('P 图要求不良数数组与样本量数组等长且非空。');
  }
  assertNonNegative(d, '不良数');
  assertNonNegative(n, '样本量');
  for (const size of n) {
    if (size <= 0) {
      throw new RangeError(`P 图样本量 n_i 必须 > 0，收到 ${size}。`);
    }
  }
  const totalN = n.reduce((a, b) => a + b, 0);
  const totalD = d.reduce((a, b) => a + b, 0);
  const pBar = totalD / totalN;

  const points: ChartPoint[] = d.map((di, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: di / n[i],
    subgroupSize: n[i],
  }));

  const ucl: number[] = [];
  const lcl: number[] = [];
  for (let i = 0; i < n.length; i += 1) {
    const se = Math.sqrt((pBar * (1 - pBar)) / n[i]);
    ucl.push(pBar + 3 * se);
    lcl.push(Math.max(0, pBar - 3 * se));
  }

  return {
    primary: { name: 'p', points },
    limits: {
      primary: [
        pointwiseLine('CL', new Array<number>(n.length).fill(pBar), false),
        pointwiseLine('UCL', ucl, false),
        pointwiseLine('LCL', lcl, false),
      ],
    },
    constantsUsed: { n: maxOf(n) },
    selectedType: 'P',
  };
}

/**
 * 构造 NP 图（不合格品数，n 恒定）。
 */
export function buildNp(input: AttributeInput): ControlChartSeries {
  const { defectivesOrDefects: d, sampleSizes: n } = input;
  if (d.length !== n.length || d.length === 0) {
    throw new RangeError('NP 图要求不良数数组与样本量数组等长且非空。');
  }
  assertNonNegative(d, '不良数');
  assertNonNegative(n, '样本量');
  const firstN = n[0];
  if (!n.every((v) => v === firstN)) {
    throw new RangeError('NP 图要求样本量恒定（n 相等）。');
  }
  if (firstN <= 0) {
    throw new RangeError(`NP 图样本量必须 > 0，收到 ${firstN}。`);
  }
  const count = d.length;
  const npBar = d.reduce((a, b) => a + b, 0) / count;
  const pBar = npBar / firstN;

  const points: ChartPoint[] = d.map((di, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: di,
    subgroupSize: firstN,
  }));

  const se = 3 * Math.sqrt(npBar * (1 - pBar));
  const ucl = npBar + se;
  const lcl = Math.max(0, npBar - se);

  return {
    primary: { name: 'np', points },
    limits: {
      primary: [
        { label: 'CL', values: new Array<number>(count).fill(npBar), isConstant: true },
        { label: 'UCL', values: new Array<number>(count).fill(ucl), isConstant: true },
        { label: 'LCL', values: new Array<number>(count).fill(lcl), isConstant: true },
      ],
    },
    constantsUsed: { n: firstN },
    selectedType: 'NP',
  };
}

/**
 * 构造 C 图（缺陷数，恒定机会区域）。
 */
export function buildC(input: AttributeInput): ControlChartSeries {
  const { defectivesOrDefects: c, sampleSizes: n } = input;
  if (c.length === 0) {
    throw new RangeError('C 图要求缺陷数数组非空。');
  }
  assertNonNegative(c, '缺陷数');
  const count = c.length;
  const cBar = c.reduce((a, b) => a + b, 0) / count;
  const se = 3 * Math.sqrt(cBar);
  const ucl = cBar + se;
  const lcl = Math.max(0, cBar - se);

  const points: ChartPoint[] = c.map((ci, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: ci,
    subgroupSize: n[i] ?? 1,
  }));

  return {
    primary: { name: 'c', points },
    limits: {
      primary: [
        { label: 'CL', values: new Array<number>(count).fill(cBar), isConstant: true },
        { label: 'UCL', values: new Array<number>(count).fill(ucl), isConstant: true },
        { label: 'LCL', values: new Array<number>(count).fill(lcl), isConstant: true },
      ],
    },
    constantsUsed: { n: n[0] ?? 1 },
    selectedType: 'C',
  };
}

/**
 * 构造 U 图（单位缺陷数，含变样本量逐点变限）。
 */
export function buildU(input: AttributeInput): ControlChartSeries {
  const { defectivesOrDefects: c, sampleSizes: n } = input;
  if (c.length !== n.length || c.length === 0) {
    throw new RangeError('U 图要求缺陷数数组与样本量数组等长且非空。');
  }
  assertNonNegative(c, '缺陷数');
  assertNonNegative(n, '样本量');
  for (const size of n) {
    if (size <= 0) {
      throw new RangeError(`U 图样本量 n_i 必须 > 0，收到 ${size}。`);
    }
  }
  const totalN = n.reduce((a, b) => a + b, 0);
  const totalC = c.reduce((a, b) => a + b, 0);
  const uBar = totalC / totalN;

  const points: ChartPoint[] = c.map((ci, i) => ({
    index: i,
    xLabel: `#${i + 1}`,
    value: ci / n[i],
    subgroupSize: n[i],
  }));

  const ucl: number[] = [];
  const lcl: number[] = [];
  for (let i = 0; i < n.length; i += 1) {
    const se = Math.sqrt(uBar / n[i]);
    ucl.push(uBar + 3 * se);
    lcl.push(Math.max(0, uBar - 3 * se));
  }

  return {
    primary: { name: 'u', points },
    limits: {
      primary: [
        pointwiseLine('CL', new Array<number>(n.length).fill(uBar), false),
        pointwiseLine('UCL', ucl, false),
        pointwiseLine('LCL', lcl, false),
      ],
    },
    constantsUsed: { n: maxOf(n) },
    selectedType: 'U',
  };
}
