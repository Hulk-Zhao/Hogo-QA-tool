/**
 * payloadBuilder —— AI 请求体唯一构造入口（架构 §8.2，数据主权关键）。
 *
 * **白名单复制而非黑名单剔除**：
 * 1. 只从 summary 中挑选已知摘要字段逐字段显式复制，未知字段（含可能的
 *    `measurements`）绝不带出；
 * 2. 原始明细仅在 `allowRawData === true` 且显式传入 rawData 时才追加，
 *    且单独标注 `__raw.measurements`；
 * 3. 返回 `sentFields` 供 UI 展示清单 + 写 `AiUsageLog`。
 *
 * 出处：架构文档 §8.2 / PRD P0-24、§6.3；验收要点 T05-4。
 */

import type { AiFeature, AiPayload, ChatMessage, SummaryLike } from './types';

/**
 * 各摘要类型的白名单字段（只认已知 key）。
 *
 * 覆盖 core/ai/summary 的 `ChartSummaryInput` / `CapabilitySummaryInput`
 * 以及项目级摘要。字段名逐条枚举，杜绝「透传未知字段」。
 */
const SUMMARY_WHITELIST: readonly string[] = [
  // 通用
  'characteristicName',
  'chartType',
  // 控制图摘要
  'centerLine',
  'ucl',
  'lcl',
  'sigma',
  'violations',
  'capability',
  // 能力摘要
  'n',
  'mean',
  'sigmaWithin',
  'sigmaOverall',
  'ca',
  'cp',
  'cpk',
  'pp',
  'ppk',
  'sigmaLevelShort',
  'sigmaLevelBench',
  'ppmOverall',
  'ppmWithin',
  'warnings',
  'spec',
  // 项目级摘要（qa 功能）
  'projectName',
  'datasetCount',
  'characteristicCount',
  'defectTypeCount',
  'totalMeasurements',
  'characteristics',
];

/**
 * 递归清洗值：仅保留可安全序列化的原始类型与数组/纯对象。
 *
 * 防御性实现：即便白名单字段内部嵌套了意外结构（如 `capability` 被塞入
 * measurements），也只保留标量/纯对象，丢弃函数、undefined、Symbol 等。
 *
 * @param value 待清洗值
 * @returns 可安全 JSON 序列化的值
 */
function sanitize(value: unknown): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') {
        continue;
      }
      out[k] = sanitize(v);
    }
    return out;
  }
  return null;
}

/**
 * 白名单挑选：只复制已知摘要字段（架构 §8.2 第 1 步）。
 *
 * @param summary 分析摘要
 * @returns 仅含白名单字段的安全对象
 */
export function pickKnownSummaryFields(summary: SummaryLike): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const key of SUMMARY_WHITELIST) {
    if (Object.prototype.hasOwnProperty.call(summary, key)) {
      const value = summary[key];
      if (value !== undefined) {
        safe[key] = sanitize(value);
      }
    }
  }
  return safe;
}

/** 各功能的中文功能名（用于构造 prompt 前言与 UI 展示）。 */
const FEATURE_LABEL: Record<AiFeature, string> = {
  chartExplain: '控制图异常解读',
  capExplain: '能力分析解读',
  suggest: '改善建议',
  report: '报告文字生成',
  qa: '数据问答',
  fullDiagnosis: 'AI 全面诊断',
};

