/**
 * xlsxImporter：旧工具双 sheet xlsx 兼容解析（PRD P0-15）。
 *
 * 用 SheetJS 0.18.5 读取；该库对旧工具文件（inlineStr 文本 + <v> 数值）
 * 能正确读出（已实测）。sheet 识别：名称含 'dimension'/'尺寸'/'测量'
 * 视为 dimension；含 'defect'/'不良'/'缺陷' 视为 defect。
 *
 * 本模块只做「解析 + 列自动映射 + 行级校验」，不构造领域实体
 * （构造在 buildModel.ts）。
 */

import * as XLSX from 'xlsx';
import { HogoError } from '../errors';
import { parseCountCell, parseNumericCell, cellToString } from './cellParsing';
import { requiredRoles, resolveRole } from './columnAliases';
import { measurementLimitWarning } from './limits';
import type { AutoMapResult, ColumnMapping, FieldRole, ParsedSheet, RawCell, RowError } from './types';

/** 角色 → 中文显示名（用于可定位的错误信息）。 */
const ROLE_LABELS: Record<FieldRole, string> = {
  material: '物料名称',
  value: '测量值',
  usl: 'USL(规格上限)',
  lsl: 'LSL(规格下限)',
  target: '目标值',
  subgroup: '子组',
  defectType: '不良类型',
  defectCount: '不良数量',
  date: '日期',
  batch: '批次',
  ignore: '忽略',
};

/** 把缺失角色列表转成中文文案。 */
function describeMissingRoles(roles: FieldRole[]): string {
  return roles.map((r) => ROLE_LABELS[r] ?? r).join('、');
}

/** 由 ArrayBuffer 读取工作簿并解析出 dimension / defect 两个 sheet。 */
export interface XlsxParseOutput {
  dimensionSheet: ParsedSheet | null;
  defectSheet: ParsedSheet | null;
  dimensionMapping: AutoMapResult | null;
  defectMapping: AutoMapResult | null;
  errors: RowError[];
  warnings: string[];
  measurementCount: number;
}

/** 判断 sheet 归属：'dimension' | 'defect' | null。 */
function classifySheet(name: string): 'dimension' | 'defect' | null {
  const n = name.toLowerCase();
  if (n.includes('dimension') || name.includes('尺寸') || name.includes('测量')) {
    return 'dimension';
  }
  if (n.includes('defect') || name.includes('不良') || name.includes('缺陷')) {
    return 'defect';
  }
  return null;
}

/** 将 SheetJS worksheet 转为统一 ParsedSheet（二维数组形式）。 */
function sheetToParsed(sheetName: string, ws: XLSX.WorkSheet): ParsedSheet {
  const matrix = XLSX.utils.sheet_to_json<RawCell[]>(ws, {
    header: 1,
    blankrows: false,
    defval: null,
    raw: true,
  });
  if (matrix.length === 0) {
    return { sheetName, header: [], rows: [], firstDataRowNumber: 2 };
  }
  const header = (matrix[0] ?? []).map((c) => cellToString(c));
  const rows = matrix.slice(1).map((r) => {
    const out: RawCell[] = [];
    for (let i = 0; i < header.length; i += 1) {
      const v = r[i];
      out.push(v === undefined ? null : v);
    }
    return out;
  });
  return { sheetName, header, rows, firstDataRowNumber: 2 };
}

/**
 * 自动列映射：按别名表把每个表头列解析为角色。
 *
 * @param sourceType 'dimension' | 'defect'
 */
export function autoMapColumns(sheet: ParsedSheet, sourceType: 'dimension' | 'defect'): AutoMapResult {
  const mapping: ColumnMapping = {};
  const unmappedColumns: { index: number; name: string }[] = [];
  const seenRoles = new Set<string>();

  sheet.header.forEach((name, index) => {
    const role = resolveRole(name);
    if (role === null || role === 'ignore') {
      unmappedColumns.push({ index, name });
      return;
    }
    // 同一角色只取第一列（避免如 material/batch 别名冲突取到多余列）。
    if (seenRoles.has(role)) {
      unmappedColumns.push({ index, name });
      return;
    }
    seenRoles.add(role);
    mapping[role] = index;
  });

  const missingRoles = requiredRoles(sourceType).filter((r) => !seenRoles.has(r));
  return { mapping, unmappedColumns, missingRoles };
}

