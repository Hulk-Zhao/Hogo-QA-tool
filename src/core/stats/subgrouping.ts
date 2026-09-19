/**
 * 子组划分（三种模式：固定容量 / 按列 / 手动）。
 *
 * 出处：PRD §4.1 子组划分定义；子组容量 n 须为整数且 >= 2。
 */

import type { MeasurementInput, SubgroupConfig, SubgroupStats } from '../types';
import { mean as meanOf } from './descriptive';
import { range } from '../math/matrix';

/**
 * 计算单个子组的统计量。
 *
 * @param values 子组内（未排除的）测量值
 * @param index 子组序号（0-based）
 * @param id 子组 id
 * @throws {RangeError} 子组为空或 n < 2
 */
function computeSubgroupStats(values: number[], index: number, id: string): SubgroupStats {
  const n = values.length;
  if (n < 2) {
    throw new RangeError(`子组 ${id} 容量 n=${n} 必须 >= 2。`);
  }
  const mu = meanOf(values);
  let ss = 0;
  for (let i = 0; i < n; i += 1) {
    const d = values[i] - mu;
    ss += d * d;
  }
  const std = Math.sqrt(ss / (n - 1));
  return {
    id,
    index,
    size: n,
    values: [...values],
    mean: mu,
    range: range(values),
    std,
  };
}

/**
 * 过滤已排除的测量值。
 */
function activeValues(measurements: MeasurementInput[]): MeasurementInput[] {
  return measurements.filter((m) => m.excluded !== true);
}

/**
 * 按固定容量连续切分。
 *
 * @throws {RangeError} capacity 非整数或 < 2
 */
function buildFixed(measurements: MeasurementInput[], capacity: number): SubgroupStats[] {
  if (!Number.isInteger(capacity) || capacity < 2) {
    throw new RangeError(`fixed 模式子组容量必须为 >= 2 的整数，收到 ${capacity}。`);
  }
  const result: SubgroupStats[] = [];
  let index = 0;
  for (let start = 0; start < measurements.length; start += capacity) {
    const chunk = measurements.slice(start, start + capacity);
    // 末尾不足一个完整子组时，仍作为独立子组（其 n 更小），以不丢数据；
    // 调用方可据 size 判断是否为完整子组。
    if (chunk.length === 1) {
      // 单个残余值无法构成 n>=2 子组，按约定跳过（避免抛错中断整批分析）。
      continue;
    }
    const id = chunk[0].subgroupId ?? `SG-${index}`;
    result.push(computeSubgroupStats(chunk.map((m) => m.value), index, id));
    index += 1;
  }
  return result;
}

/**
 * 按列分组：columnValues[i] 与 measurements[i] 一一对应，值相同的进入同一子组。
 *
 * @throws {TypeError} columnValues 长度与 measurements 不一致
 */
function buildByColumn(measurements: MeasurementInput[], columnValues: string[]): SubgroupStats[] {
  if (columnValues.length !== measurements.length) {
    throw new TypeError(
      `byColumn 模式要求分组键与测量值一一对应，收到 ${columnValues.length} vs ${measurements.length}。`,
    );
  }
  const groups = new Map<string, number[]>();
  const groupOrder: string[] = [];
  for (let i = 0; i < measurements.length; i += 1) {
    const key = columnValues[i];
    if (!groups.has(key)) {
      groups.set(key, []);
      groupOrder.push(key);
    }
    groups.get(key)!.push(measurements[i].value);
  }
  const result: SubgroupStats[] = [];
  groupOrder.forEach((key, idx) => {
    const values = groups.get(key)!;
    if (values.length < 2) {
      return;
    }
    result.push(computeSubgroupStats(values, idx, key));
  });
  return result;
}

/**
 * 按手动边界切分：boundaries 为子组起始索引（升序），末组延伸至结尾。
 *
 * @throws {RangeError} boundaries 非升序或含越界索引
 */
function buildManual(measurements: MeasurementInput[], boundaries: number[]): SubgroupStats[] {
  const n = measurements.length;
  if (boundaries.length === 0) {
    throw new RangeError('manual 模式必须提供至少一个子组起始索引。');
  }
  for (let i = 0; i < boundaries.length; i += 1) {
    if (!Number.isInteger(boundaries[i]) || boundaries[i] < 0 || boundaries[i] >= n) {
      throw new RangeError(`manual 模式子组起始索引 ${boundaries[i]} 越界（0..${n - 1}）。`);
    }
    if (i > 0 && boundaries[i] <= boundaries[i - 1]) {
      throw new RangeError('manual 模式子组起始索引必须严格升序。');
    }
  }
  const result: SubgroupStats[] = [];
  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i];
    const end = i + 1 < boundaries.length ? boundaries[i + 1] : n;
    const values = measurements.slice(start, end).map((m) => m.value);
    if (values.length < 2) {
      continue;
    }
    result.push(computeSubgroupStats(values, i, `SG-${i}`));
  }
  return result;
}

/**
 * 子组划分统一入口。
 *
 * 出处：PRD §4.1（固定容量 / 按列 / 手动三种模式）。
 *
 * @param measurements 测量记录（excluded=true 的记录会被剔除）
 * @param config 子组划分配置
 * @returns 子组统计数组（按原始顺序）
 */
export function buildSubgroups(
  measurements: MeasurementInput[],
  config: SubgroupConfig,
): SubgroupStats[] {
  const active = activeValues(measurements);
  switch (config.mode) {
    case 'fixed': {
      if (config.capacity === undefined) {
        throw new RangeError('fixed 模式必须提供 capacity。');
      }
      return buildFixed(active, config.capacity);
    }
    case 'byColumn': {
      if (!config.columnValues) {
        throw new RangeError('byColumn 模式必须提供 columnValues。');
      }
      if (config.columnValues.length !== measurements.length) {
        throw new TypeError(
          `byColumn 模式要求分组键与测量值一一对应，收到 ${config.columnValues.length} vs ${measurements.length}。`,
        );
      }
      // columnValues 针对原始 measurements（含 excluded），需先按 active 过滤对齐。
      const aligned: string[] = [];
      for (let i = 0; i < measurements.length; i += 1) {
        if (measurements[i].excluded !== true) {
          aligned.push(config.columnValues[i]);
        }
      }
      return buildByColumn(active, aligned);
    }
    case 'manual': {
      if (!config.manualBoundaries) {
        throw new RangeError('manual 模式必须提供 manualBoundaries。');
      }
      return buildManual(active, config.manualBoundaries);
    }
    default: {
      throw new TypeError(`未知子组划分模式：${String(config.mode)}。`);
    }
  }
}

/**
 * 从「已预分组」的测量记录构造子组统计（按 subgroupId 分组）。
 */
export function buildSubgroupsFromIds(measurements: MeasurementInput[]): SubgroupStats[] {
  const active = activeValues(measurements);
  const groups = new Map<string, number[]>();
  const order: string[] = [];
  for (const m of active) {
    const key = m.subgroupId ?? 'DEFAULT';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(m.value);
  }
  const result: SubgroupStats[] = [];
  order.forEach((key) => {
    const values = groups.get(key)!;
    if (values.length < 2) return;
    result.push(computeSubgroupStats(values, result.length, key));
  });
  return result;
}
