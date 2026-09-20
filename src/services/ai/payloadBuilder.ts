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
  // P8 新增：让模型拿到「够用」的数据面（见 services/ai/analysisContext.ts）
  'datasetName',
  'datasetImportedAt',
  'measurementCount',
  'selectedCharacteristic',
  'subgroupConfig',
  'ruleSet',
  'defects',
  'chartCatalogue',
  'caveats',
  'excludedCount',
  'controlChart',
  'controlChartUnavailable',
  'unavailable',
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
  moduleAnalysis: '报表模块 AI 分析',
};

/**
 * 公共数据契约：所有功能共用的数据说明与硬约束（P8 新增）。
 *
 * 为什么必须写死这一段（用户报障的直接根因）：
 *   早期版本只把「能力指数」发给模型，模型遇到「第几子组触发判异」这类问题时，
 *   只能回答「摘要未给出控制图点子序列…不能编造」——用户读到的是一句「你没给我数据」。
 *   现在应用把子组序列、判异明细、图表目录都发了，就必须同时**告诉模型这些字段存在、
 *   直接用**，否则模型仍会保守地回一句「数据不足」。
 */
const DATA_CONTRACT =
  '【你拿到的数据】下面 JSON 是质量分析工具**已经算好**的统计结果（不是原始测量值，也不要再索要数据）。' +
  '它按需包含：项目与数据集口径、subgroupConfig（子组容量 / σ 估计法 / 每特性子组序列条数上限）、' +
  'ruleSet（本次启用的判异规则及其含义）、每个特性的能力指数' +
  '（n / mean / sigmaWithin / sigmaOverall / Ca / Cp / Cpk / Pp / Ppk / 双西格玛水平 / PPM / warnings / spec）、' +
  '每个特性的 controlChart（图型、子组容量与子组个数、CL/UCL/LCL、副图限、' +
  '**逐子组的均值与极差序列 points**、**逐条判异明细 violations（规则 id + 规则说明 + 涉及子组编号 subgroupIndices）**、' +
  '超限点 outOfLimit）、defects（缺陷 Pareto）、chartCatalogue（本工具里**真实存在**的图表目录）、caveats（数据局限）。' +
  '编号约定：子组编号从 1 开始，与 points[].i 和 violations[].subgroupIndices 是同一套编号。' +
  '【硬约束】' +
  '① 只能引用 JSON 里出现过的数值与名称，**严禁臆造**任何数字、子组号或规则 id；' +
  '② **禁止**写「摘要未提供 / 数据不足 / 无法判断」这类话：只要 JSON 里有对应字段（尤其是 points 与 violations），' +
  '就必须直接据此给出具体结论；只有 JSON 里确实不存在该字段时，才允许用一句话说明口径' +
  '（例如「本模块是计数数据，不含 σ」），并立刻给出在现有数据上能下的结论；' +
  '③ 结论必须落到具体对象上（特性名、子组编号、规则 id、具体指数数值、具体限值），' +
  '禁止「部分子组存在波动」「建议持续关注」这类没有信息量的表述；' +
  '④ 需要图形佐证时，在正文中**单独一行**写 `[[chart:图表id]]`（id 必须逐字来自 chartCatalogue，' +
  '不要自造 id，也不要在正文里解释这个标记）——工具会把**真实图表**渲染在你回复的对应位置；' +
  '⑤ 用中文 Markdown（可用小标题 / 表格 / 列表），不要输出与统计量无关的套话。';

/**
 * 各功能的 system prompt（架构 §8.3；P8 起统一带上 {@link DATA_CONTRACT}）。
 *
 * 拆分 `SPECIFIC_PROMPT` + `DATA_CONTRACT` 是为了让「数据面」与「任务面」各自可被单独测试
 * （变异测试需要能单独删掉任何一侧并让用例变红）。
 */
