/**
 * aiReportDoc 测试（P4-B：AI 分析报表的文档产物）。
 *
 * 证伪立场：
 *  - 若把没拿到正文的模块悄悄省略 → 「未生成模块显式列出」变红；
 *  - 若不写「只发送统计摘要」口径 → 「数据口径声明」变红；
 *  - 若 Excel 表行把失败模块也标成「已生成」→ 「状态文案」变红。
 */

import { describe, expect, it } from 'vitest';
import {
  aiReportFileName,
  analysisSignature,
  buildAiReportMarkdown,
  cnOrdinal,
  toAiSheetRows,
} from '../aiReportDoc';
import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';
import type { ReportModel } from '@/data/exporter/reportModel';

function makeModel(): ReportModel {
  return {
    projectName: '外壳长度项目',
    generatedAt: '2026-09-19T08:00:00.000Z',
    cpkSummary: [],
    defectStats: [],
    rawDimensions: [],
    rawDefects: [],
    warnings: [],
  };
}

function analysis(over: Partial<ModuleAnalysis>): ModuleAnalysis {
  return {
    moduleId: 'cpk',
    title: 'CPK 汇总',
    markdown: '### CPK 汇总\n- 外壳长度 Cpk=1.1，低于 1.33',
    ok: true,
    model: 'qwen3.5:9b',
    errorMessage: null,
    skipReason: null,
    sentFields: ['moduleTitle'],
    ...over,
  };
}

describe('cnOrdinal', () => {
  it('1..10 用中文，超出回退数字', () => {
    expect(cnOrdinal(0)).toBe('一');
    expect(cnOrdinal(5)).toBe('六');
    expect(cnOrdinal(9)).toBe('十');
    expect(cnOrdinal(10)).toBe('11');
  });
});

describe('buildAiReportMarkdown', () => {
  const analyses: ModuleAnalysis[] = [
    analysis({}),
    analysis({ moduleId: 'defect', title: '不良统计', ok: false, markdown: '', errorMessage: '请求失败：429' }),
    analysis({ moduleId: 'pareto', title: '柏拉图（80% 分界线）', ok: false, markdown: '', skipReason: '本次未导入不良记录，无法生成柏拉图。' }),
  ];

  it('按模块顺序逐节输出，成功模块带正文', () => {
    const md = buildAiReportMarkdown(makeModel(), analyses, {
      model: 'qwen3.5:9b',
      focusIds: ['stability', 'capability'],
      generatedAt: '2026-09-19T09:00:00.000Z',
    });
    expect(md).toContain('# AI 分析报表 —— 外壳长度项目');
    expect(md.indexOf('## 一、CPK 汇总')).toBeGreaterThan(-1);
    expect(md.indexOf('## 二、不良统计')).toBeGreaterThan(md.indexOf('## 一、CPK 汇总'));
    expect(md.indexOf('## 三、柏拉图（80% 分界线）')).toBeGreaterThan(md.indexOf('## 二、不良统计'));
    expect(md).toContain('外壳长度 Cpk=1.1');
  });

  it('★ 没拿到正文的模块不会被省略，且在文末汇总原因', () => {
    const md = buildAiReportMarkdown(makeModel(), analyses, { model: 'm', focusIds: ['capability'] });
    expect(md).toContain('未生成 AI 分析：请求失败：429');
    expect(md).toContain('未生成 AI 分析：本次未导入不良记录，无法生成柏拉图。');
    expect(md).toContain('## 附：未生成分析的模块与原因');
    expect(md).toContain('- 不良统计：请求失败：429');
  });

  it('★ 数据口径声明：只发送统计摘要（数据主权可见化）', () => {
    const md = buildAiReportMarkdown(makeModel(), analyses, { model: 'm', focusIds: ['capability'] });
    expect(md).toContain('仅发送统计摘要');
    expect(md).toContain('过程能力达标');
    expect(md).toContain('本报表共 3 个模块，其中 1 个已生成');
  });

  it('未成功调用时模型名不空着，写明「未成功调用」', () => {
    const md = buildAiReportMarkdown(makeModel(), analyses, { model: '', focusIds: ['capability'] });
    expect(md).toContain('使用模型：（未成功调用）');
  });
});

describe('toAiSheetRows', () => {
  it('状态文案区分已生成 / 失败 / 未生成，失败模块的正文留空', () => {
    const rows = toAiSheetRows([
      analysis({}),
      analysis({ moduleId: 'defect', title: '不良统计', ok: false, errorMessage: '429', markdown: '' }),
      analysis({ moduleId: 'pareto', title: '柏拉图', ok: false, skipReason: '无不良记录', markdown: '' }),
    ]);
    expect(rows[0]).toEqual({
      module: 'CPK 汇总',
      status: '已生成',
      model: 'qwen3.5:9b',
      analysis: '### CPK 汇总\n- 外壳长度 Cpk=1.1，低于 1.33',
    });
    expect(rows[1].status).toBe('失败（429）');
    expect(rows[1].analysis).toBe('');
    expect(rows[2].status).toBe('未生成（无不良记录）');
  });
});

describe('文件名与签名', () => {
  it('文件名带日期与 _AI分析 后缀', () => {
    expect(aiReportFileName(makeModel())).toBe('外壳长度项目_2026-09-19_AI分析.md');
  });

  it('签名随数据量与方向变化；同输入同输出', () => {
    const a = analysisSignature(makeModel(), ['capability']);
    expect(a).toBe(analysisSignature(makeModel(), ['capability']));
    expect(a).not.toBe(analysisSignature(makeModel(), ['stability']));
    const bigger = { ...makeModel(), defectStats: [{ defectType: '毛刺', count: 1, ratio: 100, cumRatio: 100 }] };
    expect(analysisSignature(bigger, ['capability'])).not.toBe(a);
  });
});
