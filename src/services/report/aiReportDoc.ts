/**
 * aiReportDoc —— 「AI 分析报表」的文档产物（Markdown + Excel 表行）。
 *
 * 纯函数，无 DOM / 网络依赖，可 Node 裸跑。
 *
 * 诚实口径（重要）：
 *  - 没拿到 AI 正文的模块**不会**被悄悄省略，而是在文档末尾的
 *    「未生成分析的模块」里逐条列出原因（无数据 / 失败 / 已中止）；
 *  - 文档头部写明「数据口径：仅发送统计摘要」，让交付方一眼看到发送范围。
 */

import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';
import { focusLabels, type AnalysisFocusId } from '@/services/ai/analysisFocus';
import type { ReportModel } from '@/data/exporter/reportModel';
import type { AiSheetRow } from '@/data/exporter/excelReport';

/** Markdown 与 Excel sheet 的统一标题。 */
export const AI_REPORT_TITLE = 'AI 分析';

/** 中文小节序号（1..10，超出回退为阿拉伯数字）。 */
const CN_NUMBERS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/**
 * 生成小节序号。
 *
 * @param index 从 0 开始的序号
 * @returns 「一」「二」…；超出范围返回数字字符串
 */
export function cnOrdinal(index: number): string {
  return CN_NUMBERS[index] ?? String(index + 1);
}

/** AI 报表的元信息。 */
export interface AiReportMeta {
  /** 本次使用的模型名（可能为空 = 未成功调用）。 */
  model: string;
  /** 分析方向。 */
  focusIds: readonly AnalysisFocusId[];
  /** 生成时间（ISO）。 */
  generatedAt?: string;
}

/**
 * 生成「AI 分析报表」Markdown。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析结果
 * @param meta 元信息
 * @returns Markdown 文本
 */
export function buildAiReportMarkdown(
  model: ReportModel,
  analyses: readonly ModuleAnalysis[],
  meta: AiReportMeta,
): string {
  const generated = new Date(meta.generatedAt ?? Date.now());
  const generatedText = Number.isNaN(generated.getTime())
    ? String(meta.generatedAt ?? '')
    : generated.toLocaleString('zh-CN');
  const labels = focusLabels(meta.focusIds);

  const sections: string[] = [];
  sections.push(`# ${AI_REPORT_TITLE}报表 —— ${model.projectName}`);
  sections.push(
    [
      `> 生成时间：${generatedText}`,
      `> 使用模型：${meta.model.trim().length > 0 ? meta.model : '（未成功调用）'}`,
      `> 分析方向：${labels.length > 0 ? labels.join('、') : '未选择'}`,
      '> 数据口径：仅发送统计摘要，未发送逐条原始测量值。',
    ].join('\n'),
  );

  const done = analyses.filter((a) => a.ok);
  const notDone = analyses.filter((a) => !a.ok);

  sections.push(
    `本报表共 ${analyses.length} 个模块，其中 ${done.length} 个已生成 AI 分析、`
    + `${notDone.length} 个未生成（原因见文末）。`,
  );

  analyses.forEach((a, i) => {
    sections.push(`## ${cnOrdinal(i)}、${a.title}`);
    if (a.ok) {
      sections.push(a.markdown);
    } else {
      sections.push(`_未生成 AI 分析：${a.errorMessage ?? a.skipReason ?? '未知原因'}_`);
    }
  });

  if (notDone.length > 0) {
    sections.push('## 附：未生成分析的模块与原因');
    sections.push(
      notDone
        .map((a) => `- ${a.title}：${a.errorMessage ?? a.skipReason ?? '未知原因'}`)
        .join('\n'),
    );
  }

  sections.push('---');
  sections.push(
    '_AI 分析由 Hogo-QA-tool 调用用户自行配置的 LLM 生成，仅为统计量的解读建议，'
    + '不替代质量判定与工程评审；请对照本文件上方各模块的统计表复核。_',
  );

  return sections.join('\n\n');
}

/**
 * 把分析结果转成 Excel「AI 分析」sheet 的表行。
 *
 * @param analyses 逐模块分析结果
 * @returns 表行
 */
export function toAiSheetRows(analyses: readonly ModuleAnalysis[]): AiSheetRow[] {
  return analyses.map((a) => {
    let status = '已生成';
    if (!a.ok) {
      status = a.skipReason
        ? `未生成（${a.skipReason}）`
        : `失败（${a.errorMessage ?? '未知原因'}）`;
    }
    return {
      module: a.title,
      status,
      model: a.model,
      analysis: a.ok ? a.markdown : '',
    };
  });
}

/**
 * AI 报表的文件名（含日期）。
 *
 * @param model 报表中间模型
 * @returns 文件名（.md）
 */
export function aiReportFileName(model: ReportModel): string {
  const d = model.generatedAt.slice(0, 10);
  return `${model.projectName || '质量报表'}_${d}_AI分析.md`;
}

/**
 * 项目名 + 方向数构造一个稳定的结果签名，用于判断「界面上的分析结果是否还对应当前数据」。
 *
 * @param model 报表中间模型
 * @param focusIds 分析方向
 * @returns 签名
 */
export function analysisSignature(
  model: ReportModel,
  focusIds: readonly AnalysisFocusId[],
): string {
  return [
    model.projectName,
    model.generatedAt,
    model.cpkSummary.length,
    model.defectStats.length,
    model.rawDimensions.length,
    focusLabels(focusIds).join('|'),
  ].join('::');
}