const SPECIFIC_PROMPT: Record<AiFeature, string> = {
  chartExplain:
    '你是资深制造业 SPC 质量工程师。基于给定数据输出中文 Markdown 诊断，必须包含：' +
    '## 问题定位（点名特性与**具体子组编号**：优先引用 controlChart.violations 的规则 id 与涉及子组、' +
    '以及 controlChart.outOfLimit 的超限点；若某特性的 violations 为空，就明确写「本批数据在启用规则下无判异」，' +
    '并接着用它的能力指数、超限点、points 里的走势给出结论，**不要**停在「无法判断」）；' +
    '## 疑似原因（设备漂移 / 材料波动 / 人员操作 / 测量系统，择最可能者，并给出依据的统计量：' +
    '如 points 中的单调上升或下降、均值相对 CL 的偏移方向与幅度、σ_within 与 σ_overall 的差异）；' +
    '## 可执行动作（至少 2 条，写明对象 + 判定阈值 + 验证方式，例如「停线复测第 7 子组：连续 5 个子组均值仍低于 12.000 则调刀」）。' +
    '需要图形时引用 chartCatalogue 里的控制图 id。',
  capExplain:
    '你是资深过程能力分析专家。基于给定数据输出中文 Markdown 结论：' +
    '① 逐特性给出 Cpk / Ppk 与 1.33（合格）、1.67（优秀）门槛的对照，点名短板特性；' +
    '② 判断问题主要在准确度（Ca，均值偏离规格中心）还是精密度（Cp，变异过大），并写出 均值 与 spec 中心的具体差距；' +
    '③ 结合 controlChart.outOfLimit 与 violations 说明「能力不足是否同时伴随失控点」，' +
    '若两者不一致（能力差但无判异 / 有判异但能力好）要明确指出这种组合的含义；' +
    '④ 需要时引用 chartCatalogue 里的直方图 id 说明分布与规格限的关系。',
  suggest:
    '你是精益质量改善顾问。基于给定数据输出不超过 3 条按优先级排序的改善动作，' +
    '每条格式为「动作（对象 + 判定阈值 + 验证方式）——依据：具体统计量 / 规则 id / 子组编号」。' +
    '禁止泛泛而谈，禁止输出「数据不足」类内容。',
  report:
    '你是质量报告撰写助手。基于给定数据与用户备注，生成可直接粘贴的 Markdown 报告，' +
    '包含「摘要 / 结论 / 建议」三节；结论要落到具体特性与子组编号，建议要可执行。用中文，不臆造数据。',
  qa:
    '你是质量数据问答助手。基于给定数据回答用户问题：' +
    '① 第一句直接给结论（「是 / 不是」「哪个特性最差」「哪些子组异常」），随后给依据（引用具体数值、子组编号、规则 id）；' +
    '② 涉及某特性的波动或趋势时，优先引用 controlChart.points 的实际数值来说明，而不是只讲指数；' +
    '③ 若问题超出本工具的数据范围（如设备编号、批次时间、成本、人员），用一句话说明工具没有这类数据，' +
    '然后回答最接近的可答部分；' +
    '④ 需要图形佐证时引用 chartCatalogue 里的 id（例如 [[chart:control:转轴直径]]）。' +
    '不要在开头写「以下回答仅基于统计摘要」这类免责声明——数据范围已由工具在气泡上标注。',
  moduleAnalysis:
    '你是资深制造业质量工程师，正在为一份**质量报表**撰写逐模块的 AI 分析。' +
    '每次只给你**一个报表模块**的统计摘要、该模块的**数据口径**，以及本次要求覆盖的「分析方向」清单。输出要求：' +
    "① 用中文 Markdown，以 `### ` 开头的三级标题（用模块名），**整段正文不超过 220 字**；" +
    "② **只覆盖给定清单里的分析方向**，顺序与清单一致，每条单独成段并以 “- ” 开头；清单里没有的方向一律不要输出；" +
    "③ 只能引用摘要里出现过的数字，**严禁臆造任何数值**；" +
    "④ 摘要确实缺少某个字段时，用**一句话**说明（例如「本模块是计数数据，不含 σ」），" +
    "然后给出**在现有数据上能下的结论**；**禁止**为多个方向重复同一句「摘要未提供…」，" +
    "更禁止把「摘要未提供 X」本身当成一条分析结论；" +
    "⑤ 「数据口径」里已声明「本来就没有」的字段（计数数据没有均值 / σ / 控制限 / 子组编号），不要写成数据缺失；" +
    "⑥ 摘要里 unavailable 非空、或模块无数据的，直接说明「本模块无数据，无法分析」，不要编造结论；" +
    "⑦ 不要输出与统计量无关的套话，不要重复摘要里的整张表。",
  fullDiagnosis:
    '你是资深制造业质量总监，负责出具一份可直接交付给管理层/客户的**全面质量诊断报告**。' +
    '输出中文 Markdown 报告，必须且仅包含以下五节，标题与顺序固定：' +
    '## 一、总体结论（一句话给出项目整体质量状态与最需关注的特性，必须点名具体特性名，并给出该特性的关键数值）；' +
    '## 二、过程能力盘点（逐特性给出 Cpk/Ppk 与 1.33、1.67 门槛的对照，明确短板特性）；' +
    '## 三、主要问题与疑似根因（按影响从大到小排序，每条注明依据：具体统计量、判异规则 id 与**涉及的子组编号**）；' +
    '## 四、改善行动（不超过 5 条，按优先级排序，每条给出责任方向：设备/工艺/材料/测量，并给出验证方式与判定阈值）；' +
    '## 五、数据局限与风险提示（只写**真实**局限：样本量 n 偏小、单侧规格、σ_within 与 σ_overall 差异、' +
    'pointsTruncated 表示子组序列被截断、excludedCount 表示有被排除的异常值等；**不要**写「未提供数据」）。' +
    '各节需要图形佐证时可引用 chartCatalogue 里的 id。',
};

/** 最终 system prompt = 任务说明 + 公共数据契约。 */
const FEATURE_SYSTEM_PROMPT: Record<AiFeature, string> = Object.fromEntries(
  (Object.keys(SPECIFIC_PROMPT) as AiFeature[]).map((feature) => [
    feature,
    `${SPECIFIC_PROMPT[feature]}\n\n${DATA_CONTRACT}`,
  ]),
) as Record<AiFeature, string>;

/** 导出各功能的 system prompt（供测试核对「数据契约」是否真的随请求发出）。 */
export function featureSystemPrompt(feature: AiFeature): string {
  return FEATURE_SYSTEM_PROMPT[feature];
}
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
  const header = `【任务】${FEATURE_LABEL[feature]}\n【已算好的统计结果（JSON）】\n${JSON.stringify(payload, null, 2)}`;
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