/** 各功能的 system prompt（架构 §8.3）。 */
const FEATURE_SYSTEM_PROMPT: Record<AiFeature, string> = {
  chartExplain:
    '你是资深制造业 SPC 质量工程师。基于给定的控制图统计摘要，输出中文诊断，必须包含：' +
    '①问题定位（具体到子组编号/特性名与违规规则）；' +
    '②疑似原因（设备漂移 / 材料波动 / 人员操作 / 测量系统，择最可能者并说明依据）；' +
    '③至少 1 条可执行动作（如「停线复测第 k 子组」「校准刀具」）。' +
    '禁止仅复述统计名词，不发送原始测量值。',
  capExplain:
    '你是资深过程能力分析专家。基于给定的能力摘要，判定过程是否受控、是否满足 Cp/Cpk 1.33（合格）' +
    '与 1.67（优秀）门槛，并明确指出主要问题在准确度（Ca，均值偏离规格中心）还是精密度（Cp，变异过大）。' +
    '输出简洁中文结论，不发送原始测量值。',
  suggest:
    '你是精益质量改善顾问。基于分析摘要，输出不超过 3 条按优先级排序的改善动作，' +
    '每条注明其依据的分析点（如具体指数或违规规则）。用中文，禁止泛泛而谈。',
  report:
    '你是质量报告撰写助手。基于分析摘要与用户备注，生成可直接粘贴的 Markdown 报告，' +
    '包含「摘要 / 结论 / 建议」三节。用中文，结构清晰，不臆造数据。',
  qa:
    '你是质量数据问答助手。**仅基于提供的项目统计摘要**回答用户问题，' +
    '开头须声明「以下回答仅基于统计摘要，未使用原始明细数据」。若摘要不足以回答，请明确说明。',
  fullDiagnosis:
    '你是资深制造业质量总监，负责出具一份可直接交付给管理层/客户的**全面质量诊断报告**。' +
    '基于给出的项目统计摘要（各特性 n / 均值 / 双口径 σ / Ca / Cp / Cpk / Pp / Ppk / 双西格玛水平 / PPM / 告警），' +
    '输出中文 Markdown 报告，必须且仅包含以下五节，标题与顺序固定：' +
    '## 一、总体结论（一句话给出项目整体质量状态与最需关注的特性，必须点名具体特性名）；' +
    '## 二、过程能力盘点（逐特性给出 Cpk/Ppk 与 1.33 合格、1.67 优秀门槛的对照结论，明确短板特性）；' +
    '## 三、主要问题与疑似根因（按影响从大到小排序，每条注明所依据的统计量）；' +
    '## 四、改善行动（不超过 5 条，按优先级排序，每条给出责任方向：设备/工艺/材料/测量，并给出验证方式）；' +
    '## 五、数据局限与风险提示（说明样本量、非正态、单侧规格等因素对结论的影响）。' +
    '硬约束：只能使用给定摘要中的数据，**不得臆造任何数值**；摘要未提供的数据一律写「摘要未提供」；' +
    '不发送也不需要原始测量明细。',
};

/**
 * 构造聊天消息（架构 §8.2 buildMessages）。
 *
 * @param feature 功能标识
 * @param payload 白名单后的载荷对象
 * @param userNote 用户可选备注/问题
 * @returns 聊天消息数组
 */
export function buildMessages(
  feature: AiFeature,
  payload: Record<string, unknown>,
  userNote = '',
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: 'system', content: FEATURE_SYSTEM_PROMPT[feature] },
  ];
  const header = `【任务】${FEATURE_LABEL[feature]}\n【统计摘要（JSON）】\n${JSON.stringify(payload, null, 2)}`;
  const userContent = userNote.trim().length > 0
    ? `${header}\n\n【用户补充/问题】\n${userNote.trim()}`
    : header;
  messages.push({ role: 'user', content: userContent });
  return messages;
}

/**
 * 构造 AI 请求载荷（架构 §8.2 主入口）。
 *
 * 白名单复制 → 明细仅在显式允许时追加 → 返回 scope/sentFields/messages。
 *
 * @param feature 功能标识
 * @param summary 分析摘要（来自 core/ai/summary 或项目级摘要）
 * @param allowRawData 是否允许发送原始明细（默认 false）
 * @param rawData 原始明细（仅 allowRawData 为 true 时才被注入）
 * @param userNote 用户可选备注/问题
 * @returns 载荷（scope / sentFields / messages）
 */
export function buildPayload(
  feature: AiFeature,
  summary: SummaryLike,
  allowRawData = false,
  rawData?: unknown,
  userNote = '',
): AiPayload {
  // 1. 白名单：只挑选已知摘要字段
  const safe = pickKnownSummaryFields(summary);
  const sentFields = Object.keys(safe);

  // 2. 明细仅在显式允许且确有数据时追加，且单独标注
  if (allowRawData && rawData !== undefined && rawData !== null) {
    const sanitizedRaw = sanitize(rawData);
    safe.__raw = sanitizedRaw;
    sentFields.push('__raw.measurements');
    return {
      scope: 'raw',
      sentFields,
      messages: buildMessages(feature, safe, userNote),
    };
  }

  return {
    scope: 'summary',
    sentFields,
    messages: buildMessages(feature, safe, userNote),
  };
}

/** 导出白名单字段清单（供测试与设置页核对）。 */
export function summaryWhitelist(): readonly string[] {
  return SUMMARY_WHITELIST;
}
