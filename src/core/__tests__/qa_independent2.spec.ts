/**
 * QA 独立验证套件 —— 第二轮：统计公式 / 控制限 / 正态性 / 判异边界。
 *
 * 复算方式：QA 用**独立手写公式**与内核输出对拍（不 import 内核的中间量）。
 */

import { describe, expect, it } from 'vitest';
import { computeCapability, estimateSigmaWithin, computePpm } from '../stats/capability';
import { buildSubgroups } from '../stats/subgrouping';
import { buildXbarR } from '../charts/xbarR';
import { buildXbarS } from '../charts/xbarS';
import { buildImr } from '../charts/imr';
import { buildP, buildNp, buildC, buildU } from '../charts/attributes';
import { andersonDarling } from '../normality/andersonDarling';
import { shapiroWilk } from '../normality/shapiroWilk';
import type { MeasurementInput, SpecLimits, SubgroupStats } from '../types';

// ---------------------------------------------------------------------------
// QA 独立实现（与内核无关）
// ---------------------------------------------------------------------------
function qaMean(a: number[]): number {
  return a.reduce((x, y) => x + y, 0) / a.length;
}
function qaSd(a: number[], ddof = 1): number {
  const m = qaMean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof));
}
function qaRange(a: number[]): number {
  return Math.max(...a) - Math.min(...a);
}
/** QA 独立构子组（固定容量） */
function qaSubgroups(values: number[], cap: number): SubgroupStats[] {
  const out: SubgroupStats[] = [];
  for (let i = 0; i + cap <= values.length; i += cap) {
    const vals = values.slice(i, i + cap);
    out.push({
      id: `S${out.length}`,
      index: out.length,
      size: cap,
      values: vals,
      mean: qaMean(vals),
      range: qaRange(vals),
      std: qaSd(vals),
    });
  }
  return out;
}
function toMeas(values: number[]): MeasurementInput[] {
  return values.map((v, i) => ({ id: `M${i}`, value: v }));
}
/** QA 独立构子组：与内核一致——末尾残余（长度>=2）也作为独立子组保留 */
function qaSubgroupsWithTail(values: number[], cap: number): SubgroupStats[] {
  const out: SubgroupStats[] = [];
  for (let i = 0; i < values.length; i += cap) {
    const vals = values.slice(i, i + cap);
    if (vals.length < 2) continue;
    out.push({
      id: `S${out.length}`,
      index: out.length,
      size: vals.length,
      values: vals,
      mean: qaMean(vals),
      range: qaRange(vals),
      std: qaSd(vals),
    });
  }
  return out;
}
// 标准正态 CDF（独立实现，A&S 26.2.17 erf 同式但 QA 自写）
function qaPhi(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

// ---------------------------------------------------------------------------
describe('QA-4 σ_within 估计口径（修正旧工具的核心）', () => {
  const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i * 0.7) * 0.3 + (i % 3) * 0.05);

  it('n=5（<=10）用 R 法：σ_within == R̄/d2(5) 独立复算', () => {
    const sg = qaSubgroups(values, 5);
    const rBar = sg.reduce((a, g) => a + g.range, 0) / sg.length;
    const expectWithin = rBar / 2.326; // d2(5)
    const est = estimateSigmaWithin(values, buildSubgroups(toMeas(values), { mode: 'fixed', capacity: 5 }));
    expect(est.basis).toBe('R');
    expect(est.within).toBeCloseTo(expectWithin, 10);
    expect(est.rBar).toBeCloseTo(rBar, 10);
  });

  it('n=15（>10）用 S 法：σ_within == S̄/c4(15) 独立复算', () => {
    const v15 = values.slice(0, 45); // 45 可被 15 整除，避免残余子组混淆口径
    const sg = qaSubgroupsWithTail(v15, 15);
    const sBar = sg.reduce((a, g) => a + g.std, 0) / sg.length;
    const expectWithin = sBar / 0.9823; // c4(15) —— 权威值
    const est = estimateSigmaWithin(v15, buildSubgroups(toMeas(v15), { mode: 'fixed', capacity: 15 }));
    expect(est.basis).toBe('S');
    expect(est.within).toBeCloseTo(expectWithin, 10);
  });

  it('无子组 → I-MR 降级：σ_within == MR̄/1.128 独立复算', () => {
    const mr: number[] = [];
    for (let i = 1; i < values.length; i += 1) mr.push(Math.abs(values[i] - values[i - 1]));
    const mrBar = mr.reduce((a, b) => a + b, 0) / mr.length;
    const est = estimateSigmaWithin(values, []);
    expect(est.basis).toBe('IMR');
    expect(est.within).toBeCloseTo(mrBar / 1.128, 10);
  });

  it('σ_overall == 全样本 ddof=1 标准差（独立复算）', () => {
    const est = estimateSigmaWithin(values, []);
    expect(est.overall).toBeCloseTo(qaSd(values, 1), 12);
  });
});

