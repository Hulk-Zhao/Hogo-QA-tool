/**
 * reportService —— 报表导出的服务层（Excel 下载 / 打印）。
 *
 * 出处：架构文档 T04；PRD P0-18；§0.2 #1（打印走浏览器原生，**不引入 jsPDF**）。
 *
 * ⚠️ 架构里那句「Excel 只出数据 sheet，不含图片」已被用户需求推翻
 * （2026-09-19「给导出 excel也添加图片」）：现在导出会**顺带采集报表页上
 * 已渲染的图表**，以独立的「图表」sheet 内嵌 PNG；页面上没有图表（例如从
 * 顶栏在其它页面触发的「一键日报」）时自动退化为纯数据文件。
 *
 * 设计：
 *   - `buildReportModel` / `buildExcelReport` 已在 `@/data/exporter` 实现
 *     （4 sheet、无图片），本服务只做「下载 / 打印」这两件带副作用的事，
 *     并把这些副作用封装为可注入接口，便于在 node 环境单测编排逻辑。
 *   - 导出范围勾选（`ExportOptions`）见 `./exportOptions`：数据表项作用于页面
 *     预览与打印/PDF；图表项作用于打印/PDF 与 Excel 内嵌图片。
 */

import {
  buildExcelReport,
  defaultReportFileName,
  type AiSheetRow,
} from '@/data/exporter/excelReport';
import { embedChartImages, type ChartImage } from '@/data/exporter/excelImages';
import { collectChartImages } from './chartImageCollector';
import { buildReportModel, type ReportModel } from '@/data/exporter/reportModel';
import type { Project } from '@/data/schema';
import { hasAnyChartOption, type ExportOptions } from './exportOptions';
import {
  aiReportFileName,
  buildAiReportMarkdown,
  type AiReportMeta,
} from './aiReportDoc';
import {
  aiReportDocxFileName,
  buildAiReportDocx,
  DOCX_MIME,
  type DocxReportOptions,
} from './docxReport';
import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';

/*
 * ExportOptions / DEFAULT_EXPORT_OPTIONS 已迁至 `./exportOptions`：
 * store 层需持久化该结构（第五轮需求 #11「勾选状态走 settingsStore」），
 * 而本文件经 `excelReport` 间接依赖 `xlsx`（体积大），拆出纯类型模块可让
 * store 零成本引用。此处转发导出以兼容既有调用点。
 */
export {
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_OPTION_KEYS,
  TABLE_OPTION_KEYS,
  CHART_OPTION_KEYS,
  sanitizeExportOptions,
  hasAnyExportOption,
  hasAnyChartOption,
} from './exportOptions';
export type { ExportOptions } from './exportOptions';

/** 文件保存函数签名（可注入，便于测试）。 */
export type SaveBlobFn = (data: ArrayBuffer, fileName: string, mime: string) => void;

/**
 * 触发浏览器下载（默认实现）。
 *
 * @param data 二进制数据
 * @param fileName 文件名
 * @param mime MIME 类型
 */
