/**
 * csvImporter：CSV 解析（长表 / 宽表），PRD P0-16。
 *
 * 长表（默认引导）：一行一测量值，列含 物料名称/测量值/[USL/LSL/子组]。
 * 宽表：一行一子组，首列为物料名，其后各列为子组成员。
 *
 * 本模块不做实体构造（在 buildModel.ts），仅产出 ParsedSheet + 映射 + 校验。
 */

import { HogoError } from '../errors';
import { cellToString, parseNumericCell } from './cellParsing';
import { autoMapColumns } from './xlsxImporter';
import { measurementLimitWarning } from './limits';
import type { AutoMapResult, Delimiter, ParsedSheet, RawCell, RowError } from './types';

/**
 * 自动探测分隔符：优先制表符（粘贴表格），否则逗号/分号按出现次数择优。
 */
export function detectDelimiter(text: string): Delimiter {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const semis = (firstLine.match(/;/g) ?? []).length;
  if (tabs >= commas && tabs >= semis && tabs > 0) return '\t';
  if (semis > commas) return ';';
  return ',';
}

/**
 * CSV 行解析（支持双引号包裹与转义 ""）。
 *
 * @param line 单行文本
 * @param delimiter 分隔符
 */
export function parseCsvLine(line: string, delimiter: Delimiter): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** CSV 文本 → 二维单元格（空串转 null）。 */
export function parseCsvMatrix(text: string, delimiter?: Delimiter): RawCell[][] {
  const delim = delimiter ?? detectDelimiter(text);
  const lines = text.split(/\r?\n/);
  const matrix: RawCell[][] = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    const cells = parseCsvLine(line, delim);
    matrix.push(
      cells.map((c) => {
        const t = c.trim();
        if (t.length === 0) return null;
        const num = Number(t.replace(/,/g, ''));
        return Number.isFinite(num) && /^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(t.replace(/,/g, ''))
          ? num
          : t;
      }),
    );
  }
  return matrix;
}

/** 由矩阵构造 ParsedSheet。 */
function matrixToSheet(sheetName: string, matrix: RawCell[][]): ParsedSheet {
  if (matrix.length === 0) {
    return { sheetName, header: [], rows: [], firstDataRowNumber: 2 };
  }
  // 逐行求最大列宽，避免 Math.max(...rows) 在大数据量（>~12 万行）时
  // 因参数展开超过调用栈上限而抛 RangeError: Maximum call stack size exceeded。
  let width = 0;
  for (const r of matrix) {
    if (r.length > width) {
      width = r.length;
    }
  }
  const header = (matrix[0] ?? []).map((c) => cellToString(c));
  while (header.length < width) header.push('');
  const rows: RawCell[][] = [];
  for (let i = 1; i < matrix.length; i += 1) {
    const r = matrix[i];
    const out: RawCell[] = [];
    for (let j = 0; j < width; j += 1) {
      out.push(r[j] === undefined ? null : r[j]);
    }
    rows.push(out);
  }
  return { sheetName, header, rows, firstDataRowNumber: 2 };
}

/**
 * 宽表 → 长表展开：首列为物料名，其余列为子组成员。
 *
 * @returns { sheet, errors } —— 展开后的长表结构 + 非法单元格错误
 */
export function expandWideToLong(
  sheet: ParsedSheet,
): { sheet: ParsedSheet; errors: RowError[] } {
  const errors: RowError[] = [];
  const header = sheet.header;
  const longHeader = ['物料名称', '测量值', '子组'];
  const rows: RawCell[][] = [];
  const firstColName = header[0] ?? '物料名称';
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const rowNumber = sheet.firstDataRowNumber + i;
    const material = cellToString(row[0]);
    if (material.length === 0) {
      errors.push({
        sheetName: sheet.sheetName,
        rowNumber,
        column: firstColName,
        reason: '物料名称为空',
        rawValue: '',
      });
      continue;
    }
    for (let j = 1; j < row.length; j += 1) {
      const raw = row[j];
      const parsed = parseNumericCell(raw);
      if (parsed.value === null && parsed.invalidReason) {
        errors.push({
          sheetName: sheet.sheetName,
          rowNumber,
          column: header[j] ?? `列${j + 1}`,
          reason: parsed.invalidReason,
          rawValue: String(raw ?? ''),
        });
        continue;
      }
      // 空单元格不展开为记录（与长表空值语义一致：缺失即不产出行）。
      if (parsed.value === null) continue;
      rows.push([material, parsed.value, String(i + 1)]);
    }
  }
  return {
    sheet: {
      sheetName: sheet.sheetName,
      header: longHeader,
      rows,
      firstDataRowNumber: 2,
    },
    errors,
  };
}

