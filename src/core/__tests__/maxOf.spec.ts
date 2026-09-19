/**
 * maxOf / minOf 测试（本轮 P2-B：消除 `Math.max(...arr)` 同类隐患）。
 *
 * 证伪立场：把 `maxOf` 换回 `Math.max(...xs)` 实现，「20 万元素」用例必须变红
 * —— 这正是本轮改动的**唯一理由**：展开运算符把每个元素当实参压栈，
 * 大数据量直接 `RangeError: Maximum call stack size exceeded`。
 */

import { describe, expect, it } from 'vitest';
import { maxOf, minOf } from '../math/matrix';

/** 造一个长度为 n 的确定性数组（值域 0..999）。 */
function bigArray(n: number): number[] {
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = (i * 7919) % 1000;
  }
  return out;
}

describe('maxOf / minOf', () => {
  it('基本语义：单元素 / 含负数 / 含小数', () => {
    expect(maxOf([5])).toBe(5);
    expect(minOf([5])).toBe(5);
    expect(maxOf([-3, -1, -7])).toBe(-1);
    expect(minOf([-3, -1, -7])).toBe(-7);
    expect(maxOf([1.5, 2.25, 0.5])).toBe(2.25);
    expect(minOf([1.5, 2.25, 0.5])).toBe(0.5);
  });

  it('空数组抛 RangeError（与 average/range 一致的契约）', () => {
    expect(() => maxOf([])).toThrow(RangeError);
    expect(() => minOf([])).toThrow(RangeError);
  });

  it('20 万元素不抛 RangeError（Math.max(...xs) 在此规模必爆栈）', () => {
    const xs = bigArray(200000);

    // 反向对照：证明旧写法确实不可用。若这条断言不成立，本用例就失去意义。
    expect(() => Math.max(...xs)).toThrow(RangeError);

    expect(maxOf(xs)).toBe(999);
    expect(minOf(xs)).toBe(0);
  });

  it('不修改入参（纯函数）', () => {
    const xs = [3, 1, 2];
    maxOf(xs);
    minOf(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});
