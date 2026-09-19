/**
 * 正态性检验统一入口。
 *
 * 出处：架构文档 §10.3；PRD §4.4（n<=50 优先展示 S-W，否则 AD）。
 */

import type { NormalityResult } from '../types';
import { andersonDarling } from './andersonDarling';
import { SW_MAX_N, shapiroWilk } from './shapiroWilk';

export interface NormalityTestBundle {
  /** 主方法结果（n<=50 → SW；否则 AD） */
  primary: NormalityResult;
  ad: NormalityResult;
  sw: NormalityResult | null;
}

/**
 * 执行正态性检验。
 *
 * @param values 数值数组
 * @returns { primary, ad, sw } —— n>5000 时 sw 为 null
 */
export function testNormality(values: number[]): NormalityTestBundle {
  const ad = andersonDarling(values);
  const sw = values.length <= SW_MAX_N ? shapiroWilk(values) : null;
  const primary = values.length <= 50 && sw ? sw : ad;
  return { primary, ad, sw };
}

/**
 * 生成 UI 判定文案（PRD §4.4）。
 *
 * @param result 主方法结果
 * @returns 中文结论文案
 */
export function normalityConclusion(result: NormalityResult): string {
  if (!Number.isFinite(result.pValue)) {
    return result.note ?? '无法判定正态性';
  }
  if (result.pValue < 0.05) {
    return `数据非正态（${result.method} p=${result.pValue.toFixed(4)}），Cpk/PPM 基于正态假设，建议参考非正态能力分析（Box-Cox / 非参数）`;
  }
  return `未拒绝正态假设（${result.method} p=${result.pValue.toFixed(4)}）`;
}

export { andersonDarling, adPValue } from './andersonDarling';
export { shapiroWilk, swPValue, shapiroWilkCoefficients, SW_MAX_N } from './shapiroWilk';
