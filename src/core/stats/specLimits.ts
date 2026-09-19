/**
 * 规格限有效性判定。
 *
 * 出处：能力指数定义要求 USL > LSL；单侧规格时另一侧为 null。
 */

import type { SpecLimits } from '../types';

/** 判定规格限是否双侧且有效（USL 与 LSL 均给出且 USL > LSL）。 */
export function isTwoSidedSpec(spec: SpecLimits): boolean {
  return spec.usl !== null && spec.lsl !== null && spec.usl > spec.lsl;
}

/** 判定规格限是否仅有单侧（恰好一侧给出）。 */
export function isOneSidedSpec(spec: SpecLimits): boolean {
  const hasUsl = spec.usl !== null;
  const hasLsl = spec.lsl !== null;
  return hasUsl !== hasLsl;
}

/** 判定规格限是否完全无效（两侧均缺失）。 */
export function isMissingSpec(spec: SpecLimits): boolean {
  return spec.usl === null && spec.lsl === null;
}

/**
 * 校验规格限：USL/LSL 若存在必须为有限数，且 USL > LSL（双侧时）。
 *
 * @throws {TypeError} 规格限非法
 */
export function assertValidSpec(spec: SpecLimits): void {
  if (spec.usl !== null && !Number.isFinite(spec.usl)) {
    throw new TypeError(`USL 必须为有限数或 null，收到 ${spec.usl}。`);
  }
  if (spec.lsl !== null && !Number.isFinite(spec.lsl)) {
    throw new TypeError(`LSL 必须为有限数或 null，收到 ${spec.lsl}。`);
  }
  if (spec.target !== null && !Number.isFinite(spec.target)) {
    throw new TypeError(`target 必须为有限数或 null，收到 ${spec.target}。`);
  }
  if (spec.usl !== null && spec.lsl !== null && spec.usl <= spec.lsl) {
    throw new TypeError(`USL(${spec.usl}) 必须大于 LSL(${spec.lsl})。`);
  }
}

/**
 * 规格中心 M = (USL + LSL) / 2；单侧或缺失时返回 null。
 */
export function specCenter(spec: SpecLimits): number | null {
  if (spec.usl === null || spec.lsl === null) {
    return null;
  }
  return (spec.usl + spec.lsl) / 2;
}

/**
 * 规格半宽 (USL - LSL) / 2；单侧或缺失时返回 null。
 */
export function specHalfWidth(spec: SpecLimits): number | null {
  if (spec.usl === null || spec.lsl === null) {
    return null;
  }
  return (spec.usl - spec.lsl) / 2;
}
