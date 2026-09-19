/**
 * 分布表入口（转发 math/normalCdf）。
 *
 * 架构文档 §2.4 要求 `constants/distributionTables.ts` 提供 t 分布 / 正态 CDF 等
 * 查表与近似；实际数学实现集中在 `math/normalCdf.ts`，此处仅作常量层转发，
 * 保持文件列表契约同时避免重复实现。
 */

export {
  normalCdf,
  normalPdf,
  stdNormalCdf,
  stdNormalPdf,
  normalInvCdf,
  tQuantile,
  SQRT_2PI,
} from '../math/normalCdf';
