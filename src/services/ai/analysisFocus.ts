/**
 * analysisFocus —— AI 报表分析的「分析方向」定义（用户需求：可以选择 AI 分析方向）。
 *
 * 用户原话：「希望新增一个 AI 导出功能，必须要接入 LLM，导出的报表每个模块都有
 * AI 分析，可以选择 AI 分析方向」。
 *
 * 设计取舍：
 *  - 方向是**白名单枚举**而不是自由文本。自由文本会被直接拼进 prompt，既难测试，
 *    也给了「把无关内容塞进 system 指令」的口子；枚举化之后每条方向都有确定的
 *    `instruction`，可以单测、可以变异。
 *  - 每条方向都必须能**落到真实统计量**上（例如「能力达标」明确要求引用 Cpk/Ca），
 *    这样输出才可溯源，避免模型空谈。
 */

/** 分析方向标识。 */
export type AnalysisFocusId =
  | 'stability'
  | 'capability'
  | 'defectPareto'
  | 'riskWarning'
  | 'improvement'
  | 'delivery';

/** 一条分析方向。 */
export interface AnalysisFocus {
  id: AnalysisFocusId;
  /** 界面上的勾选标签。 */
  label: string;
  /** 界面上的副说明（告诉用户这条方向会分析什么）。 */
  hint: string;
  /** 注入 prompt 的分析指令。 */
  instruction: string;
  /** 默认是否勾选。 */
  defaultOn: boolean;
}

/** 可选的分析方向（顺序即界面顺序）。 */
export const ANALYSIS_FOCUSES: readonly AnalysisFocus[] = [
  {
    id: 'stability',
    label: '过程稳定性',
    hint: '控制图判异、中心线与控制限、是否有失控信号',
    instruction:
      '【过程稳定性】依据各特性的中心线与控制限（由均值与组内 σ 推导）判断过程是否统计受控；'
      + '若有判异点，点名到具体特性与子组编号；不得声称看到了未提供的逐点原始数据。',
    defaultOn: true,
  },
  {
    id: 'capability',
    label: '过程能力达标',
    hint: 'Cpk/Ppk 与 1.33 合格、1.67 优秀门槛的对照',
    instruction:
      '【过程能力达标】逐特性给出 Cpk / Ppk 与 1.33（合格）、1.67（优秀）门槛的对照结论；'
      + '明确指出短板特性，并区分问题在准确度（Ca，均值偏离规格中心）还是精密度（Cp，变异过大）。',
    defaultOn: true,
  },
  {
    id: 'defectPareto',
    label: '不良优先级',
    hint: '柏拉图 80/20 聚焦，找出应先解决的不良类型',
    instruction:
      '【不良优先级】按柏拉图累计占比找出落在 80% 分界线内的不良类型，给出「先解决哪一类」的结论；'
      + '若本次没有不良记录，必须明确写「本次未导入不良记录，无法给出优先级」，禁止编造不良类型。',
    defaultOn: true,
  },
  {
    id: 'riskWarning',
    label: '风险预警',
    hint: '超差风险、PPM、数据局限与客户可能追问的点',
    instruction:
      '【风险预警】列出交付前必须盯住的风险点（超差风险、PPM 水平、样本量/非正态/单侧规格等数据局限），'
      + '每条都要注明依据的统计量；不得使用未提供的数字。',
    defaultOn: false,
  },
  {
    id: 'improvement',
    label: '改善建议',
    hint: '按优先级排序的可执行动作 + 验证方式',
    instruction:
      '【改善建议】输出不超过 3 条按优先级排序的改善动作，每条注明责任方向（设备/工艺/材料/测量）'
      + '与验证方式，并标明其依据的分析点。',
    defaultOn: true,
  },
  {
    id: 'delivery',
    label: '客户交付口径',
    hint: '这批数据能否交付、需要附什么说明',
    instruction:
      '【客户交付口径】给出「本批数据是否可直接交付客户」的明确结论；若不能，说明需要补做什么'
      + '（补测、加严筛选、附偏差说明等），并给出面对客户时可用的表述。',
    defaultOn: false,
  },
];

/** 默认勾选的方向 id。 */
export const DEFAULT_FOCUS_IDS: readonly AnalysisFocusId[] = ANALYSIS_FOCUSES
  .filter((f) => f.defaultOn)
  .map((f) => f.id);

const FOCUS_BY_ID = new Map(ANALYSIS_FOCUSES.map((f) => [f.id, f] as const));

/**
 * 查询一条方向定义。
 *
 * @param id 方向 id
 * @returns 方向定义；未知 id 返回 undefined
 */
export function findFocus(id: string): AnalysisFocus | undefined {
  return FOCUS_BY_ID.get(id as AnalysisFocusId);
}

/**
 * 归一化方向清单：丢弃未知 id、去重，并保持 `ANALYSIS_FOCUSES` 的固定顺序。
 *
 * 固定顺序很重要 —— 否则 prompt 与导出文档的段落顺序会随用户点击顺序变化，
 * 结果不可复现，用例也失去意义。
 *
 * @param ids 原始 id 清单（可能含未知值 / 重复 / 非字符串）
 * @returns 归一化后的方向 id 清单
 */
export function normalizeFocusIds(ids: readonly unknown[]): AnalysisFocusId[] {
  const wanted = new Set<string>();
  for (const raw of ids) {
    if (typeof raw === 'string' && FOCUS_BY_ID.has(raw as AnalysisFocusId)) {
      wanted.add(raw);
    }
  }
  return ANALYSIS_FOCUSES.filter((f) => wanted.has(f.id)).map((f) => f.id);
}

/**
 * 取「用户选择的方向」与「本模块适用的方向」的交集。
 *
 * 为什么需要它：用户实测反馈里，模型在纯计数模块（不良统计 / 柏拉图）上反复写
 * 「摘要未提供均值、σ、控制限与子组编号，无法判断是否统计受控」——因为这些方向
 * 本来就不该问计数数据。只把适用的方向发过去，这类废话才会消失。
 *
 * @param selected 用户勾选的方向（会先归一化）
 * @param applicable 模块声明的适用方向
 * @returns 交集，顺序 = ANALYSIS_FOCUSES 的固定顺序
 */
export function intersectFocus(
  selected: readonly unknown[],
  applicable: readonly AnalysisFocusId[],
): AnalysisFocusId[] {
  const allowed = new Set<string>(applicable);
  return normalizeFocusIds(selected).filter((id) => allowed.has(id));
}

/**
 * 把选中的方向拼成注入 prompt 的指令块。
 *
 * @param ids 方向 id 清单（内部会先归一化）
 * @returns 指令块；一个方向都没选中时返回空串
 */
export function focusInstructionText(ids: readonly unknown[]): string {
  const normalized = normalizeFocusIds(ids);
  if (normalized.length === 0) {
    return '';
  }
  const lines = normalized.map((id, i) => `${i + 1}. ${FOCUS_BY_ID.get(id)!.instruction}`);
  return ['【本次要求的分析方向（必须逐条覆盖，顺序保持一致）】', ...lines].join('\n');
}

/**
 * 方向 id → 界面标签（导出文档里用来写「分析方向」一行）。
 *
 * @param ids 方向 id 清单
 * @returns 中文标签数组
 */
export function focusLabels(ids: readonly unknown[]): string[] {
  return normalizeFocusIds(ids).map((id) => FOCUS_BY_ID.get(id)!.label);
}
