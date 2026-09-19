/**
 * 柏拉图（帕累托图）聚合与累计占比。
 *
 * 出处：Pareto 分析定义（Juran）；PRD P0-17 与基准文档预期
 * （前 3 项累计 81.50%，第 3 项跨越 80% 分界线）。
 */

import type { DefectRecordInput, ParetoItem, ParetoResult } from '../types';

/** 默认合并阈值（“其他”类的占比）。 */
export const DEFAULT_OTHER_THRESHOLD = 0.05;

/** 默认 80% 分界线。 */
export const DEFAULT_CROSSING_THRESHOLD = 80;

/**
 * 聚合缺陷记录并构造柏拉图数据。
 *
 * @param records 缺陷记录（可为多条同 defectType）
 * @param threshold 80% 分界线阈值，默认 80（单位 %）
 * @param otherLabel 「其他」标签，默认 '其他'
 * @param otherThreshold 低于此占比（相对 max）的类型合并为「其他」，默认 0.05；传 0 关闭合并
 * @returns 柏拉图结果（降序）
 */
export function buildPareto(
  records: DefectRecordInput[],
  threshold = DEFAULT_CROSSING_THRESHOLD,
  otherLabel = '其他',
  otherThreshold = DEFAULT_OTHER_THRESHOLD,
): ParetoResult {
  // 按 defectType 聚合
  const agg = new Map<string, number>();
  for (const r of records) {
    agg.set(r.defectType, (agg.get(r.defectType) ?? 0) + r.count);
  }

  let entries = Array.from(agg.entries())
    .map(([defectType, count]) => ({ defectType, count }))
    .sort((a, b) => b.count - a.count);

  const grandTotal = entries.reduce((acc, e) => acc + e.count, 0);

  // 合并小项为「其他」
  if (otherThreshold > 0 && entries.length > 0) {
    const maxCount = entries[0].count;
    const main: { defectType: string; count: number }[] = [];
    let otherCount = 0;
    for (const e of entries) {
      if (e.count / maxCount < otherThreshold) {
        otherCount += e.count;
      } else {
        main.push(e);
      }
    }
    if (otherCount > 0) {
      main.push({ defectType: otherLabel, count: otherCount });
      entries = main.sort((a, b) => b.count - a.count);
    }
  }

  const total = entries.reduce((acc, e) => acc + e.count, 0);

  const items: ParetoItem[] = [];
  let cum = 0;
  let crossingIndex: number | null = null;

  entries.forEach((e, idx) => {
    const ratio = total > 0 ? (e.count / total) * 100 : 0;
    cum += ratio;
    const isOther = e.defectType === otherLabel;
    if (crossingIndex === null && cum >= threshold) {
      crossingIndex = idx;
    }
    items.push({
      defectType: e.defectType,
      count: e.count,
      ratio,
      cumRatio: cum,
      isOther,
    });
  });

  return {
    items,
    total: grandTotal,
    crossingIndex,
    threshold,
  };
}