describe('QA-5 Cp/Cpk 与 Pp/Ppk 必须由不同 σ 得出（旧工具缺陷）', () => {
  const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i * 0.7) * 0.3 + (i % 3) * 0.05);
  const spec: SpecLimits = { usl: 11, lsl: 9, target: 10, unit: 'mm' };
  const r = computeCapability(values, spec, qaSubgroups(values, 5));

  it('Cp = (USL-LSL)/(6σ_within)，独立复算', () => {
    expect(r.cp).toBeCloseTo((spec.usl! - spec.lsl!) / (6 * r.sigma.within), 12);
  });
  it('Cp != Pp（σ_within != σ_overall）', () => {
    expect(Math.abs(r.cp! - r.pp!)).toBeGreaterThan(1e-9);
  });
  it('Cpk = min((USL-μ)/(3σw), (μ-LSL)/(3σw))，独立复算', () => {
    const mu = qaMean(values);
    const cpu = (spec.usl! - mu) / (3 * r.sigma.within);
    const cpl = (mu - spec.lsl!) / (3 * r.sigma.within);
    expect(r.cpk).toBeCloseTo(Math.min(cpu, cpl), 12);
  });
  it('Ppk 用 σ_overall，独立复算', () => {
    const mu = qaMean(values);
    const s = qaSd(values, 1);
    const ppk = Math.min((spec.usl! - mu) / (3 * s), (mu - spec.lsl!) / (3 * s));
    expect(r.ppk).toBeCloseTo(ppk, 12);
    expect(r.sigma.overall).toBeCloseTo(s, 12);
  });
});

describe('QA-6 PPM 正态双侧尾面积独立复算', () => {
  it('对称规格 μ=10 σ=1 LSL=8 USL=12 → 约 45500（独立 Φ 复算）', () => {
    const spec: SpecLimits = { usl: 12, lsl: 8, target: 10, unit: 'mm' };
    const qaExpected = Math.round((qaPhi(-2) + qaPhi(-2)) * 1e6);
    const ppm = computePpm(10, 1, spec);
    expect(ppm).toBe(qaExpected); // 与独立 Φ 完全一致
    expect(ppm!).toBeGreaterThan(40000);
    expect(ppm!).toBeLessThan(50000);
  });

  it('单侧规格只算存在一侧', () => {
    const uslOnly: SpecLimits = { usl: 12, lsl: null, target: null, unit: 'mm' };
    const ppm = computePpm(10, 1, uslOnly);
    expect(ppm).toBe(Math.round(qaPhi(-2) * 1e6));
  });
});

