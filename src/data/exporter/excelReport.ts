/**
 * excelReport：日报 Excel 导出（4 个数据 sheet；图表图片由 excelImages 追加）。
 *
 * 出处：PRD P0-18；架构 §0.2 #1 的「Excel 只出数据 sheet」已被用户需求推翻
 * （2026-09-19：「给导出 excel 也添加图片」）——图片由 `embedChartImages` 以
 * 独立的「图表」sheet 内嵌，本函数仍只负责数据，保持纯函数与可单测性。
 * sheet：CPK汇总 / 不良统计 / 原始尺寸 / 原始不良（+ 可选「AI 分析」+ 可选「图表」）。
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
 * 「AI 分析」sheet 的一行。
 *
 * 刻意定义在 data 层、只要求**结构等价**（不 import services 的类型）：
 * `services/report/aiReportDoc` 负责把 `ModuleAnalysis[]` 转成这个形状，
 * 从而保持 data 层不反向依赖 services 层。
 */
export interface AiSheetRow {
  /** 报表模块名（如「CPK 汇总」）。 */
  module: string;
  /** 状态文案（已生成 / 未生成（原因）/ 失败（原因））。 */
  status: string;
  /** 产出该段分析的模型名。 */
  model: string;
  /** AI 分析正文（Markdown）。 */
  analysis: string;
}

/** 「AI 分析」sheet 的表名。 */
export const AI_SHEET_NAME = 'AI 分析';

/** 「AI 分析」sheet 的列宽（字符数）。正文列给足宽度，避免一格里塞整段。 */
export const AI_SHEET_COLUMN_WIDTHS = [18, 22, 18, 100];

/** 正文列的硬折行宽度（按显示宽度计：中文算 2）。 */
export const AI_SHEET_LINE_MAX_DISPLAY_CHARS = 100;

/** 判断是否宽字符（CJK / 全角），用于折行时的宽度估算。 */
function displayWidth(ch: string): number {
  return /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
    ? 2
    : 1;
}

