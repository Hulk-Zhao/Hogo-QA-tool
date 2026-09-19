/**
 * 直方图分箱（默认 Sturges 规则）。
 *
 * 出处：Sturges (1926), JASA 21(153):65–66（分箱数 = ceil(log2(n)) + 1）。
 */

import type { HistogramResult } from '../types';

/** 默认分箱规则标识。 */
export const STURGES = 'sturges' as const;

/**
 * 按 Sturges 规则计算分箱数：k = ceil(log2(n)) + 1。
 *
 * @throws {RangeError} 空数组
 */
export function sturgesBinCount(n: number): number {
  if (n <= 0) {
    throw new RangeError(`Sturges 分箱要求样本数 > 0，收到 n=${n}。`);
  }
  return Math.ceil(Math.log2(n)) + 1;
}

/**
 * 构造直方图。
 *
 * @param values 数值数组
 * @param rule 分箱规则：'sturges'（默认）或显式分箱数
 * @throws {RangeError} 空数组或非法分箱数
 */
export function buildHistogram(values: number[], rule: 'sturges' | number = STURGES): HistogramResult {
  const n = values.length;
  if (n === 0) {
    throw new RangeError('buildHistogram 输入不能为空数组。');
  }

  let min = values[0];
  let max = values[0];
  for (let i = 1; i < n; i += 1) {
    if (values[i] < min) min = values[i];
    if (values[i] > max) max = values[i];
  }

  let binCount: number;
  if (rule === 'sturges') {
    binCount = sturgesBinCount(n);
  } else if (Number.isInteger(rule) && rule >= 1) {
    binCount = rule;
  } else {
    throw new RangeError(`非法分箱规则：${String(rule)}。`);
  }

  // 退化：全部相等
  if (max === min) {
    const width = 1;
    const x0 = min - 0.5;
    const x1 = min + 0.5;
    return {
      bins: [{ x0, x1, count: n, label: formatLabel(x0, x1) }],
      binWidth: width,
      binCount: 1,
      rule,
    };
  }

  const binWidth = (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);

  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= binCount) {
      idx = binCount - 1; // 含最大值的闭区间处理
    }
    if (idx < 0) {
      idx = 0;
    }
    counts[idx] += 1;
  }

  const bins = counts.map((count, i) => {
    const x0 = min + i * binWidth;
    const x1 = i === binCount - 1 ? max : min + (i + 1) * binWidth;
    return { x0, x1, count, label: formatLabel(x0, x1) };
  });

  return { bins, binWidth, binCount, rule };
}

/** 分箱标签：保留 4 位有效小数（仅展示用，不影响计算）。 */
function formatLabel(x0: number, x1: number): string {
  const fmt = (x: number): string => {
    const rounded = Math.round(x * 1e4) / 1e4;
    return String(rounded);
  };
  return `[${fmt(x0)}, ${fmt(x1)})`;
}
