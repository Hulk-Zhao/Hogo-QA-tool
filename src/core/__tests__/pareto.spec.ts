/**
 * 柏拉图测试（架构文档 §7 T01 验收要点 6）。
 * 基准 defect 数据第 3 项（毛边）跨越 80%。
 */

import { describe, expect, it } from 'vitest';
import { buildPareto } from '../pareto/pareto';
import { BENCHMARK_DEFECT_RECORDS, BENCHMARK_DEFECT_TOTAL } from './fixtures/sampleDefect';

describe('buildPareto —— 基准 defect 数据', () => {
  it('合计 838，6 类降序排列', () => {
    const r = buildPareto(BENCHMARK_DEFECT_RECORDS, 80, '其他', 0);
    expect(r.total).toBe(BENCHMARK_DEFECT_TOTAL);
    expect(r.items.length).toBe(6);
    expect(r.items[0].defectType).toBe('划伤');
    expect(r.items[0].count).toBe(320);
    // 降序
    for (let i = 1; i < r.items.length; i += 1) {
      expect(r.items[i].count).toBeLessThanOrEqual(r.items[i - 1].count);
    }
  });

  it('★ 第 3 项（毛边）跨越 80% 分界线', () => {
    const r = buildPareto(BENCHMARK_DEFECT_RECORDS, 80, '其他', 0);
    expect(r.crossingIndex).toBe(2);
    expect(r.items[2].defectType).toBe('毛边');
    expect(r.items[2].cumRatio).toBeGreaterThanOrEqual(80);
    expect(r.items[1].cumRatio).toBeLessThan(80);
  });

  it('前 3 项累计约 81.50%', () => {
    const r = buildPareto(BENCHMARK_DEFECT_RECORDS, 80, '其他', 0);
    expect(r.items[2].cumRatio).toBeCloseTo(81.5, 1);
  });

  it('占比正确：划伤 38.19%', () => {
    const r = buildPareto(BENCHMARK_DEFECT_RECORDS, 80, '其他', 0);
    expect(r.items[0].ratio).toBeCloseTo(38.19, 1);
  });

  it('累计占比末项为 100%', () => {
    const r = buildPareto(BENCHMARK_DEFECT_RECORDS, 80, '其他', 0);
    expect(r.items[r.items.length - 1].cumRatio).toBeCloseTo(100, 6);
  });
});

describe('buildPareto —— 其他项合并', () => {
  it('小项合并为「其他」', () => {
    const records = [
      { id: '1', datasetId: 'd', defectType: 'A', count: 100, category: null },
      { id: '2', datasetId: 'd', defectType: 'B', count: 60, category: null },
      { id: '3', datasetId: 'd', defectType: 'C', count: 2, category: null },
      { id: '4', datasetId: 'd', defectType: 'D', count: 1, category: null },
    ];
    const r = buildPareto(records, 80, '其他', 0.05);
    const other = r.items.find((i) => i.isOther);
    expect(other).toBeDefined();
    expect(other!.count).toBe(3);
  });

  it('关联合并（otherThreshold=0）保留全部', () => {
    const records = [
      { id: '1', datasetId: 'd', defectType: 'A', count: 100, category: null },
      { id: '2', datasetId: 'd', defectType: 'B', count: 1, category: null },
    ];
    const r = buildPareto(records, 80, '其他', 0);
    expect(r.items.length).toBe(2);
    expect(r.items.some((i) => i.isOther)).toBe(false);
  });
});
