/**
 * exportOptions —— 报表导出范围（勾选项）定义与容错归一化。
 *
 * 出处：PRD P0-18「报表导出页：导出项勾选（CPK汇总/不良统计/原始尺寸/原始不良/
 * 控制图截图/柏拉图截图）」+ 第五轮用户需求 #11（内嵌图表：柏拉图/能力图/控制图）。
 *
 * 为什么独立成文件：
 *   `settingsStore` 需要持久化本结构（第五轮明确要求「勾选状态走 settingsStore
 *   持久化，不要 useState」），而 `reportService` 会经 `excelReport` 间接引入
 *   `xlsx`（体积大）。把纯类型 + 纯函数放在本模块，store 层即可零成本引用。
 *
 * 分层：本文件属 services 层，不依赖 React / MUI / DOM。
 */

/** 7 项导出范围勾选（4 张数据表 + 3 张图表）。 */
export interface ExportOptions {
  /* —— 数据表（同时作用于页面预览与打印/PDF） —— */
  /** CPK 汇总表。 */
  cpkSummary: boolean;
  /** 不良统计表。 */
  defectStats: boolean;
  /** 原始尺寸表。 */
  rawDimensions: boolean;
  /** 原始不良表。 */
  rawDefects: boolean;
  /* —— 图表（仅作用于打印/PDF；Excel 永不含图片，架构 §0.2 #1 硬约束） —— */
  /** 控制图截图。 */
  controlChartImage: boolean;
  /** 柏拉图截图。 */
  paretoChartImage: boolean;
  /** 能力图（直方图 + 规格线）截图。 */
  capabilityChartImage: boolean;
}

/** 全部导出项 key（顺序固定，供 UI 遍历与测试断言）。 */
export const EXPORT_OPTION_KEYS: readonly (keyof ExportOptions)[] = [
  'cpkSummary',
  'defectStats',
  'rawDimensions',
  'rawDefects',
  'controlChartImage',
  'paretoChartImage',
  'capabilityChartImage',
];

/** 数据表类导出项（Excel sheet 与页面表格共用）。 */
export const TABLE_OPTION_KEYS: readonly (keyof ExportOptions)[] = [
  'cpkSummary',
  'defectStats',
  'rawDimensions',
  'rawDefects',
];

/** 图表类导出项（仅打印/PDF）。 */
export const CHART_OPTION_KEYS: readonly (keyof ExportOptions)[] = [
  'controlChartImage',
  'paretoChartImage',
  'capabilityChartImage',
];

/** 默认全部勾选（与历史行为一致：报表默认最完整）。 */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  cpkSummary: true,
  defectStats: true,
  rawDimensions: true,
  rawDefects: true,
  controlChartImage: true,
  paretoChartImage: true,
  capabilityChartImage: true,
};

/**
 * 容错归一化导出选项。
 *
 * 逐字段处理：非布尔值（缺失 / 字符串 / null / 数字）一律回落**默认 true**，
 * 保证「旧版本残留的 2 字段结构」读回后仍得到完整可用的 7 项。
 *
 * @param raw 反序列化后的原始值
 * @returns 合法 ExportOptions（永不抛异常）
 */
export function sanitizeExportOptions(raw: unknown): ExportOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_EXPORT_OPTIONS };
  }
  const r = raw as Record<string, unknown>;
  const out = { ...DEFAULT_EXPORT_OPTIONS };
  for (const key of EXPORT_OPTION_KEYS) {
    if (typeof r[key] === 'boolean') {
      out[key] = r[key] as boolean;
    }
  }
  return out;
}

/** 是否勾选了至少一项（全不勾选时导出/打印无意义，UI 需拦）。 */
export function hasAnyExportOption(options: ExportOptions): boolean {
  return EXPORT_OPTION_KEYS.some((key) => options[key]);
}

/** 是否勾选了任意图表项（决定打印时是否隐藏图区）。 */
export function hasAnyChartOption(options: ExportOptions): boolean {
  return CHART_OPTION_KEYS.some((key) => options[key]);
}
