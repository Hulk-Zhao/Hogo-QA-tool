/**
 * 控制图控制限计算测试（架构文档 §7 T01 验收要点 6、§10.6）。
 * 含变限 P/U。
 */

import { describe, expect, it } from 'vitest';
import { buildXbarR } from '../charts/xbarR';
import { buildXbarS } from '../charts/xbarS';
import { buildImr, movingRanges } from '../charts/imr';
import { buildC, buildNp, buildP, buildU } from '../charts/attributes';
import { buildControlChart, sigmaByPointOf } from '../charts/controlChart';
import { buildSubgroups } from '../stats/subgrouping';
import { getConstants } from '../constants/controlChartConstants';
import type { MeasurementInput } from '../types';

function measurements(values: number[]): MeasurementInput[] {
  return values.map((v, i) => ({ id: `M-${i}`, value: v }));
}

describe('Xbar-R 控制限', () => {
  it('Xbar 图 CL=X̄, UCL/LCL=X̄±A2·R̄；R 图 CL=R̄, UCL=D4·R̄', () => {
    const values = [10, 10.1, 9.9, 10.05, 10.02, 10.2, 10.15, 9.95, 10.1, 10.0];
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 5 });
    const series = buildXbarR(subs);
    const c = getConstants(5);
    const xBar = (subs[0].mean + subs[1].mean) / 2;
    const rBar = (subs[0].range + subs[1].range) / 2;

    const cl = series.limits.primary.find((l) => l.label === 'CL')!;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const lcl = series.limits.primary.find((l) => l.label === 'LCL')!;
    expect(cl.values[0]).toBeCloseTo(xBar, 10);
    expect(ucl.values[0]).toBeCloseTo(xBar + c.A2 * rBar, 10);
    expect(lcl.values[0]).toBeCloseTo(xBar - c.A2 * rBar, 10);

    const rCl = series.limits.secondary!.find((l) => l.label === 'CL')!;
    const rUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    expect(rCl.values[0]).toBeCloseTo(rBar, 10);
    expect(rUcl.values[0]).toBeCloseTo(c.D4 * rBar, 10);
    // D3(5) 无定义 → R 图不画 LCL
    expect(series.limits.secondary!.find((l) => l.label === 'LCL')).toBeUndefined();
  });

  it('子组容量不等时 X̄ 按容量加权', () => {
    // 直接构造不同容量的子组统计
    const subs = [
      { id: 'a', index: 0, size: 3, values: [1, 2, 3], mean: 2, range: 2, std: 1 },
      { id: 'b', index: 1, size: 6, values: [5, 5, 5, 5, 5, 5], mean: 5, range: 0, std: 0 },
    ];
    const series = buildXbarR(subs);
    const cl = series.limits.primary.find((l) => l.label === 'CL')!;
    // 加权：(2*3 + 5*6)/9 = 36/9 = 4
    expect(cl.values[0]).toBeCloseTo(4, 10);
  });
});

describe('Xbar-S 控制限', () => {
  it('Xbar 图用 A3；S 图 UCL=B4·S̄', () => {
    const values = Array.from({ length: 30 }, (_, i) => 10 + Math.sin(i) * 0.5);
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 15 });
    const series = buildXbarS(subs);
    const c = getConstants(15);
    const sBar = subs.reduce((a, g) => a + g.std, 0) / subs.length;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const sUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    const xBar = subs.reduce((a, g) => a + g.mean, 0) / subs.length;
    expect(ucl.values[0]).toBeCloseTo(xBar + c.A3 * sBar, 10);
    expect(sUcl.values[0]).toBeCloseTo(c.B4 * sBar, 10);
  });
});

describe('I-MR 控制限', () => {
  it('I 图 UCL=X̄+E2(2)·MR̄；MR 图 UCL=D4(2)·MR̄', () => {
    const values = [10, 10.2, 9.9, 10.1, 10.0, 10.3];
    const series = buildImr(values);
    const c = getConstants(2);
    const xBar = values.reduce((a, b) => a + b, 0) / values.length;
    const mr = movingRanges(values);
    const mrBar = mr.reduce((a, b) => a + b, 0) / mr.length;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const mrUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    expect(ucl.values[0]).toBeCloseTo(xBar + c.E2 * mrBar, 10);
    expect(mrUcl.values[0]).toBeCloseTo(c.D4 * mrBar, 10);
    expect(c.E2).toBeCloseTo(2.66, 4);
  });

  it('MR 图点数 = n-1', () => {
    const values = [1, 2, 3, 4, 5];
    const series = buildImr(values);
    expect(series.primary.points.length).toBe(5);
    expect(series.secondary!.points.length).toBe(4);
  });

  it('少于 2 个单值抛 RangeError', () => {
    expect(() => buildImr([1])).toThrow(RangeError);
  });
});

