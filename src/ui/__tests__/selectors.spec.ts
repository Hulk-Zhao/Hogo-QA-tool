/**
 * selectors store 测试（架构文档 §5 派生计算）。
 *
 * 覆盖：selectCapability 的 memo 行为、无子组结构告警透传、
 * 空特性返回 null。不重复验证 core 公式（T01 职责）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectCapability,
  clearCapabilityCache,
  buildSubgroupConfig,
  manualBoundariesFromCapacity,
  fingerprintKey,
  type AnalysisConfigFingerprint,
} from '@/store/selectors';
import type { Characteristic, Measurement } from '@/data/schema';

function makeChar(name: string, values: number[]): Characteristic {
  const measurements: Measurement[] = values.map((v, i) => ({
    id: `m-${name}-${i}`,
    characteristicId: 'ch-test',
    value: v,
    subgroupId: null,
    timestamp: null,
    batch: null,
    excluded: false,
    excludeReason: null,
  }));
  return {
    id: 'ch-test',
    datasetId: 'ds-test',
    name,
    specLimits: { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' },
    measurements,
    subgroups: [],
    nullCount: 0,
    outlierFlags: [],
    preprocessConfigRef: null,
    measurementBlobRef: null,
  };
}

const FP: AnalysisConfigFingerprint = {
  subgroupMode: 'fixed',
  subgroupCapacity: 5,
  manualBoundaries: [],
  sigmaMode: 'R',
  spec: { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' },
};

describe('selectCapability', () => {
  beforeEach(() => clearCapabilityCache());

  it('空特性返回 null', () => {
    expect(selectCapability(null, FP)).toBeNull();
  });

  it('返回 values / subgroups / capability / normality / histogram', () => {
    const values = [10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01, 9.96, 10.03, 10.02, 9.98, 10.0];
    const result = selectCapability(makeChar('a', values), FP);
    expect(result).not.toBeNull();
    expect(result?.values.length).toBe(values.length);
    expect(result?.capability.n).toBe(values.length);
    expect(result?.histogram.bins.length).toBeGreaterThan(0);
    expect(result?.normality.primary).toBeDefined();
  });

  it('memo：相同输入返回同一对象引用', () => {
    const values = [10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01];
    const char = makeChar('b', values);
    const first = selectCapability(char, FP);
    const second = selectCapability(char, FP);
    expect(first).toBe(second);
  });

  it('排除测量值后参与计算的值减少', () => {
    const values = [10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01];
    const char = makeChar('c', values);
    char.measurements[0].excluded = true;
    const result = selectCapability(char, FP);
    expect(result?.values.length).toBe(values.length - 1);
  });

  it('样本不足时透传 INSUFFICIENT_SAMPLE 告警', () => {
    // 3 个值 → n<30 → 告警
    const char = makeChar('small', [10.0, 10.1, 9.9]);
    const result = selectCapability(char, FP);
    expect(result?.capability.warnings).toContain('INSUFFICIENT_SAMPLE');
  });

  it('无子组结构（单一残余值）走 I-MR 降级并透传 NO_SUBGROUP_STRUCTURE 告警', () => {
    // 1 个值无法构成 n>=2 子组 → 无子组结构 → IMR 降级
    const char = makeChar('single', [10.0]);
    const result = selectCapability(char, FP);
    expect(result?.capability.sigma.basis).toBe('IMR');
    expect(result?.capability.warnings).toContain('NO_SUBGROUP_STRUCTURE');
  });
});

describe('buildSubgroupConfig / manualBoundariesFromCapacity', () => {
  it('fixed 模式返回容量', () => {
    expect(buildSubgroupConfig(FP, 30)).toEqual({ mode: 'fixed', capacity: 5 });
  });

  it('manual 模式无边界时按容量推导', () => {
    const fp: AnalysisConfigFingerprint = { ...FP, subgroupMode: 'manual' };
    expect(buildSubgroupConfig(fp, 12)).toEqual({ mode: 'manual', manualBoundaries: [0, 5, 10] });
  });

  it('manualBoundariesFromCapacity 生成升序起始索引', () => {
    expect(manualBoundariesFromCapacity(12, 5)).toEqual([0, 5, 10]);
    expect(manualBoundariesFromCapacity(0, 5)).toEqual([0]);
  });
});

describe('fingerprintKey', () => {
  it('配置变化产生不同键', () => {
    const k1 = fingerprintKey(FP, 1);
    const k2 = fingerprintKey({ ...FP, subgroupCapacity: 4 }, 1);
    expect(k1).not.toBe(k2);
  });

  it('相同配置与版本产生相同键', () => {
    expect(fingerprintKey(FP, 1)).toBe(fingerprintKey(FP, 1));
  });
});
