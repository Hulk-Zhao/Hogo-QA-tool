/**
 * 导入层类型定义。
 *
 * 出处：架构文档 §3.6、§4.1；PRD P0-15/P0-16。
 */

/** 解析出的原始表格（统一二维形式，供列映射 UI 使用）。 */
export interface ParsedSheet {
  /** 工作表名（xlsx 多 sheet；csv/clipboard 用占位名）。 */
  sheetName: string;
  /** 表头行（原始列名）。 */
  header: string[];
  /** 数据行（与 header 等长的字符串/数值单元格）。 */
  rows: RawCell[][];
  /** 数据起始行号（相对于原始文件，1-based），用于错误定位。 */
  firstDataRowNumber: number;
}

/** 单元格原始值：字符串或数字；空单元格为 null。 */
export type RawCell = string | number | null;

/** 单个字段的角色（供自动/手动列映射）。 */
export type FieldRole =
  | 'material'
  | 'value'
  | 'usl'
  | 'lsl'
  | 'target'
  | 'subgroup'
  | 'defectType'
  | 'defectCount'
  | 'date'
  | 'batch'
  | 'ignore';

/** 列映射：字段角色 → 该 sheet 中的列索引。 */
export interface ColumnMapping {
  /** role → 列下标（-1 表示未映射）。 */
  [role: string]: number;
}

/** 自动映射结果。 */
export interface AutoMapResult {
  /** 已识别的映射。 */
  mapping: ColumnMapping;
  /** 未能匹配矩阵中任一已知别名的列（供 UI 提示人工映射）。 */
  unmappedColumns: { index: number; name: string }[];
  /** 缺失的必需角色（导致导入失败或需人工指定）。 */
  missingRoles: FieldRole[];
}

/** 单行校验错误。 */
export interface RowError {
  /** 数据所在工作表。 */
  sheetName: string;
  /** 行号（原始文件 1-based，含表头）。 */
  rowNumber: number;
  /** 列名。 */
  column: string;
  /** 错误原因。 */
  reason: string;
  /** 原始值（字符串化）。 */
  rawValue: string;
}

/** 数值型解析的单行结果（含空值语义）。 */
export interface NumericCellParse {
  /** 合法数值；缺失或非法时为 null。 */
  value: number | null;
  /** 是否为缺失（null / 空串 / NaN 语义）。 */
  isNull: boolean;
  /** 非法原因（isNull=true 且 raw 非空时给出，如「非数字」）。 */
  invalidReason: string | null;
}

/** 导入解析总结果。 */
export interface ImportParseResult {
  /** dimension 类工作表（测量值）。 */
  dimensionSheet: ParsedSheet | null;
  /** defect 类工作表（不良记录）。 */
  defectSheet: ParsedSheet | null;
  /** dimension 自动列映射。 */
  dimensionMapping: AutoMapResult | null;
  /** defect 自动列映射。 */
  defectMapping: AutoMapResult | null;
  /** 校验错误汇总（可定位到 sheet / 行 / 列）。 */
  errors: RowError[];
  /** 解析警告（不阻断导入）。 */
  warnings: string[];
  /** 测量值总条数（用于性能上限判断）。 */
  measurementCount: number;
}

/** 导入源类型。 */
export type ImportSourceType = 'xlsx' | 'csv' | 'json';

/** 剪贴板/CSV 分隔符。 */
export type Delimiter = ',' | '\t' | ';';
