/**
 * 能力指数回归测试（架构文档 §7 T01 验收要点 3、§0.2 #11）。
 *
 * ★ 回归基准断言：用**真实基准数据**（旧版 Python 工具的 quality_data.xlsx（现随仓库提供：`src/data/__tests__/fixtures/quality_data.xlsx`）
 * 的 dimension 工作表，3 个物料各 50 条测量值）计算，**在未剔除异常值的前提下**，
 * `Ppk` 必须与 `docs/01-基准数据与验证口径.md` 的 Cpk 吻合（误差 <= 0.001）。
 * Cp/Cpk 因 σ_within 与 σ_overall 口径不同允许不等（这正是修正旧工具缺陷的体现）。
 */

import { describe, expect, it } from 'vitest';
import { computeCapability, computePpm, estimateSigmaWithin } from '../stats/capability';
import { buildSubgroups } from '../stats/subgrouping';
import { stdDev, mean } from '../stats/descriptive';
import { BENCHMARK_CHARACTERISTICS } from './fixtures/sampleDimension';
import type { MeasurementInput, SpecLimits } from '../types';

function toMeasurements(values: number[]): MeasurementInput[] {
  return values.map((v, i) => ({ id: `M-${i}`, value: v }));
}

describe('computeCapability —— 基准数据 Ppk 回归（未剔除异常值）', () => {
  it.each(BENCHMARK_CHARACTERISTICS)(
    '$name：Ppk 与基准文档 Cpk 吻合（<=0.001）',
    (bench) => {
      const measurements = toMeasurements(bench.values);
      // 子组 n=5（PRD 默认），供 σ_within 使用；Ppk 用 σ_overall 与其无关。
      const subgroups = buildSubgroups(measurements, { mode: 'fixed', capacity: 5 });
      const result = computeCapability(
        bench.values,
        bench.spec,
        subgroups,
        { sigmaMode: 'R' },
      );

      // 均值与整体标准差应与真实数据实测值一致
      // （benchmarkSd 为实测值，记录到 8 位小数，故容差取 1e-8）
      expect(result.n).toBe(50);
      expect(Math.abs(result.mean - bench.benchmarkMean)).toBeLessThan(1e-8);
      expect(Math.abs(result.sigma.overall - bench.benchmarkSd)).toBeLessThan(1e-8);

      // ★ 核心回归断言：Ppk ≈ 基准 Cpk
      expect(result.ppk).not.toBeNull();
      expect(Math.abs(result.ppk! - bench.benchmarkPpk)).toBeLessThanOrEqual(0.001);

      // Cp/Cpk 因组内 σ 口径不同，允许不等（此处仅断言其存在且为正）
      expect(result.cpk).not.toBeNull();
      expect(result.cpk!).toBeGreaterThan(0);
    },
  );

  it('显式断言：新版 Cp 与 Ppk 口径分离（Pp 不再恒等于 Cpk）', () => {
    const bench = BENCHMARK_CHARACTERISTICS[1]; // 转轴直径
    const measurements = toMeasurements(bench.values);
    const subgroups = buildSubgroups(measurements, { mode: 'fixed', capacity: 5 });
    const result = computeCapability(bench.values, bench.spec, subgroups, { sigmaMode: 'R' });
    // 修正旧工具 std_sub = std_total 缺陷：Pp 由 σ_overall、Cp 由 σ_within
    expect(result.pp).not.toBeNull();
    expect(result.cp).not.toBeNull();
    // σ_within 与 σ_overall 通常不等，故 Pp 与 Cp 通常不等
    expect(Math.abs(result.sigma.within - result.sigma.overall)).toBeGreaterThan(1e-9);
  });
});