export function downloadBlob(data: ArrayBuffer, fileName: string, mime: string): void {
  if (typeof document === 'undefined') {
    return;
  }
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Excel MIME。 */
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * 由项目构造报表中间模型。
 *
 * @param project 项目
 * @param datasetId 指定数据集（可选）
 * @returns 报表中间模型
 */
export function buildModel(project: Project, datasetId?: string): ReportModel {
  return buildReportModel(project, datasetId);
}

/** 导出结果。 */
export interface ExcelExportResult {
  /** 文件名。 */
  fileName: string;
  /** 内嵌的图表数量（0 = 本次没有可用图表，退化为纯数据文件）。 */
  imageCount: number;
  /** 追加进「AI 分析」sheet 的模块数（0 = 本次没有 AI 分析结果，不追加该 sheet）。 */
  aiModuleCount: number;
}

/**
 * 导出 Excel 日报（数据 sheet + 可选「AI 分析」sheet + 可选「图表」sheet 内嵌图片）。
 *
 * @param model 报表中间模型
 * @param save 保存函数（默认浏览器下载）
 * @param collect 图表采集函数（默认读当前页面上的图表画布，可注入便于测试）
 * @param aiRows AI 分析行（有则追加「AI 分析」sheet；不传则不追加）
 * @returns 文件名、内嵌图片数量与 AI 分析模块数
 */
export function exportExcelReportDetailed(
  model: ReportModel,
  save: SaveBlobFn = downloadBlob,
  collect: () => ChartImage[] = collectChartImages,
  aiRows?: AiSheetRow[],
): ExcelExportResult {
  const dataOnly = buildExcelReport(model, aiRows);
  const images = collect();
  const buffer = images.length > 0 ? embedChartImages(dataOnly, images) : dataOnly;
  const fileName = defaultReportFileName(model);
  save(buffer, fileName, XLSX_MIME);
  return { fileName, imageCount: images.length, aiModuleCount: aiRows?.length ?? 0 };
}

/**
 * 导出 Excel 日报（兼容入口，只关心文件名）。
 *
 * @param model 报表中间模型
 * @param save 保存函数（默认浏览器下载）
 * @returns 生成的文件名
 */
export function exportExcelReport(model: ReportModel, save: SaveBlobFn = downloadBlob): string {
  return exportExcelReportDetailed(model, save).fileName;
}

/**
 * 导出「AI 分析报表」Markdown 文件。
 *
 * 与 Excel 的关系：Markdown 适合直接贴进邮件/评审纪要；Excel 的「AI 分析」sheet
 * 适合与数据表放在同一个文件里交付。两者共用同一份 `ModuleAnalysis[]`。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析结果
 * @param meta 元信息（模型 / 方向 / 生成时间）
 * @param save 保存函数（默认浏览器下载）
 * @returns 文件名
 */
export function exportAiReportMarkdown(
  model: ReportModel,
  analyses: readonly ModuleAnalysis[],
  meta: AiReportMeta,
  save: SaveBlobFn = downloadBlob,
): string {
  const markdown = buildAiReportMarkdown(model, analyses, meta);
  const fileName = aiReportFileName(model);
  const bytes = new TextEncoder().encode(markdown);
  // 拷贝到独立 ArrayBuffer：TextEncoder 的 buffer 可能大于实际字节数。
  save(bytes.slice().buffer, fileName, 'text/markdown;charset=utf-8');
  return fileName;
}

/**
 * 导出「AI 分析报表」Word(.docx) 文件。
 *
 * 用户反馈 Excel 里的长文排版不可读，故在 Markdown / Excel 之外再给一个 Word 出口：
 * 同一份 `ModuleAnalysis[]`，由 `docxReport` 渲染为真正的标题层级 / 项目符号 / 表格。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析结果
 * @param meta 元信息（模型 / 方向 / 生成时间）
 * @param save 保存函数（默认浏览器下载）
 * @param options 选项（图表 PNG；不传 = 只出文字）
 * @returns 文件名
 */
export function exportAiReportWord(
  model: ReportModel,
  analyses: readonly ModuleAnalysis[],
  meta: AiReportMeta,
  save: SaveBlobFn = downloadBlob,
  options: DocxReportOptions = {},
): string {
  const buffer = buildAiReportDocx(model, analyses, meta, options);
  const fileName = aiReportDocxFileName(model);
  save(buffer, fileName, DOCX_MIME);
  return fileName;
}

/**
 * 触发浏览器打印（PDF 经原生「打印 → 另存为 PDF」）。
 *
 * 打印样式由 `src/print.css` 提供：隐藏 .no-print、图表/表格分页控制。
 * `printReport` 只负责「按勾选结果给根节点加/去 `.print-hide-charts` 类」
 * （图区整体兜底隐藏），具体每张图表/每张表的取舍由 `ReportPage` 按同一份
 * `ExportOptions` 条件渲染完成 —— 即页面所见即打印所得。
 *
 * @param options 导出选项
 * @param printFn 打印函数（默认 window.print；可注入便于测试）
 * @returns 是否成功触发打印
 */
export function printReport(
  options: ExportOptions,
  printFn: () => void = defaultPrint,
): boolean {
  applyPrintClass(hasAnyChartOption(options));
  printFn();
  return true;
}

/**
 * 默认打印实现（浏览器原生）。
 */
export function defaultPrint(): void {
  if (typeof window !== 'undefined' && typeof window.print === 'function') {
    window.print();
  }
}

/** 打印时用于切换图像可见性的根类名。 */
export const PRINT_HIDE_CHARTS_CLASS = 'print-hide-charts';

/**
 * 应用打印类（是否隐藏图像）。
 *
 * @param includeCharts 是否在打印中包含图像
 */
export function applyPrintClass(includeCharts: boolean): void {
  if (typeof document === 'undefined') {
    return;
  }
  const body = document.body;
  if (includeCharts) {
    body.classList.remove(PRINT_HIDE_CHARTS_CLASS);
  } else {
    body.classList.add(PRINT_HIDE_CHARTS_CLASS);
  }
}