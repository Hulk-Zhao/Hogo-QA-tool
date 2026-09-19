/**
 * report 服务层统一导出。
 *
 * 出处：架构文档 T04（`src/services/report/**`）。
 */

export {
  buildModel,
  exportExcelReport,
  exportExcelReportDetailed,
  exportAiReportMarkdown,
  exportAiReportWord,
  printReport,
  defaultPrint,
  applyPrintClass,
  downloadBlob,
  DEFAULT_EXPORT_OPTIONS,
  EXPORT_OPTION_KEYS,
  TABLE_OPTION_KEYS,
  CHART_OPTION_KEYS,
  sanitizeExportOptions,
  hasAnyExportOption,
  hasAnyChartOption,
  PRINT_HIDE_CHARTS_CLASS,
  XLSX_MIME,
  type ExportOptions,
  type SaveBlobFn,
} from './reportService';

export { collectChartImages } from './chartImageCollector';

export {
  DOCX_MIME,
  aiReportDocxFileName,
  buildAiReportDocx,
  documentBodyXml,
  parseMarkdownBlocks,
  parseInlineRuns,
  escapeXml,
  type DocBlock,
  type DocRun,
} from './docxReport';

export {
  AI_REPORT_TITLE,
  aiReportFileName,
  analysisSignature,
  buildAiReportMarkdown,
  cnOrdinal,
  toAiSheetRows,
  type AiReportMeta,
} from './aiReportDoc';