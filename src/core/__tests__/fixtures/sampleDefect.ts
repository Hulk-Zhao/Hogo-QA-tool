/**
 * 基准数据 fixture（defect sheet）——**真实数据**。
 *
 * 数据来源：旧版 Python 工具的 quality_data.xlsx（现随仓库提供：`src/data/__tests__/fixtures/quality_data.xlsx`） 的 `defect` 工作表，
 * 6 类不良，合计 838 件（逐项与真实数据一致）：
 * 划伤 320 / 尺寸超差 215 / 毛边 148 / 色差 92 / 变形 45 / 异物 18。
 *
 * 预期（详见 `docs/01-基准数据与验证口径.md`）：前 3 项累计 81.50%，
 * 第 3 项（毛边）跨越 80% 分界线。
 */

import type { DefectRecordInput } from '../../types';

/** 原始不良计数（与真实 xlsx 逐项一致）。 */
export const BENCHMARK_DEFECT_COUNTS: { defectType: string; count: number }[] = [
  { defectType: '划伤', count: 320 },
  { defectType: '尺寸超差', count: 215 },
  { defectType: '毛边', count: 148 },
  { defectType: '色差', count: 92 },
  { defectType: '变形', count: 45 },
  { defectType: '异物', count: 18 },
];

/** 基准不良记录（DefectRecordInput 形式；持久化实体同构兼容）。 */
export const BENCHMARK_DEFECT_RECORDS: DefectRecordInput[] = BENCHMARK_DEFECT_COUNTS.map(
  (d) => ({
    defectType: d.defectType,
    count: d.count,
    category: null,
  }),
);

/** 基准不良合计。 */
export const BENCHMARK_DEFECT_TOTAL = 838;
