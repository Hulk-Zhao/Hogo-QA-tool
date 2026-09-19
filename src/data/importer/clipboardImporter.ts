/**
 * clipboardImporter：剪贴板粘贴导入。
 *
 * 复用 CSV 解析（制表符分隔），返回相同的解析结果类型；
 * 供导入页「粘贴区域」直接调用（P0-16）。
 */

import { parseCsv, type CsvParseOutput } from './csvImporter';
import type { Delimiter } from './types';

/** 粘贴文本解析选项。 */
export interface ClipboardParseOptions {
  /** 手动指定分隔符；缺省自动探测（粘贴 Excel 通常为 Tab）。 */
  delimiter?: Delimiter;
  /** 强制表形状（长/宽）。 */
  forceShape?: 'long' | 'wide';
}

/**
 * 解析剪贴板文本（Tab / 逗号 / 分号分隔）。
 *
 * @param text 粘贴的原始文本
 * @param options 解析选项
 */
export function parseClipboard(
  text: string,
  options: ClipboardParseOptions = {},
): CsvParseOutput {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const opts: { delimiter?: Delimiter; forceShape?: 'long' | 'wide' } = {};
  if (options.delimiter) opts.delimiter = options.delimiter;
  if (options.forceShape) opts.forceShape = options.forceShape;
  return parseCsv(cleaned, opts);
}