/** CSV 解析输出。 */
export interface CsvParseOutput {
  sheet: ParsedSheet;
  mapping: AutoMapResult;
  errors: RowError[];
  warnings: string[];
  wideExpanded: boolean;
  /** 测量值总条数（用于性能上限判断，架构 §0.2 #9）。 */
  measurementCount: number;
}

/**
 * 解析 CSV 文本（自动判定长/宽表）。
 *
 * 判定规则：若表头能自动映射出 value 列 → 长表；否则若列数 > 2 视为宽表展开。
 *
 * @throws {HogoError} IMPORT_EMPTY（无数据）
 * @throws {HogoError} IMPORT_COLUMN_MISMATCH（无法识别结构）
 */
export function parseCsv(
  text: string,
  options: { delimiter?: Delimiter; forceShape?: 'long' | 'wide' } = {},
): CsvParseOutput {
  const matrix = parseCsvMatrix(text, options.delimiter);
  if (matrix.length === 0) {
    throw new HogoError('IMPORT_EMPTY', 'CSV 内容为空。', {});
  }
  const warnings: string[] = [];
  const sheet0 = matrixToSheet('csv', matrix);

  // 判定长/宽。
  let shape: 'long' | 'wide' = options.forceShape ?? 'long';
  if (!options.forceShape) {
    const probe = autoMapColumns(sheet0, 'dimension');
    if (probe.mapping.value === undefined) {
      shape = sheet0.header.length > 2 ? 'wide' : 'long';
      warnings.push(`未识别到「测量值」列，按${shape === 'wide' ? '宽表' : '长表'}处理。`);
    }
  }

  if (shape === 'long') {
    const mapping = autoMapColumns(sheet0, 'dimension');
    if (mapping.missingRoles.length > 0) {
      throw new HogoError(
        'IMPORT_COLUMN_MISMATCH',
        `CSV 缺少必需列：${mapping.missingRoles.join('、')}。请手动映射列。`,
        { missing: mapping.missingRoles },
      );
    }
    const errors: RowError[] = [];
    const materialCol = mapping.mapping.material;
    const valueCol = mapping.mapping.value;
    let measurementCount = 0;
    for (let i = 0; i < sheet0.rows.length; i += 1) {
      const row = sheet0.rows[i];
      const rowNumber = sheet0.firstDataRowNumber + i;
      if (cellToString(row[materialCol]).length === 0) {
        errors.push({
          sheetName: 'csv',
          rowNumber,
          column: sheet0.header[materialCol] ?? '物料名称',
          reason: '物料名称为空',
          rawValue: '',
        });
      }
      const p = parseNumericCell(row[valueCol]);
      if (p.value === null && p.invalidReason) {
        errors.push({
          sheetName: 'csv',
          rowNumber,
          column: sheet0.header[valueCol] ?? '测量值',
          reason: p.invalidReason,
          rawValue: String(row[valueCol] ?? ''),
        });
      } else if (p.value !== null) {
        // 长表 measurementCount = 测量值列的有效数值行数（空值 / 非法值不计）。
        measurementCount += 1;
      }
    }
    appendLimitWarning(warnings, measurementCount);
    return { sheet: sheet0, mapping, errors, warnings, wideExpanded: false, measurementCount };
  }

  // 宽表展开。
  const expanded = expandWideToLong(sheet0);
  const mapping = autoMapColumns(expanded.sheet, 'dimension');
  // 宽表 measurementCount = expandWideToLong 展开后的有效测量值行数。
  const measurementCount = expanded.sheet.rows.length;
  appendLimitWarning(warnings, measurementCount);
  return {
    sheet: expanded.sheet,
    mapping,
    errors: expanded.errors,
    warnings,
    wideExpanded: true,
    measurementCount,
  };
}

/**
 * 依据测量值条数追加性能上限告警（架构 §0.2 #9）。
 *
 * 仅追加提示，不阻断、不截断。
 */
function appendLimitWarning(warnings: string[], measurementCount: number): void {
  const limitWarning = measurementLimitWarning(measurementCount, 'CSV / 粘贴文本');
  if (limitWarning !== null) {
    warnings.push(limitWarning);
  }
}