/** 校验 dimension sheet 的必需映射与行级数值合法性。 */
function validateDimension(
  sheet: ParsedSheet,
  mapping: ColumnMapping,
): { errors: RowError[]; count: number } {
  const errors: RowError[] = [];
  const materialCol = mapping.material;
  const valueCol = mapping.value;
  if (materialCol === undefined || materialCol < 0) {
    throw new HogoError('IMPORT_COLUMN_MISMATCH', `工作表「${sheet.sheetName}」缺少「物料名称」列，无法导入。`, {
      sheet: sheet.sheetName,
    });
  }
  if (valueCol === undefined || valueCol < 0) {
    throw new HogoError('IMPORT_COLUMN_MISMATCH', `工作表「${sheet.sheetName}」缺少「测量值」列，无法导入。`, {
      sheet: sheet.sheetName,
    });
  }
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const rowNumber = sheet.firstDataRowNumber + i;
    const material = cellToString(row[materialCol]);
    if (material.length === 0) {
      errors.push({
        sheetName: sheet.sheetName,
        rowNumber,
        column: sheet.header[materialCol] ?? '物料名称',
        reason: '物料名称为空',
        rawValue: '',
      });
    }
    const parsed = parseNumericCell(row[valueCol]);
    if (parsed.value === null && parsed.invalidReason) {
      errors.push({
        sheetName: sheet.sheetName,
        rowNumber,
        column: sheet.header[valueCol] ?? '测量值',
        reason: parsed.invalidReason,
        rawValue: String(row[valueCol] ?? ''),
      });
    }
    // 规格限列若存在：解析非法值也报错。
    for (const key of ['usl', 'lsl', 'target'] as const) {
      const col = mapping[key];
      if (col === undefined || col < 0) continue;
      const p = parseNumericCell(row[col]);
      if (p.value === null && p.invalidReason) {
        errors.push({
          sheetName: sheet.sheetName,
          rowNumber,
          column: sheet.header[col] ?? key,
          reason: p.invalidReason,
          rawValue: String(row[col] ?? ''),
        });
      }
    }
  }
  return { errors, count: sheet.rows.length };
}

/** 校验 defect sheet。 */
function validateDefect(sheet: ParsedSheet, mapping: ColumnMapping): RowError[] {
  const errors: RowError[] = [];
  const typeCol = mapping.defectType;
  const countCol = mapping.defectCount;
  if (typeCol === undefined || typeCol < 0) {
    throw new HogoError('IMPORT_COLUMN_MISMATCH', `工作表「${sheet.sheetName}」缺少「不良类型」列。`, {
      sheet: sheet.sheetName,
    });
  }
  if (countCol === undefined || countCol < 0) {
    throw new HogoError('IMPORT_COLUMN_MISMATCH', `工作表「${sheet.sheetName}」缺少「不良数量」列。`, {
      sheet: sheet.sheetName,
    });
  }
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i];
    const rowNumber = sheet.firstDataRowNumber + i;
    const dtype = cellToString(row[typeCol]);
    if (dtype.length === 0) {
      errors.push({
        sheetName: sheet.sheetName,
        rowNumber,
        column: sheet.header[typeCol] ?? '不良类型',
        reason: '不良类型为空',
        rawValue: '',
      });
    }
    const parsed = parseCountCell(row[countCol]);
    if (parsed.value === null && parsed.invalidReason) {
      errors.push({
        sheetName: sheet.sheetName,
        rowNumber,
        column: sheet.header[countCol] ?? '不良数量',
        reason: parsed.invalidReason,
        rawValue: String(row[countCol] ?? ''),
      });
    }
  }
  return errors;
}

