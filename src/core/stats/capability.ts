/**
 * 过程能力指数：Ca / Cp / Cpk / Pp / Ppk / 双西格玛水平 / PPM。
 *
 * 出处：PRD §4.2（公式为正确性底线）；AIAG SPC 手册第 4 版 §I.2；
 * σ_within 由 R̄/d2 或 S̄/c4 估计（AIAG SPC 手册 §I.1）。
 *
 * 关键修正（相对旧工具 spc.py）：
 * 旧工具 `std_sub = std_total` 导致 Pp 恒等于 Cp；本模块严格区分
 * σ_within（组内，用于 Cp/Cpk）与 σ_overall（整体 ddof=1，用于 Pp/Ppk）。
 *
 * 空值语义：不可计算量一律返回 `null`，禁止用 0 或 999 冒充。
 */

import type {
  CapabilityResult,
  CapabilityWarning,
  SigmaEstimate,
  SigmaMode,
  SpecLimits,
  SubgroupStats,
} from '../types';
import { getC4, getD2 } from '../constants/controlChartConstants';
import { maxOf } from '../math/matrix';
import { normalCdf } from '../math/normalCdf';
import { mean as meanOf, stdDev } from './descriptive';
import { assertValidSpec } from './specLimits';

/** d2(n=2) 用于 I-MR 移动极差估计组内 σ（AIAG SPC 手册 Appendix E）。 */
const D2_N2 = 1.128;

/** 选项。 */
export interface CapabilityOptions {
  /** 显式指定组内 σ 估计法；未指定时按子组容量自动选择（n<=10 R 法，n>10 S 法）。 */
  sigmaMode?: SigmaMode;
  /** 无子组结构时是否允许 I-MR 降级（σ_within = MR̄/1.128）。默认 true。 */
  useImrFallback?: boolean;
}

/**
 * 计算移动极差均值 MR̄ = Σ|v_{i+1} - v_i| / (n-1)。
 *
 * @throws {RangeError} 数值数组长度 < 2
 */
export function movingRangeMean(values: number[]): number {
  if (values.length < 2) {
    throw new RangeError(`移动极差要求至少 2 个值，收到 ${values.length}。`);
  }
  let s = 0;
  for (let i = 1; i < values.length; i += 1) {
    s += Math.abs(values[i] - values[i - 1]);
  }
  return s / (values.length - 1);
}

/**
 * 估计组内标准差 σ_within。
 *
 * 出处：AIAG SPC 手册第 4 版 §I.1。
 * - 有子组：n<=10 用 R 法 σ=R̄/d2(n)；n>10 用 S 法 σ=S̄/c4(n)。
 *   子组容量混合时按 max(n) 选法（并加 MIXED 告警由调用方判断）。
 * - 无子组（每子组 n=1 或空）：I-MR 降级 σ = MR̄ / d2(2) = MR̄ / 1.128。
 *
 * @throws {RangeError} 子组容量越界（常数表 2..25）
 */
export function estimateSigmaWithin(
  values: number[],
  subgroups: SubgroupStats[],
  opts?: CapabilityOptions,
): SigmaEstimate {
  const overall = values.length >= 2 ? stdDev(values, 1) : 0;
  const usable = subgroups.filter((g) => g.size >= 2);

  if (usable.length === 0) {
    // 无子组结构 → I-MR 降级
    if (values.length < 2) {
      return { mode: 'IMR', within: 0, overall, basis: 'IMR', mrBar: 0 };
    }
    const mrBar = movingRangeMean(values);
    return {
      mode: 'IMR',
      within: mrBar / D2_N2,
      overall,
      basis: 'IMR',
      mrBar,
    };
  }

  // 按 max(n) 选 R/S 法
  const maxN = maxOf(usable.map((g) => g.size));
  const mode: SigmaMode = opts?.sigmaMode ?? (maxN <= 10 ? 'R' : 'S');

  if (mode === 'R') {
    const rBar = usable.reduce((acc, g) => acc + g.range, 0) / usable.length;
    const d2 = getD2(maxN);
    return { mode: 'R', within: rBar / d2, overall, basis: 'R', rBar };
  }

  const sBar = usable.reduce((acc, g) => acc + g.std, 0) / usable.length;
  const c4 = getC4(maxN);
  return { mode: 'S', within: sBar / c4, overall, basis: 'S', sBar };
}

/**
 * 基于某 sigma 口径计算双侧期望 PPM。
 *
 * 出处：PRD §4.2；正态分布双侧尾部面积 × 1e6。
 * 单侧规格时只算存在的一侧。
 *
 * @returns PPM（整数四舍五入）；sigma<=0 或规格完全缺失时返回 null
 */
export function computePpm(mu: number, sigma: number, spec: SpecLimits): number | null {
  if (sigma <= 0) {
    return null;
  }
  if (spec.usl === null && spec.lsl === null) {
    return null;
  }
  let tail = 0;
  if (spec.usl !== null) {
    const zUsl = (spec.usl - mu) / sigma;
    tail += normalCdf(-zUsl);
  }
  if (spec.lsl !== null) {
    const zLsl = (spec.lsl - mu) / sigma;
    tail += normalCdf(zLsl);
  }
  return Math.round(tail * 1e6);
}

