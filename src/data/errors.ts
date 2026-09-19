/**
 * 领域错误类型（data / services 层使用）。
 *
 * 出处：架构文档 §8.4。core 层直接抛 TypeError/RangeError；
 * data/services 层捕获后包装为带 code 的 HogoError。
 */

export type HogoErrorCode =
  | 'IMPORT_PARSE_FAILED'
  | 'IMPORT_COLUMN_MISMATCH'
  | 'IMPORT_EMPTY'
  | 'SCHEMA_VERSION_UNSUPPORTED'
  | 'STORAGE_UNAVAILABLE'
  | 'CHART_CONSTANT_OUT_OF_RANGE'
  | 'AI_NOT_CONFIGURED'
  | 'AI_UNREACHABLE'
  | 'AI_REQUEST_FAILED';

/**
 * 领域错误：携带机器可读 code 与可选 detail。
 */
export class HogoError extends Error {
  public readonly code: HogoErrorCode;
  public readonly detail?: unknown;

  constructor(code: HogoErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = 'HogoError';
    this.code = code;
    this.detail = detail;
    // 修正原型链（TS 编译到 ES5/ES2015 时的惯例处理）
    Object.setPrototypeOf(this, HogoError.prototype);
  }
}

/**
 * 用户可读的错误提示文案映射。
 */
export const HOGO_ERROR_MESSAGES: Record<HogoErrorCode, string> = {
  IMPORT_PARSE_FAILED: '文件解析失败，请确认文件格式与内容。',
  IMPORT_COLUMN_MISMATCH: '列名无法匹配，请手动映射列。',
  IMPORT_EMPTY: '导入内容为空，请检查数据源。',
  SCHEMA_VERSION_UNSUPPORTED: '项目包版本不受支持，请升级工具或导出为当前版本。',
  STORAGE_UNAVAILABLE: '本地存储不可用，已降级为内存模式，请及时导出项目包。',
  CHART_CONSTANT_OUT_OF_RANGE: '子组容量超出常数表范围（2..25），请调整子组设置。',
  AI_NOT_CONFIGURED: '尚未配置 AI 服务，请到设置页填写 Base URL 与 API Key。',
  AI_UNREACHABLE: 'AI 服务暂不可用，已降级为离线模式。',
  AI_REQUEST_FAILED: 'AI 请求失败，请稍后重试。',
};