/**
 * 解析 xlsx 二进制（ArrayBuffer），返回解析结果（供列映射 UI 展示）。
 *
 * @throws {HogoError} IMPORT_EMPTY（无可用 sheet）
 * @throws {HogoError} IMPORT_PARSE_FAILED（文件损坏）
 * @throws {HogoError} IMPORT_COLUMN_MISMATCH（必需列缺失且无法自动匹配）
 */
export function parseXlsx(data: ArrayBuffer): XlsxParseOutput {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: 'array' });
  } catch (e) {
    throw new HogoError('IMPORT_PARSE_FAILED', 'xlsx 文件解析失败，请确认文件未损坏。', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const errors: RowError[] = [];
  const warnings: string[] = [];
  let dimensionSheet: ParsedSheet | null = null;
  let defectSheet: ParsedSheet | null = null;

  for (const name of wb.SheetNames) {
    const kind = classifySheet(name);
    if (kind === null) {
      warnings.push(`跳过无法识别的工作表「${name}」。`);
      continue;
    }
    const ws = wb.Sheets[name];
    if (!ws) continue;
    const parsed = sheetToParsed(name, ws);
    if (kind === 'dimension' && dimensionSheet === null) {
      dimensionSheet = parsed;
    } else if (kind === 'defect' && defectSheet === null) {
      defectSheet = parsed;
    } else {
      warnings.push(`工作表「${name}」为同类冗余 sheet，已忽略。`);
    }
  }

  if (dimensionSheet === null && defectSheet === null) {
    throw new HogoError(
      'IMPORT_EMPTY',
      '未找到可识别的工作表（需含 dimension/尺寸/测量 或 defect/不良/缺陷）。',
      { sheets: wb.SheetNames },
    );
  }

  let measurementCount = 0;
  let dimensionMapping: AutoMapResult | null = null;
  let defectMapping: AutoMapResult | null = null;

  if (dimensionSheet !== null) {
    if (dimensionSheet.header.length === 0 || dimensionSheet.rows.length === 0) {
      warnings.push('dimension 工作表为空。');
    } else {
      dimensionMapping = autoMapColumns(dimensionSheet, 'dimension');
      if (dimensionMapping.missingRoles.length > 0) {
        throw new HogoError(
          'IMPORT_COLUMN_MISMATCH',
          `工作表「${dimensionSheet.sheetName}」缺少必需列：${describeMissingRoles(dimensionMapping.missingRoles)}。`,
          { sheet: dimensionSheet.sheetName, missing: dimensionMapping.missingRoles },
        );
      }
      const v = validateDimension(dimensionSheet, dimensionMapping.mapping);
      errors.push(...v.errors);
      measurementCount = v.count;
      // 性能上限提示（架构 §0.2 #9）：超 20 万仅告警，不阻断、不截断、不抛错。
      const limitWarning = measurementLimitWarning(measurementCount, 'xlsx 文件');
      if (limitWarning !== null) {
        warnings.push(limitWarning);
      }
    }
  }

  if (defectSheet !== null) {
    if (defectSheet.header.length === 0 || defectSheet.rows.length === 0) {
      warnings.push('defect 工作表为空。');
    } else {
      defectMapping = autoMapColumns(defectSheet, 'defect');
      if (defectMapping.missingRoles.length > 0) {
        throw new HogoError(
          'IMPORT_COLUMN_MISMATCH',
          `工作表「${defectSheet.sheetName}」缺少必需列：${describeMissingRoles(defectMapping.missingRoles)}。`,
          { sheet: defectSheet.sheetName, missing: defectMapping.missingRoles },
        );
      }
      errors.push(...validateDefect(defectSheet, defectMapping.mapping));
    }
  }

  return {
    dimensionSheet,
    defectSheet,
    dimensionMapping,
    defectMapping,
    errors,
    warnings,
    measurementCount,
  };
}