/**
 * 计算完整过程能力指数。
 *
 * 出处：PRD §4.2。
 * - Ca = (μ - M) / ((USL-LSL)/2)（可正可负）
 * - Cp = (USL-LSL)/(6σ_within)，Cpk = min((USL-μ)/(3σ_within), (μ-LSL)/(3σ_within))
 * - Pp = (USL-LSL)/(6σ_overall)，Ppk = min((USL-μ)/(3σ_overall), (μ-LSL)/(3σ_overall))
 * - sigmaLevelShort = 3·Cpk；sigmaLevelBench = 3·Cpk + 1.5
 *
 * @param values 有效测量值（已剔除 excluded，未越过空值）
 * @param spec 规格限（单侧时另一侧为 null）
 * @param subgroups 子组统计
 * @param opts 选项
 */
export function computeCapability(
  values: number[],
  spec: SpecLimits,
  subgroups: SubgroupStats[],
  opts?: CapabilityOptions,
): CapabilityResult {
  assertValidSpec(spec);

  const warnings: CapabilityWarning[] = [];
  const n = values.length;

  if (n === 0) {
    throw new RangeError('computeCapability 输入测量值不能为空。');
  }

  const mu = meanOf(values);
  const sigma = estimateSigmaWithin(values, subgroups, opts);

  const twoSided = spec.usl !== null && spec.lsl !== null && spec.usl > spec.lsl;
  const oneSided = (spec.usl !== null) !== (spec.lsl !== null);

  if (!twoSided) {
    warnings.push('ONLY_ONE_SIDED_SPEC');
  }
  if (sigma.basis === 'IMR') {
    warnings.push('NO_SUBGROUP_STRUCTURE');
  }
  if (n < 30) {
    warnings.push('INSUFFICIENT_SAMPLE');
  }

  const withinZero = sigma.within <= 0;
  const overallZero = sigma.overall <= 0;
  if (withinZero) {
    warnings.push('SIGMA_WITHIN_ZERO');
  }

  // 规格中心与半宽
  const specMid = twoSided ? (spec.usl! + spec.lsl!) / 2 : null;
  const halfWidth = twoSided ? (spec.usl! - spec.lsl!) / 2 : null;

  // Ca：有符号准确度；仅双侧有定义
  const ca = specMid !== null && halfWidth !== null && halfWidth !== 0
    ? (mu - specMid) / halfWidth
    : null;

  // Cp / Cpk（σ_within）
  let cp: number | null = null;
  let cpu: number | null = null;
  let cpl: number | null = null;
  let cpk: number | null = null;

  if (twoSided && !withinZero) {
    cp = (spec.usl! - spec.lsl!) / (6 * sigma.within);
  }
  if (!withinZero) {
    if (spec.usl !== null) {
      cpu = (spec.usl - mu) / (3 * sigma.within);
    }
    if (spec.lsl !== null) {
      cpl = (mu - spec.lsl) / (3 * sigma.within);
    }
    if (cpu !== null && cpl !== null) {
      cpk = Math.min(cpu, cpl);
    } else if (cpu !== null) {
      cpk = cpu;
    } else if (cpl !== null) {
      cpk = cpl;
    }
  }

  // Pp / Ppk（σ_overall）
  let pp: number | null = null;
  let ppu: number | null = null;
  let ppl: number | null = null;
  let ppk: number | null = null;

  if (twoSided && !overallZero) {
    pp = (spec.usl! - spec.lsl!) / (6 * sigma.overall);
  }
  if (!overallZero) {
    if (spec.usl !== null) {
      ppu = (spec.usl - mu) / (3 * sigma.overall);
    }
    if (spec.lsl !== null) {
      ppl = (mu - spec.lsl) / (3 * sigma.overall);
    }
    if (ppu !== null && ppl !== null) {
      ppk = Math.min(ppu, ppl);
    } else if (ppu !== null) {
      ppk = ppu;
    } else if (ppl !== null) {
      ppk = ppl;
    }
  }

  const sigmaLevelShort = cpk !== null ? 3 * cpk : null;
  const sigmaLevelBench = cpk !== null ? 3 * cpk + 1.5 : null;

  const ppmOverall = computePpm(mu, sigma.overall, spec);
  const ppmWithin = computePpm(mu, sigma.within, spec);

  // 单侧规格时 Cp/Pp 无定义已置 null；明确告警。
  if (oneSided && !warnings.includes('ONLY_ONE_SIDED_SPEC')) {
    warnings.push('ONLY_ONE_SIDED_SPEC');
  }

  return {
    n,
    mean: mu,
    sigma,
    spec,
    ca,
    cp,
    cpk,
    cpu,
    cpl,
    pp,
    ppk,
    ppu,
    ppl,
    sigmaLevelShort,
    sigmaLevelBench,
    ppmOverall,
    ppmWithin,
    warnings,
  };
}
