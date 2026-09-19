/**
 * excelReport：日报 Excel 导出（≥4 sheet，无图片）。
 *
 * 出处：PRD P0-18；架构 §0.2 #1（Excel 只出数据 sheet，不含图片）。
 * sheet：CPK汇总 / 不良统计 / 原始尺寸 / 原始不良。
 *
 * 精度：core 内部全程完整 double；仅在本序列化边界按约定舍入
 * （指数 4 位、西格玛水平 2 位、占比 2 位、PPM 整数，架构 §8.2）。
 */

import * as XLSX from 'xlsx';
import { DECIMALS_INDEX, DECIMALS_RATIO, DECIMALS_SIGMA } from '../format';
import type { ReportModel } from './reportModel';

/** 按小数位四舍五入；null 原样返回。 */
export function roundOrNull(value: number | null, decimals: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** PPM 取整（四舍五入）。 */
function roundPpm(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value);
}

/** 构造 CPK 汇总 sheet 的二维数组。 */
function cpkSheetAoa(model: ReportModel): (string | number | null)[][] {
  const header = [
    '特性',
    'n',
    '均值',
    'σ_within',
    'σ_overall',
    'USL',
    'LSL',
    'Ca',
    'Cp',
    'Cpk',
    'Pp',
    'Ppk',
    '西格玛水平(3Cpk)',
    '西格玛水平(3Cpk+1.5)',
    'PPM(整体)',
  ];
  const rows = model.cpkSummary.map((r) => [
    r.characteristic,
    r.n,
    roundOrNull(r.mean, DECIMALS_INDEX),
    roundOrNull(r.sigmaWithin, DECIMALS_INDEX),
    roundOrNull(r.sigmaOverall, DECIMALS_INDEX),
    roundOrNull(r.usl, DECIMALS_INDEX),
    roundOrNull(r.lsl, DECIMALS_INDEX),
    roundOrNull(r.ca, DECIMALS_INDEX),
    roundOrNull(r.cp, DECIMALS_INDEX),
    roundOrNull(r.cpk, DECIMALS_INDEX),
    roundOrNull(r.pp, DECIMALS_INDEX),
    roundOrNull(r.ppk, DECIMALS_INDEX),
    roundOrNull(r.sigmaLevelShort, DECIMALS_SIGMA),
    roundOrNull(r.sigmaLevelBench, DECIMALS_SIGMA),
    roundPpm(r.ppmOverall),
  ]);
  return [header, ...rows];
}

/** 不良统计 sheet。 */
function defectSheetAoa(model: ReportModel): (string | number)[][] {
  const header = ['不良类型', '不良数量', '占比(%)', '累计占比(%)'];
  const rows = model.defectStats.map((r) => [
    r.defectType,
    r.count,
    roundOrNull(r.ratio, DECIMALS_RATIO) ?? 0,
    roundOrNull(r.cumRatio, DECIMALS_RATIO) ?? 0,
  ]);
  return [header, ...rows];
}

/** 原始尺寸 sheet。 */
function rawDimensionAoa(model: ReportModel): (string | number | null)[][] {
  const header = ['物料名称', '序号', '测量值', 'USL', 'LSL'];
  const rows = model.rawDimensions.map((r) => [
    r.characteristic,
    r.index,
    r.value,
    r.usl,
    r.lsl,
  ]);
  return [header, ...rows];
}

/** 原始不良 sheet。 */
function rawDefectAoa(model: ReportModel): (string | number)[][] {
  const header = ['不良类型', '不良数量', '类别'];
  const rows = model.rawDefects.map((r) => [r.defectType, r.count, r.category]);
  return [header, ...rows];
}

/**
 * 由报表中间模型生成 xlsx 二进制（ArrayBuffer）。
 *
 * @param model 报表中间模型
 * @returns xlsx 文件二进制
 */
export function buildExcelReport(model: ReportModel): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  const wsCpk = XLSX.utils.aoa_to_sheet(cpkSheetAoa(model));
  const wsDefect = XLSX.utils.aoa_to_sheet(defectSheetAoa(model));
  const wsRawDim = XLSX.utils.aoa_to_sheet(rawDimensionAoa(model));
  const wsRawDef = XLSX.utils.aoa_to_sheet(rawDefectAoa(model));

  XLSX.utils.book_append_sheet(wb, wsCpk, 'CPK汇总');
  XLSX.utils.book_append_sheet(wb, wsDefect, '不良统计');
  XLSX.utils.book_append_sheet(wb, wsRawDim, '原始尺寸');
  XLSX.utils.book_append_sheet(wb, wsRawDef, '原始不良');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return out;
}

/** 默认报表文件名（含日期）。 */
export function defaultReportFileName(model: ReportModel): string {
  const d = model.generatedAt.slice(0, 10);
  return `${model.projectName || '质量日报'}_${d}.xlsx`;
}
