/**
 * 导入规模上限常量（架构文档 §0.2 决策 #9 / §性能上限）。
 *
 * 「首期支持 ≤ 20 万测量值；超过时提示并建议分批导入。」
 *
 * 注意语义：**仅提示，不阻断**。超限时保留全部数据、照常建模，
 * 只向 `warnings` 追加一条提示。严禁截断数据或抛错 ——
 * 质量数据静默截断会导致能力指数算错，比不提示更危险。
 *
 * 阈值在此定义**唯一一份**，xlsx / csv / clipboard 三条导入路径共用。
 */

import type { SubgroupMode } from '@/core/types';

/** 首期支持的测量值条数上限（含）。 */
export const MAX_MEASUREMENTS = 200_000;

/** 子组划分模式 → 中文名（用于提示文案）。 */
const MODE_LABELS: Record<SubgroupMode, string> = {
  fixed: '固定容量分组',
  byColumn: '按列分组',
  manual: '手动分组',
};

/**
 * 测量值条数的超限提示文案。
 *
 * 命中正则 `/20\s*万|200000|上限|分批|超出/` 的语义要求，
 * 保证 QA 断言与 UI 均可稳定识别。
 *
 * @param count 实际测量值条数
 * @param source 数据来源描述（如「xlsx 文件」「CSV / 粘贴文本」）
 * @returns 超限提示；未超限返回 null
 */
export function measurementLimitWarning(count: number, source: string): string | null {
  if (count <= MAX_MEASUREMENTS) {
    return null;
  }
  return (
    `${source}解析出 ${count} 条测量值，超出首期支持上限 20 万条（200000）。` +
    '建议分批导入后分别分析，以避免浏览器内存压力导致计算缓慢或页面无响应。'
  );
}

/** 组容量过大提示文案（供后续子组阶段复用）。 */
export function subgroupCapacityWarning(mode: SubgroupMode, capacity: number): string | null {
  if (mode !== 'fixed' || capacity <= 25) {
    return null;
  }
  return `子组容量 n=${capacity} 超出常用范围（2..25），控制图常数表不支持，请调整分组方式。`;
}

/** 分组模式显示名（转发，避免调用方重复维护映射）。 */
export function subgroupModeLabel(mode: SubgroupMode): string {
  return MODE_LABELS[mode] ?? mode;
}
