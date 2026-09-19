/**
 * excelReport 的「AI 分析」sheet 测试（P4-B）。
 *
 * 证伪立场：
 *  - 若不追加 sheet → 「5 个表名，最后是 AI 分析」变红；
 *  - 若 aiRows 为空也追加空表 → 「没有分析时不追加空 sheet」变红；
 *  - 若表头/列顺序变了 → 「表头与列顺序」变红。
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  AI_SHEET_COLUMN_WIDTHS,
  AI_SHEET_LINE_MAX_DISPLAY_CHARS,
  AI_SHEET_NAME,
  aiSheetAoa,
  analysisToLines,
  buildExcelReport,
} from '../excelReport';
import { readZipEntries } from '../zipStore';
import type { ReportModel } from '../reportModel';

function makeModel(): ReportModel {
  return {
    projectName: '测试项目',
    generatedAt: '2026-09-19T08:00:00.000Z',
    cpkSummary: [],
    defectStats: [],
    rawDimensions: [],
    rawDefects: [],
    warnings: [],
  };
}

describe('aiSheetAoa', () => {
  it('表头固定为 报表模块 / 状态 / 模型 / AI 分析', () => {
    const aoa = aiSheetAoa([
      { module: 'CPK 汇总', status: '已生成', model: 'qwen3.5:9b', analysis: '正文' },
    ]);
    expect(aoa[0]).toEqual(['报表模块', '状态', '模型', 'AI 分析']);
    expect(aoa[1]).toEqual(['CPK 汇总', '已生成', 'qwen3.5:9b', '正文']);
  });

  it('★ 多行正文：每个要点各占一行，模块信息只在首行（不再一格里堆一整段）', () => {
    const aoa = aiSheetAoa([
      {
        module: 'CPK 汇总',
        status: '已生成',
        model: 'deepseek-chat',
        analysis: '### 能力结论\n- 外壳长度 Cpk=3.65 高于 1.33\n- 转轴直径 Ppk=1.55 偏低',
      },
    ]);
    expect(aoa).toEqual([
      ['报表模块', '状态', '模型', 'AI 分析'],
      ['CPK 汇总', '已生成', 'deepseek-chat', '【能力结论】'],
      ['', '', '', '• 外壳长度 Cpk=3.65 高于 1.33'],
      ['', '', '', '• 转轴直径 Ppk=1.55 偏低'],
    ]);
  });

  it('analysisToLines：去掉 Markdown 标记、丢分隔线、表格行压成一行文本', () => {
    const lines = analysisToLines(
      [
        '### 三、改善建议',
        '',
        '---',
        '1. 收紧上公差',
        '| 特性 | Cpk |',
        '| --- | --- |',
        '| 外壳长度 | 3.65 |',
        '**重点**：先处理转轴直径',
      ].join('\n'),
    );
    expect(lines).toEqual([
      '【三、改善建议】',
      '1. 收紧上公差',
      '特性 ｜ Cpk',
      '外壳长度 ｜ 3.65',
      '重点：先处理转轴直径',
    ]);
  });

  it('超长单行按显示宽度硬折行（中文算 2），不会拖出一条看不到头的单元格', () => {
    const long = '外壳长度' + '偏' .repeat(0) + '测'.repeat(300);
    const lines = analysisToLines(long);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(AI_SHEET_LINE_MAX_DISPLAY_CHARS / 2 + 1);
    }
    expect(lines.join('')).toBe(long);
  });

});

describe('buildExcelReport 与 AI sheet 的接线', () => {
  it('★ 产物里 AI sheet 带列宽 + 断行（SheetJS 社区版没有 wrapText，只能靠列宽+逐行切断）', () => {
    const buffer = buildExcelReport(makeModel(), [
      { module: 'CPK 汇总', status: '已生成', model: 'm', analysis: '第一行\n第二行' },
    ]);
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[AI_SHEET_NAME] as XLSX.WorkSheet;
    expect(sheet.A2?.v).toBe('CPK 汇总');
    expect(sheet.D2?.v).toBe('第一行');
    expect(sheet.D3?.v).toBe('第二行');
    expect(sheet.A3?.v ?? '').toBe(''); // 续行不重复模块名（SheetJS 会写出空串单元格）

    // 列宽读不回来（SheetJS 读回会丢掉 <cols>），所以直接查产物 XML —— 这也更接近真值。
    const decoder = new TextDecoder();
    const aiSheetXml = readZipEntries(buffer)
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .map((e) => decoder.decode(e.data))
      .find((xml) => xml.includes('报表模块'));
    expect(aiSheetXml, '产物里必须能找到 AI 分析 sheet').toBeTruthy();
    expect(aiSheetXml).toContain('<cols>');
    const col4 = /<col min="4" max="4" width="([\d.]+)"/.exec(aiSheetXml as string);
    expect(col4, '正文列必须显式给宽').toBeTruthy();
    expect(Number((col4 as RegExpExecArray)[1])).toBeGreaterThanOrEqual(AI_SHEET_COLUMN_WIDTHS[3]);
  });

  it('没有 AI 行 / 空数组 → 不追加空 sheet（保持 4 个数据表）', () => {
    for (const rows of [undefined, []]) {
      const wb = XLSX.read(buildExcelReport(makeModel(), rows), { type: 'array' });
      expect(wb.SheetNames).toEqual(['CPK汇总', '不良统计', '原始尺寸', '原始不良']);
      expect(wb.SheetNames).not.toContain(AI_SHEET_NAME);
    }
  });
});
