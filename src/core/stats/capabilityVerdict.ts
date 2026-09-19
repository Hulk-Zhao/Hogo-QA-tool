/**
 * capabilityVerdict —— Cpk 门槛判定（唯一真源）。
 *
 * 出处：PRD 判定口径 —— **1.33 合格 / 1.67 优秀**（与 AI 提示词、Markdown 报告一致）。
 *
 * 为什么抽到 core：同一句话此前只存在于 `services/report/markdownReport` 的私有函数里，
 * 而本轮 P1-03「多特性批量对比表」也需要它。若各写一份，同一个 Cpk=1.4 可能在
 * 报告里是「合格」、在页面上是「优秀」——**口径分叉比缺少功能更危险**。
 *
 * 纯函数，无任何依赖。
 */

/** 能力等级。 */
export type CapabilityGrade = 'excellent' | 'qualified' | 'low' | 'fail' | 'unknown';

/** Cpk 优秀门槛。 */
export const CPK_EXCELLENT = 1.67;
/** Cpk 合格门槛。 */
export const CPK_QUALIFIED = 1.33;
/** Cpk 偏低下界。 */
export const CPK_LOW = 1.0;

/**
 * 由 Cpk 判定能力等级。
 *
 * @param cpk Cpk（null / 非有限数视为无法判定）
 * @returns 等级
 */
export function capabilityGrade(cpk: number | null): CapabilityGrade {
  if (cpk === null || cpk === undefined || !Number.isFinite(cpk)) {
    return 'unknown';
  }
  if (cpk >= CPK_EXCELLENT) {
    return 'excellent';
  }
  if (cpk >= CPK_QUALIFIED) {
    return 'qualified';
  }
  if (cpk >= CPK_LOW) {
    return 'low';
  }
  return 'fail';
}

/**
 * 判定文案（与 Markdown 报告逐字一致）。
 *
 * @param cpk Cpk
 * @returns 中文判定文案
 */
export function capabilityVerdictText(cpk: number | null): string {
  switch (capabilityGrade(cpk)) {
    case 'excellent':
      return '优秀（≥1.67）';
    case 'qualified':
      return '合格（≥1.33）';
    case 'low':
      return '偏低（1.00~1.33），建议改善';
    case 'fail':
      return '不合格（<1.00），必须改善';
    default:
      return '规格限不足，无法判定';
  }
}
