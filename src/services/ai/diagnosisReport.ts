/**
 * diagnosisReport —— AI 全面诊断结果的记录结构、容错归一化与导出。
 *
 * 出处：第五轮用户需求 #12（「AI 全面诊断」一键生成 + 导出；结果持久化）。
 *
 * 分层：本文件属 services 层，只做纯数据整形，不依赖 React / MUI / DOM。
 * 持久化落在 `@/store/diagnosisStore`（localStorage 单键），
 * 组合根 `@/ui/bootstrap/settingsBootstrap`。
 */

import type { PayloadScope } from './types';

/**
 * 一次「AI 全面诊断」的完整记录。
 *
 * 说明：刻意**不**放进 `Project` 实体。原因：`Project` 受 schemaVersion 冻结
 * （CURRENT_SCHEMA_VERSION=1，v2 迁移链尚未启用），为一条 AI 输出文本升级
 * schema 会牵动项目包导入导出、IndexedDB 版本与全部持久化回归测试，收益与风险
 * 不成比例。改用单键 localStorage 后语义等价（刷新/重启仍在），且可独立测试。
 * 待 v2 因其它需求正式启用时，再把本结构并入 `Project`。
 */
export interface FullDiagnosisRecord {
  id: string;
  /** Markdown 正文（可直接交付）。 */
  content: string;
  /** ISO 8601 生成时间。 */
  generatedAt: string;
  /** 本次响应采用的模型名。 */
  model: string;
  /** 本次发送的数据范围（summary / raw）。 */
  scope: PayloadScope;
  /** 本次发送的字段清单（数据主权可追溯）。 */
  sentFields: string[];
  /** 生成时的项目名（换项目后便于识别陈旧报告）。 */
  projectName: string;
  /** 生成时纳入统计的特性数。 */
  characteristicCount: number;
}

/** 生成一个简易唯一 id（不依赖 crypto，兼容离线与测试环境）。 */
function genId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) {
    return `diag-${g.crypto.randomUUID()}`;
  }
  return `diag-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 构造一条诊断记录。
 *
 * @param content Markdown 正文
 * @param meta 生成元信息
 * @returns 诊断记录
 */
export function buildFullDiagnosisRecord(
  content: string,
  meta: {
    model: string;
    scope: PayloadScope;
    sentFields: string[];
    projectName: string;
    characteristicCount: number;
  },
): FullDiagnosisRecord {
  return {
    id: genId(),
    content,
    generatedAt: new Date().toISOString(),
    model: meta.model,
    scope: meta.scope,
    sentFields: [...meta.sentFields],
    projectName: meta.projectName,
    characteristicCount: meta.characteristicCount,
  };
}

/**
 * 组装可导出的 Markdown 文档（元信息头 + AI 正文）。
 *
 * 加元信息头的目的：导出件脱离工具后仍能自证「何时 / 用哪个模型 / 发了哪些
 * 字段」，这是 PRD P0-24 数据主权审计在导出侧的要求。
 *
 * @param record 诊断记录
 * @returns Markdown 文本
 */
export function buildDiagnosisMarkdown(record: FullDiagnosisRecord): string {
  const lines = [
    '# AI 全面诊断报告',
    '',
    `- 项目：${record.projectName || '未命名项目'}`,
    `- 生成时间：${record.generatedAt}`,
    `- 模型：${record.model || '未记录'}`,
    `- 纳入特性数：${record.characteristicCount}`,
    `- 发送数据范围：${record.scope === 'raw' ? '摘要 + 明细' : '仅统计摘要'}`,
    `- 发送字段：${record.sentFields.length > 0 ? record.sentFields.join('、') : '—'}`,
    '',
    '---',
    '',
    record.content,
    '',
    '---',
    '',
    '> 本报告由 Hogo-QA-tool 的 AI 全面诊断功能生成，仅基于统计摘要，未使用逐条原始测量值（除非上方标注为「摘要 + 明细」）。',
    '',
  ];
  return lines.join('\n');
}

/** 导出文件名（去重靠时间戳）。 */
export function diagnosisFileName(record: FullDiagnosisRecord): string {
  const stamp = record.generatedAt.replace(/[-:]/g, '').replace(/\..+$/, '');
  const safeName = (record.projectName || '未命名项目').replace(/[\\/:*?"<>|]/g, '_');
  return `Hogo质量诊断报告-${safeName}-${stamp}.md`;
}

/**
 * 容错归一化诊断记录。
 *
 * 任意脏数据（非对象 / 字段缺失 / 类型不符）→ 返回 null，由调用方视为「无记录」，
 * 绝不抛异常、绝不把损坏内容渲染到页面上。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法记录；不可用时 null
 */
export function sanitizeFullDiagnosis(raw: unknown): FullDiagnosisRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  // 正文是唯一必需字段：没有正文的记录没有展示价值。
  if (typeof r.content !== 'string' || r.content.trim().length === 0) {
    return null;
  }
  return {
    id: typeof r.id === 'string' && r.id.length > 0 ? r.id : genId(),
    content: r.content,
    generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : '',
    model: typeof r.model === 'string' ? r.model : '',
    scope: r.scope === 'raw' ? 'raw' : 'summary',
    sentFields: Array.isArray(r.sentFields)
      ? r.sentFields.filter((f): f is string => typeof f === 'string')
      : [],
    projectName: typeof r.projectName === 'string' ? r.projectName : '',
    characteristicCount:
      typeof r.characteristicCount === 'number' && Number.isFinite(r.characteristicCount)
        ? r.characteristicCount
        : 0,
  };
}