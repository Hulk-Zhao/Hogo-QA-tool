/**
 * 子组划分测试（PRD §4.1 三种模式）。
 */

import { describe, expect, it } from 'vitest';
import { buildSubgroups, buildSubgroupsFromIds } from '../stats/subgrouping';
import type { MeasurementInput } from '../types';

function ms(values: number[], excludedIdx: number[] = []): MeasurementInput[] {
  const set = new Set(excludedIdx);
  return values.map((v, i) => ({ id: `M-${i}`, value: v, excluded: set.has(i) }));
}

describe('buildSubgroups —— fixed', () => {
  it('按容量连续切分', () => {
    const subs = buildSubgroups(ms([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), { mode: 'fixed', capacity: 5 });
    expect(subs.length).toBe(2);
    expect(subs[0].size).toBe(5);
    expect(subs[0].values).toEqual([1, 2, 3, 4, 5]);
    expect(subs[1].values).toEqual([6, 7, 8, 9, 10]);
  });

  it('末尾残余单个值被跳过（无法构成 n>=2）', () => {
    const subs = buildSubgroups(ms([1, 2, 3, 4, 5, 6]), { mode: 'fixed', capacity: 5 });
    expect(subs.length).toBe(1);
    expect(subs[0].size).toBe(5);
  });

  it('已排除的记录被剔除', () => {
    const subs = buildSubgroups(ms([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], [0]), {
      mode: 'fixed',
      capacity: 5,
    });
    expect(subs[0].values).toEqual([2, 3, 4, 5, 6]);
  });

  it('容量 <2 或非整数抛 RangeError', () => {
    expect(() => buildSubgroups(ms([1, 2, 3]), { mode: 'fixed', capacity: 1 })).toThrow(RangeError);
    expect(() => buildSubgroups(ms([1, 2, 3]), { mode: 'fixed', capacity: 2.5 })).toThrow(RangeError);
  });

  it('未提供 capacity 抛 RangeError', () => {
    expect(() => buildSubgroups(ms([1, 2, 3]), { mode: 'fixed' })).toThrow(RangeError);
  });
});

describe('buildSubgroups —— byColumn', () => {
  it('按列值分组', () => {
    const measurements = ms([1, 2, 3, 4, 5, 6]);
    const subs = buildSubgroups(measurements, {
      mode: 'byColumn',
      columnValues: ['A', 'A', 'B', 'B', 'C', 'C'],
    });
    expect(subs.length).toBe(3);
    expect(subs[0].values).toEqual([1, 2]);
    expect(subs[1].values).toEqual([3, 4]);
    expect(subs[2].values).toEqual([5, 6]);
  });

  it('分组键长度不匹配抛 TypeError', () => {
    expect(() =>
      buildSubgroups(ms([1, 2, 3]), { mode: 'byColumn', columnValues: ['A', 'B'] }),
    ).toThrow(TypeError);
  });

  it('排除项与 columnValues 对齐', () => {
    const measurements = ms([1, 2, 3, 4], [1]); // 排除索引 1
    const subs = buildSubgroups(measurements, {
      mode: 'byColumn',
      columnValues: ['A', 'A', 'B', 'B'],
    });
    // 过滤后：索引0(A,1), 索引2(B,3), 索引3(B,4) → A 仅 1 点被跳过, B 有 2 点
    expect(subs.length).toBe(1);
    expect(subs[0].values).toEqual([3, 4]);
  });
});

describe('buildSubgroups —— manual', () => {
  it('按边界切分', () => {
    const subs = buildSubgroups(ms([1, 2, 3, 4, 5, 6, 7]), {
      mode: 'manual',
      manualBoundaries: [0, 3],
    });
    expect(subs.length).toBe(2);
    expect(subs[0].values).toEqual([1, 2, 3]);
    expect(subs[1].values).toEqual([4, 5, 6, 7]);
  });

  it('边界非升序抛 RangeError', () => {
    expect(() =>
      buildSubgroups(ms([1, 2, 3, 4]), { mode: 'manual', manualBoundaries: [2, 0] }),
    ).toThrow(RangeError);
  });

  it('边界越界抛 RangeError', () => {
    expect(() =>
      buildSubgroups(ms([1, 2, 3]), { mode: 'manual', manualBoundaries: [0, 5] }),
    ).toThrow(RangeError);
  });
});

describe('buildSubgroupsFromIds', () => {
  it('按 subgroupId 分组', () => {
    const measurements: MeasurementInput[] = [
      { id: 'a', value: 1, subgroupId: 'S1' },
      { id: 'b', value: 2, subgroupId: 'S1' },
      { id: 'c', value: 3, subgroupId: 'S2' },
      { id: 'd', value: 4, subgroupId: 'S2' },
    ];
    const subs = buildSubgroupsFromIds(measurements);
    expect(subs.length).toBe(2);
    expect(subs[0].values).toEqual([1, 2]);
  });
});

describe('SubgroupStats 字段正确性', () => {
  it('mean/range/std 计算正确（std ddof=1）', () => {
    const subs = buildSubgroups(ms([2, 4, 4, 4, 5, 5, 7, 9]), { mode: 'fixed', capacity: 8 });
    const g = subs[0];
    expect(g.mean).toBeCloseTo(5, 10);
    expect(g.range).toBeCloseTo(7, 10);
    // 样本标准差 ddof=1
    const mean = 5;
    const ss = [2, 4, 4, 4, 5, 5, 7, 9].reduce((a, x) => a + (x - mean) ** 2, 0);
    expect(g.std).toBeCloseTo(Math.sqrt(ss / 7), 10);
  });
});
