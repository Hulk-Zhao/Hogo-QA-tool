/**
 * 异常值识别测试（PRD §4.5、架构文档 §0.2 #3）。
 * Grubbs 默认 + 1.5 IQR，只标注不删除。
 */

import { describe, expect, it } from 'vitest';
import { detectOutliers, grubbsTest, iqrTest } from '../stats/outliers';

describe('Grubbs', () => {
  it('识别单点离群', () => {
    const values = [10, 10.1, 9.9, 10.05, 9.95, 10.02, 10.01, 9.98, 10.03, 20];
    const flags = grubbsTest(values);
    expect(flags.length).toBeGreaterThanOrEqual(1);
    expect(flags.some((f) => f.index === 9)).toBe(true);
    expect(flags[0].method).toBe('grubbs');
    expect(flags[0].confirmed).toBe(false);
  });

  it('无离群数据不标注', () => {
    const values = [10, 10.1, 9.9, 10.05, 9.95, 10.02, 10.01, 9.98, 10.03, 10.0];
    expect(grubbsTest(values).length).toBe(0);
  });

  it('n<3 返回空', () => {
    expect(grubbsTest([1, 2]).length).toBe(0);
  });

  it('标准差为 0 返回空', () => {
    expect(grubbsTest([5, 5, 5, 5, 5]).length).toBe(0);
  });
});

describe('1.5 IQR', () => {
  it('识别箱线图离群点', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const flags = iqrTest(values);
    expect(flags.some((f) => f.index === 9)).toBe(true);
    expect(flags[0].method).toBe('iqr');
  });

  it('无离群数据不标注', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(iqrTest(values).length).toBe(0);
  });

  it('n<4 返回空', () => {
    expect(iqrTest([1, 2, 3]).length).toBe(0);
  });
});

describe('detectOutliers 统一入口', () => {
  it('默认 grubbs 方法', () => {
    const values = [10, 10.1, 9.9, 10.05, 9.95, 10.02, 10.01, 9.98, 10.03, 20];
    expect(detectOutliers(values, 'grubbs').length).toBeGreaterThan(0);
  });

  it('iqr 方法可切换', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    expect(detectOutliers(values, 'iqr').length).toBeGreaterThan(0);
  });

  it('未知方法抛 TypeError', () => {
    expect(() => detectOutliers([1, 2, 3], 'foo' as 'grubbs')).toThrow(TypeError);
  });

  it('只标注不删除：返回标注但输入未变', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 100];
    const before = [...values];
    detectOutliers(values, 'iqr');
    expect(values).toEqual(before);
  });
});
