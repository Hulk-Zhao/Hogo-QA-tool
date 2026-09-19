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
 *   - 图像勾选项仅作用于**打印/PDF**，对 Excel 无效（架构硬约束）。
 */

import { buildExcelReport, defaultReportFileName } from '@/data/exporter/excelReport';
import { buildReportModel, type ReportModel } from '@/data/exporter/reportModel';
import type { Project } from '@/data/schema';

/** 导出选项。 */
export interface ExportOptions {
  /** 是否在打印输出中包含控制图/柏拉图截图（仅影响打印，不影响 Excel）。 */
  includeChartImagesInPrint: boolean;
  /** 是否包含数据表。 */
  includeTables: boolean;
}

/** 默认导出选项。 */
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  includeChartImagesInPrint: true,
  includeTables: true,
};

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
 * `includeChartImagesInPrint` 通过给根节点加/去 `.print-hide-charts` 类
 * 切换是否打印图像（纯 CSS 行为，不涉及 jsPDF）。
 *
 * @param options 导出选项
 * @param printFn 打印函数（默认 window.print；可注入便于测试）
 * @returns 是否成功触发打印
 */
export function printReport(
  options: ExportOptions,
  printFn: () => void = defaultPrint,
): boolean {
  applyPrintClass(options.includeChartImagesInPrint);
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