describe('computeCapability —— 双口径与西格玛水平', () => {
  it('西格玛水平为 3*Cpk 与 3*Cpk+1.5', () => {
    const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 0.1);
    const subgroups = buildSubgroups(toMeasurements(values), { mode: 'fixed', capacity: 5 });
    const spec: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10, unit: 'mm' };
    const r = computeCapability(values, spec, subgroups);
    expect(r.sigmaLevelShort).toBeCloseTo(3 * r.cpk!, 10);
    expect(r.sigmaLevelBench).toBeCloseTo(3 * r.cpk! + 1.5, 10);
  });

  it('单侧规格：Cp/Pp 返回 null（不得用 0/999 冒充）', () => {
    const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 0.1);
    const subgroups = buildSubgroups(toMeasurements(values), { mode: 'fixed', capacity: 5 });
    const spec: SpecLimits = { usl: 10.5, lsl: null, target: null, unit: 'mm' };
    const r = computeCapability(values, spec, subgroups);
    expect(r.cp).toBeNull();
    expect(r.pp).toBeNull();
    expect(r.cpk).not.toBeNull();
    expect(r.ppk).not.toBeNull();
    expect(r.warnings).toContain('ONLY_ONE_SIDED_SPEC');
  });

  it('无子组结构：降级 I-MR 并告警，Cp/Cpk 仍可算（用 IMR 口径）', () => {
    const values = Array.from({ length: 50 }, (_, i) => 10 + Math.sin(i) * 0.1);
    const spec: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10, unit: 'mm' };
    const r = computeCapability(values, spec, []);
    expect(r.sigma.basis).toBe('IMR');
    expect(r.warnings).toContain('NO_SUBGROUP_STRUCTURE');
    expect(r.cpk).not.toBeNull();
  });

  it('σ 为 0 时对应指数为 null 且带 SIGMA_WITHIN_ZERO 告警', () => {
    const values = new Array<number>(50).fill(10);
    const spec: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10, unit: 'mm' };
    const r = computeCapability(values, spec, []);
    expect(r.sigma.within).toBe(0);
    expect(r.cpk).toBeNull();
    expect(r.ppk).toBeNull();
    expect(r.warnings).toContain('SIGMA_WITHIN_ZERO');
    expect(r.ppmOverall).toBeNull();
  });

  it('USL <= LSL 抛 TypeError', () => {
    const values = [1, 2, 3, 4, 5];
    const spec: SpecLimits = { usl: 1, lsl: 10, target: null, unit: 'mm' };
    expect(() => computeCapability(values, spec, [])).toThrow(TypeError);
  });

  it('空测量值抛 RangeError', () => {
    const spec: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10, unit: 'mm' };
    expect(() => computeCapability([], spec, [])).toThrow(RangeError);
  });
});

describe('estimateSigmaWithin', () => {
  it('n<=10 用 R 法：σ_within = R̄/d2', () => {
    const values = Array.from({ length: 50 }, (_, i) => 10 + (i % 5) * 0.1);
    const subgroups = buildSubgroups(toMeasurements(values), { mode: 'fixed', capacity: 5 });
    const est = estimateSigmaWithin(values, subgroups);
    expect(est.basis).toBe('R');
    expect(est.mode).toBe('R');
    expect(est.rBar).toBeGreaterThan(0);
  });

  it('n>10 用 S 法：σ_within = S̄/c4', () => {
    const values = Array.from({ length: 60 }, (_, i) => 10 + Math.sin(i) * 0.5);
    const subgroups = buildSubgroups(toMeasurements(values), { mode: 'fixed', capacity: 15 });
    const est = estimateSigmaWithin(values, subgroups);
    expect(est.basis).toBe('S');
    expect(est.mode).toBe('S');
    expect(est.sBar).toBeGreaterThan(0);
  });
});

describe('computePpm', () => {
  it('双侧 PPM = (Φ(-zUSL)+Φ(zLSL))*1e6', () => {
    const spec: SpecLimits = { usl: 12, lsl: 8, target: 10, unit: 'mm' };
    const ppm = computePpm(10, 1, spec); // z=±2 → 双侧约 45500
    expect(ppm).not.toBeNull();
    expect(ppm!).toBeGreaterThan(40000);
    expect(ppm!).toBeLessThan(50000);
  });

  it('σ<=0 返回 null', () => {
    const spec: SpecLimits = { usl: 12, lsl: 8, target: 10, unit: 'mm' };
    expect(computePpm(10, 0, spec)).toBeNull();
  });

  it('规格全缺失返回 null', () => {
    const spec: SpecLimits = { usl: null, lsl: null, target: null, unit: 'mm' };
    expect(computePpm(10, 1, spec)).toBeNull();
  });
});

describe('描述性统计一致性（真实数据实测值）', () => {
  it('整体标准差 ddof=1 与实测 sd 一致（记录精度 1e-8）', () => {
    for (const bench of BENCHMARK_CHARACTERISTICS) {
      expect(Math.abs(stdDev(bench.values, 1) - bench.benchmarkSd)).toBeLessThan(1e-8);
      expect(Math.abs(mean(bench.values) - bench.benchmarkMean)).toBeLessThan(1e-8);
    }
  });
});
