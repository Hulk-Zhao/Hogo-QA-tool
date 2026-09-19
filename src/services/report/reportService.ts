/**
 * reportService —— 报表导出的服务层（Excel 下载 / 打印）。
 *
 * 出处：架构文档 T04；PRD P0-18；§0.2 #1（Excel 只出数据 sheet，不含图片；
 * 打印走浏览器原生，**不引入 jsPDF**）。
 *
 * 设计：
 *   - `buildReportModel` / `buildExcelReport` 已在 `@/data/exporter` 实现
 *     （4 sheet、无图片），本服务只做「下载 / 打印」这两件带副作用的事，
 *     并把这些副作用封装为可注入接口，便于在 node 环境单测编排逻辑。
 *   - 导出范围勾选（`ExportOptions`）见 `./exportOptions`：数据表项作用于页面
 *     预览与打印/PDF，图表项仅作用于打印/PDF（Excel 永不含图片，架构硬约束）。
 */

import { buildExcelReport, defaultReportFileName } from '@/data/exporter/excelReport';
import { buildReportModel, type ReportModel } from '@/data/exporter/reportModel';
import type { Project } from '@/data/schema';
import { hasAnyChartOption, type ExportOptions } from './exportOptions';

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

/**
 * 导出 Excel 日报（≥4 sheet，无图片）。
 *
 * @param model 报表中间模型
 * @param save 保存函数（默认浏览器下载）
 * @returns 生成的文件名
 */
export function exportExcelReport(model: ReportModel, save: SaveBlobFn = downloadBlob): string {
  const buffer = buildExcelReport(model);
  const fileName = defaultReportFileName(model);
  save(buffer, fileName, XLSX_MIME);
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