describe('计数型控制图', () => {
  it('P 图恒定样本量：限 = p̄ ± 3√(p̄(1-p̄)/n)', () => {
    const d = [2, 3, 1, 4, 2, 3];
    const n = new Array<number>(6).fill(100);
    const series = buildP({ defectivesOrDefects: d, sampleSizes: n });
    const pBar = d.reduce((a, b) => a + b, 0) / 600;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.values[0]).toBeCloseTo(pBar + 3 * Math.sqrt((pBar * (1 - pBar)) / 100), 10);
    expect(ucl.isConstant).toBe(true);
  });

  it('P 图变样本量：逐点变限', () => {
    const d = [2, 3, 1, 4, 2];
    const n = [100, 150, 120, 200, 110];
    const series = buildP({ defectivesOrDefects: d, sampleSizes: n });
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.isConstant).toBe(false);
    const pBar = d.reduce((a, b) => a + b, 0) / n.reduce((a, b) => a + b, 0);
    expect(ucl.values[1]).toBeCloseTo(pBar + 3 * Math.sqrt((pBar * (1 - pBar)) / 150), 10);
  });

  it('NP 图要求样本量恒定', () => {
    expect(() =>
      buildNp({ defectivesOrDefects: [1, 2, 3], sampleSizes: [100, 100, 120] }),
    ).toThrow(RangeError);
    const series = buildNp({ defectivesOrDefects: [1, 2, 3], sampleSizes: [100, 100, 100] });
    expect(series.primary.name).toBe('np');
  });

  it('C 图：限 = c̄ ± 3√c̄', () => {
    const c = [3, 4, 2, 5, 3, 4];
    const series = buildC({ defectivesOrDefects: c, sampleSizes: new Array<number>(6).fill(1) });
    const cBar = c.reduce((a, b) => a + b, 0) / 6;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.values[0]).toBeCloseTo(cBar + 3 * Math.sqrt(cBar), 10);
  });

  it('U 图变样本量：限 = ū ± 3√(ū/n_i)', () => {
    const c = [3, 4, 2, 5, 3];
    const n = [50, 60, 55, 70, 45];
    const series = buildU({ defectivesOrDefects: c, sampleSizes: n });
    const uBar = c.reduce((a, b) => a + b, 0) / n.reduce((a, b) => a + b, 0);
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.values[2]).toBeCloseTo(uBar + 3 * Math.sqrt(uBar / 55), 10);
    expect(ucl.isConstant).toBe(false);
  });

  it('P 图样本量 <=0 抛 RangeError', () => {
    expect(() => buildP({ defectivesOrDefects: [1, 2], sampleSizes: [100, 0] })).toThrow(RangeError);
  });
});

describe('buildControlChart 工厂分发', () => {
  it('类型与输入不匹配抛 TypeError', () => {
    expect(() => buildControlChart('I-MR', { kind: 'variables', subgroups: [] })).toThrow(TypeError);
  });

  it('Xbar-R 经工厂正确分发', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 5 });
    const series = buildControlChart('Xbar-R', { kind: 'variables', subgroups: subs });
    expect(series.selectedType).toBe('Xbar-R');
  });

  it('sigmaByPointOf 计量型恒定 σ=(UCL-CL)/3', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const subs = buildSubgroups(measurements(values), { mode: 'fixed', capacity: 5 });
    const series = buildControlChart('Xbar-R', { kind: 'variables', subgroups: subs });
    const sigmas = sigmaByPointOf(series);
    expect(sigmas.length).toBe(series.primary.points.length);
    expect(sigmas[0]).toBeCloseTo((series.limits.primary[1].values[0] - series.limits.primary[0].values[0]) / 3, 10);
  });

  it('sigmaByPointOf 变限 P 图逐点不同', () => {
    const series = buildP({
      defectivesOrDefects: [2, 3, 1, 4, 2],
      sampleSizes: [100, 150, 120, 200, 110],
    });
    const sigmas = sigmaByPointOf(series);
    expect(sigmas[0]).not.toBeCloseTo(sigmas[1], 6);
  });
});