/** 按显示宽度硬折行（长句不在单元格里拖出一条看不到头的行）。 */
function wrapByDisplayWidth(text: string, max: number): string[] {
  if (text.length === 0) {
    return [];
  }
  const out: string[] = [];
  let current = '';
  let width = 0;
  for (const ch of text) {
    const w = displayWidth(ch);
    if (width + w > max && current.length > 0) {
      out.push(current);
      current = '';
      width = 0;
    }
    current += ch;
    width += w;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/** 去掉行内 Markdown 标记（Excel 单元格不渲染 Markdown，留着只会更难读）。 */
export function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

/** Markdown 表格行 → 一行可读文本（Excel 里放不下真正的表结构）。 */
function flattenTableRow(line: string): string {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0)
    .join(' ｜ ');
}

/** 是否 Markdown 表格的分隔行（|---|---|）。 */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/**
 * 把一段 Markdown 分析正文切成「一行一句」的纯文本行。
 *
 * 为什么必须切：实测把整段 Markdown（含 `###`、`-`）塞进一个单元格后，
 * 用户看到的是一格巨宽、无法阅读的文本（截图反馈「排版太乱」）。
 *
 * @param markdown 分析正文（Markdown）
 * @returns 逐行纯文本
 */
export function analysisToLines(markdown: string): string[] {
  const out: string[] = [];
  for (const rawLine of (markdown ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (/^[-*_]{3,}$/.test(line)) {
      continue; // 分隔线在表格里没有意义
    }
    let text: string;
    const heading = /^#{1,6}\s*(.+)$/.exec(line);
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (heading) {
      text = `【${stripMarkdownInline(heading[1])}】`;
    } else if (line.startsWith('|')) {
      if (isTableSeparator(line)) {
        continue;
      }
      text = flattenTableRow(line);
    } else if (bullet) {
      text = `• ${stripMarkdownInline(bullet[1])}`;
    } else if (ordered) {
      text = `${ordered[1]}. ${stripMarkdownInline(ordered[2])}`;
    } else {
      text = stripMarkdownInline(line);
    }
    out.push(...wrapByDisplayWidth(text, AI_SHEET_LINE_MAX_DISPLAY_CHARS));
  }
  return out;
}

/**
 * 构造「AI 分析」sheet 的二维数组。
 *
 * 版式：每个模块第一行给出「模块 / 状态 / 模型 + 正文首行」，后续正文各占一行
 * （左侧三列留空，视觉上归属上面那个模块）。这样配合 `AI_SHEET_COLUMN_WIDTHS`
 * 的列宽，任何一段分析都是可读的多行文本，而不是一格里的一坨。
 *
 * @param rows AI 分析行
 * @returns 表行
 */
export function aiSheetAoa(rows: AiSheetRow[]): (string | number)[][] {
  const header = ['报表模块', '状态', '模型', 'AI 分析'];
  const out: (string | number)[][] = [header];
  for (const r of rows) {
    const lines = analysisToLines(r.analysis);
    if (lines.length === 0) {
      out.push([r.module, r.status, r.model, r.analysis.trim()]);
      continue;
    }
    out.push([r.module, r.status, r.model, lines[0]]);
    for (const line of lines.slice(1)) {
      out.push(['', '', '', line]);
    }
  }
  return out;
}/**
 * 由报表中间模型生成 xlsx 二进制（ArrayBuffer）。
 *
 * @param model 报表中间模型
 * @param aiRows 可选的 AI 分析行（有则追加一个「AI 分析」sheet）
 * @returns xlsx 文件二进制
 */
export function buildExcelReport(model: ReportModel, aiRows?: AiSheetRow[]): ArrayBuffer {
  const wb = XLSX.utils.book_new();

  const wsCpk = XLSX.utils.aoa_to_sheet(cpkSheetAoa(model));
  const wsDefect = XLSX.utils.aoa_to_sheet(defectSheetAoa(model));
  const wsRawDim = XLSX.utils.aoa_to_sheet(rawDimensionAoa(model));
  const wsRawDef = XLSX.utils.aoa_to_sheet(rawDefectAoa(model));

  XLSX.utils.book_append_sheet(wb, wsCpk, 'CPK汇总');
  XLSX.utils.book_append_sheet(wb, wsDefect, '不良统计');
  XLSX.utils.book_append_sheet(wb, wsRawDim, '原始尺寸');
  XLSX.utils.book_append_sheet(wb, wsRawDef, '原始不良');

  // 「AI 分析」sheet（P4-B 新增）：只有真的生成了分析才追加，不产出空表。
  if (aiRows && aiRows.length > 0) {
    const wsAi = XLSX.utils.aoa_to_sheet(aiSheetAoa(aiRows));
    // 列宽必须显式给：SheetJS 社区版不支持单元格级 wrapText（实测产物里没有该属性），
    // 只能靠「列宽 + 逐行切断」保证可读性（见 analysisToLines）。
    wsAi['!cols'] = AI_SHEET_COLUMN_WIDTHS.map((wch) => ({ wch }));
    XLSX.utils.book_append_sheet(wb, wsAi, AI_SHEET_NAME);
  }

  // compression: false —— 必须。
  // 浏览器侧没有同步 inflate（DecompressionStream 是异步的），
  // 而未压缩包可以直接按本地文件头解析、改 XML、再打包（见 zipStore）。
  // 代价实测约 +2.4 倍包体，绝对值只有几十 KB。
  const out = XLSX.write(wb, {
    bookType: 'xlsx',
    type: 'array',
    compression: false,
  }) as ArrayBuffer;
  return out;
}

/** 默认报表文件名（含日期）。 */
export function defaultReportFileName(model: ReportModel): string {
  const d = model.generatedAt.slice(0, 10);
  return `${model.projectName || '质量日报'}_${d}.xlsx`;
}