describe('QA-7 控制限公式独立复算', () => {
  const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i * 0.7) * 0.3 + (i % 5) * 0.05);

  it('Xbar-R：CL/UCL/LCL 与 A2/D4/D3 独立复算', () => {
    const sg = qaSubgroups(values, 5);
    const rBar = sg.reduce((a, g) => a + g.range, 0) / sg.length;
    const xBar = sg.reduce((a, g) => a + g.mean, 0) / sg.length;
    const series = buildXbarR(buildSubgroups(toMeas(values), { mode: 'fixed', capacity: 5 }));
    const cl = series.limits.primary.find((l) => l.label === 'CL')!;
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const lcl = series.limits.primary.find((l) => l.label === 'LCL')!;
    expect(cl.values[0]).toBeCloseTo(xBar, 10);
    expect(ucl.values[0]).toBeCloseTo(xBar + 0.577 * rBar, 10); // A2(5)=0.577
    expect(lcl.values[0]).toBeCloseTo(xBar - 0.577 * rBar, 10);
    const rUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    expect(rUcl.values[0]).toBeCloseTo(2.114 * rBar, 10); // D4(5)=2.114
    // D3(5) 无定义 → R 图不画 LCL
    expect(series.limits.secondary!.find((l) => l.label === 'LCL')).toBeUndefined();
  });

  it('Xbar-S：B4/B3 与 A3 独立复算，n=15', () => {
    const v15 = values.slice(0, 45);
    const sg = qaSubgroupsWithTail(v15, 15);
    const sBar = sg.reduce((a, g) => a + g.std, 0) / sg.length;
    const xBar = sg.reduce((a, g) => a + g.mean, 0) / sg.length;
    const series = buildXbarS(buildSubgroups(toMeas(v15), { mode: 'fixed', capacity: 15 }));
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.values[0]).toBeCloseTo(xBar + 0.789 * sBar, 10); // A3(15)=0.789
    const sUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    expect(sUcl.values[0]).toBeCloseTo(1.572 * sBar, 10); // B4(15)=1.572
    const sLcl = series.limits.secondary!.find((l) => l.label === 'LCL')!;
    expect(sLcl.values[0]).toBeCloseTo(0.428 * sBar, 10); // B3(15)=0.428
  });

  it('I-MR：E2(2)=2.66 与 D4(2)=3.267 独立复算；MR 图无 LCL', () => {
    const vals = values.slice(0, 20);
    const xBar = qaMean(vals);
    const mr: number[] = [];
    for (let i = 1; i < vals.length; i += 1) mr.push(Math.abs(vals[i] - vals[i - 1]));
    const mrBar = mr.reduce((a, b) => a + b, 0) / mr.length;
    const series = buildImr(vals);
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    expect(ucl.values[0]).toBeCloseTo(xBar + 2.66 * mrBar, 10);
    const mrUcl = series.limits.secondary!.find((l) => l.label === 'UCL')!;
    expect(mrUcl.values[0]).toBeCloseTo(3.267 * mrBar, 10);
    expect(series.limits.secondary!.find((l) => l.label === 'LCL')).toBeUndefined();
  });

  it('P 图变限：逐点 σ_i 独立复算（重点）', () => {
    const d = [5, 12, 8, 20];
    const n = [100, 120, 90, 150];
    const pBar = d.reduce((a, b) => a + b, 0) / n.reduce((a, b) => a + b, 0);
    const series = buildP({ defectivesOrDefects: d, sampleSizes: n });
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    const lcl = series.limits.primary.find((l) => l.label === 'LCL')!;
    const cl = series.limits.primary.find((l) => l.label === 'CL')!;
    for (let i = 0; i < n.length; i += 1) {
      const se = Math.sqrt((pBar * (1 - pBar)) / n[i]);
      expect(cl.values[i], `CL[${i}]`).toBeCloseTo(pBar, 12);
      expect(ucl.values[i], `UCL[${i}]`).toBeCloseTo(pBar + 3 * se, 12);
      expect(lcl.values[i], `LCL[${i}]`).toBeCloseTo(Math.max(0, pBar - 3 * se), 12);
    }
    expect(ucl.isConstant).toBe(false);
  });

  it('U 图变限：逐点 σ_i 独立复算', () => {
    const c = [3, 7, 2, 9];
    const n = [10, 12, 8, 15];
    const uBar = c.reduce((a, b) => a + b, 0) / n.reduce((a, b) => a + b, 0);
    const series = buildU({ defectivesOrDefects: c, sampleSizes: n });
    const ucl = series.limits.primary.find((l) => l.label === 'UCL')!;
    for (let i = 0; i < n.length; i += 1) {
      expect(ucl.values[i], `UCL[${i}]`).toBeCloseTo(uBar + 3 * Math.sqrt(uBar / n[i]), 12);
    }
  });

  it('NP/C 恒定限独立复算', () => {
    const d = [4, 6, 5, 7, 3];
    const n = [50, 50, 50, 50, 50];
    const npBar = qaMean(d);
    const pBar = npBar / 50;
    const npSeries = buildNp({ defectivesOrDefects: d, sampleSizes: n });
    expect(npSeries.limits.primary.find((l) => l.label === 'UCL')!.values[0]).toBeCloseTo(
      npBar + 3 * Math.sqrt(npBar * (1 - pBar)),
      12,
    );
    const cData = [3, 5, 2, 6, 4];
    const cBar = qaMean(cData);
    const cSeries = buildC({ defectivesOrDefects: cData, sampleSizes: [1, 1, 1, 1, 1] });
    expect(cSeries.limits.primary.find((l) => l.label === 'UCL')!.values[0]).toBeCloseTo(
      cBar + 3 * Math.sqrt(cBar),
      12,
    );
  });
});

describe('QA-8 正态性检验对拍标准算例', () => {
  it('经典正态样本应判正态（p>=0.05）', () => {
    // 排序后的已知近似正态样本
    const normal = [
      -1.65, -1.32, -1.05, -0.87, -0.68, -0.52, -0.36, -0.21, -0.07, 0.07, 0.21, 0.36, 0.52, 0.68, 0.87, 1.05, 1.32,
      1.65, -0.95, 0.95, -0.45, 0.45, -0.15, 0.15, -0.75, 0.75, -1.2, 1.2, -0.3, 0.3,
    ];
    const ad = andersonDarling(normal);
    expect(ad.pValue).toBeGreaterThanOrEqual(0.05);
    expect(ad.isNormal).toBe(true);
  });

  it('强偏态样本应判非正态（p<0.05）', () => {
    const skew = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 4, 5, 8, 12, 20, 40];
    const ad = andersonDarling(skew);
    expect(ad.pValue).toBeLessThan(0.05);
    expect(ad.isNormal).toBe(false);
  });

  it('S-W 对正态样本 p>=0.05、对强偏态 p<0.05', () => {
    const normal = [
      -1.65, -1.32, -1.05, -0.87, -0.68, -0.52, -0.36, -0.21, -0.07, 0.07, 0.21, 0.36, 0.52, 0.68, 0.87, 1.05, 1.32,
      1.65, -0.95, 0.95, -0.45, 0.45, -0.15, 0.15, -0.75, 0.75, -1.2, 1.2, -0.3, 0.3,
    ];
    expect(shapiroWilk(normal).pValue).toBeGreaterThanOrEqual(0.05);
    const skew = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 3, 4, 5, 8, 12, 20, 40];
    expect(shapiroWilk(skew).pValue).toBeLessThan(0.05);
  });
});
