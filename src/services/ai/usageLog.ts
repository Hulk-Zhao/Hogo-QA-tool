/**
 * usageLog —— AI 使用审计记录（架构 §8.2 第 3 条；PRD P0-24）。
 *
 * 每次 AI 请求后记录 `{ feature, sentPayloadScope, model, ok }`，
 * 供设置页审计「本次请求发送了哪些数据」。
 */

import type { AiFeature, PayloadScope } from './types';

/** 审计记录（与 data/schema.AiUsageLog 结构一致，此处独立声明避免 services → data 依赖）。 */
export interface AiUsageEntry {
  id: string;
  feature: AiFeature;
  sentPayloadScope: PayloadScope;
  model: string;
  /** ISO 8601 */
  requestedAt: string;
  ok: boolean;
}

/**
 * 生成一个简易唯一 id（不依赖 crypto，兼容离线与测试环境）。
 *
 * @param prefix 前缀
 * @returns 唯一 id
 */
function genId(prefix: string): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `${prefix}-${g.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造一条 AI 使用审计记录。
 *
 * @param feature 功能标识
 * @param scope 本次发送的数据范围（summary/raw）
 * @param model 模型名
 * @param ok 请求是否成功
 * @returns 审计记录
 */
export function buildUsageEntry(
  feature: AiFeature,
  scope: PayloadScope,
  model: string,
  ok: boolean,
): AiUsageEntry {
  return {
    id: genId('ailog'),
    feature,
    sentPayloadScope: scope,
    model,
    requestedAt: new Date().toISOString(),
    ok,
  };
}

/** 功能标识 → 中文名（供设置页审计列表展示）。 */
export const USAGE_FEATURE_LABEL: Record<AiFeature, string> = {
  chartExplain: '控制图解读',
  capExplain: '能力解读',
  suggest: '改善建议',
  report: '报告文字',
  qa: '数据问答',
  fullDiagnosis: '全面诊断',
  moduleAnalysis: '报表模块分析',
};

/** 载荷范围 → 中文名。 */
export const USAGE_SCOPE_LABEL: Record<PayloadScope, string> = {
  summary: '仅摘要',
  raw: '摘要+明细',
};
