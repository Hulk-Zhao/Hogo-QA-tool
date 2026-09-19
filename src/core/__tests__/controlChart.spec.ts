/**
 * 控制图工厂与 σ 推导测试（架构文档 §2.4 文件列表契约）。
 *
 * 与 charts.spec.ts 互补：本文件聚焦 chartFactory 分发与 sigmaByPointOf。
 */

import { describe, expect, it } from 'vitest';
import { buildControlChart, sigmaByPointOf } from '../charts/chartFactory';
import { buildSubgroups } from '../stats/subgrouping';
import type { MeasurementInput } from '../types';

function measurements(values: number[]): MeasurementInput[] {
  return values.map((v, i) => ({ id: `M-${i}`, value: v }));
}

describe('chartFactory 分发', () => {
  it('7 种图表类型均可构造', () => {
    const values = [10, 10.1, 9.9, 10.05, 10.02, 10.2, 10.15, 9.95, 10.1, 10.0];
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 5 });

    expect(buildControlChart('Xbar-R', { kind: 'variables', subgroups: subs }).selectedType).toBe('Xbar-R');
    expect(buildControlChart('Xbar-S', { kind: 'variables', subgroups: subs }).selectedType).toBe('Xbar-S');
    expect(buildControlChart('I-MR', { kind: 'imr', values }).selectedType).toBe('I-MR');
    const attr = { kind: 'attributes' as const, data: { defectivesOrDefects: [2, 3, 1], sampleSizes: [100, 100, 100] } };
    expect(buildControlChart('P', attr).selectedType).toBe('P');
    expect(buildControlChart('NP', attr).selectedType).toBe('NP');
    expect(buildControlChart('C', { kind: 'attributes', data: { defectivesOrDefects: [2, 3, 1], sampleSizes: [1, 1, 1] } }).selectedType).toBe('C');
    expect(buildControlChart('U', { kind: 'attributes', data: { defectivesOrDefects: [2, 3, 1], sampleSizes: [50, 60, 55] } }).selectedType).toBe('U');
  });

  it('类型与输入不匹配抛 TypeError', () => {
    expect(() => buildControlChart('Xbar-R', { kind: 'imr', values: [1, 2] })).toThrow(TypeError);
    expect(() => buildControlChart('I-MR', { kind: 'attributes', data: { defectivesOrDefects: [], sampleSizes: [] } })).toThrow(TypeError);
  });

  it('未知类型抛 TypeError', () => {
    expect(() => buildControlChart('XYZ' as 'P', { kind: 'imr', values: [1, 2] })).toThrow(TypeError);
  });
});

describe('sigmaByPointOf', () => {
  it('计量型 σ 恒定', () => {
    const values = Array.from({ length: 20 }, (_, i) => 10 + Math.sin(i) * 0.3);
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 5 });
    const series = buildControlChart('Xbar-R', { kind: 'variables', subgroups: subs });
    const sigmas = sigmaByPointOf(series);
    expect(sigmas.every((s) => Math.abs(s - sigmas[0]) < 1e-12)).toBe(true);
  });

  it('变限 P 图 σ 逐点不同', () => {
    const series = buildControlChart('P', {
      kind: 'attributes',
      data: { defectivesOrDefects: [2, 3, 1, 4], sampleSizes: [100, 200, 150, 300] },
    });
    const sigmas = sigmaByPointOf(series);
    expect(Math.abs(sigmas[0] - sigmas[1])).toBeGreaterThan(1e-9);
  });
});
