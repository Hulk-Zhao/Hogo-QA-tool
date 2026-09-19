/**
 * docxReport 测试（P5-D：Word 导出）。
 *
 * 证伪立场：
 *  - 若不写 word/document.xml（或漏了 [Content_Types].xml）→ 「包结构」变红；
 *  - 若把 Markdown 原样塞进一个段落 → 「标题层级 / 项目符号 / 表格」变红；
 *  - 若不做 XML 转义 → 「& < > 必须转义」变红（Word 会直接报文件损坏）；
 *  - 若把未生成的模块悄悄省略 → 「未生成原因必须出现在文档里」变红。
 */

import { describe, expect, it } from 'vitest';
import {
  buildAiReportDocx,
  aiReportDocxFileName,
  documentBodyXml,
  escapeXml,
  parseInlineRuns,
  parseMarkdownBlocks,
} from '../docxReport';
import { readZipEntries } from '@/data/exporter/zipStore';
import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';
import type { ReportModel } from '@/data/exporter/reportModel';
import type { AiReportMeta } from '../aiReportDoc';

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

function makeAnalyses(): ModuleAnalysis[] {
  return [
    {
      moduleId: 'cpk',
      title: 'CPK 汇总',
      markdown: [
        '## 总体结论',
        '',
        '### 能力结论',
        '',
        '- 外壳长度 Cpk=3.65 > 1.33（**达标**）',
        '| 特性 | Cpk |',
        '| --- | --- |',
        '| 外壳长度 | 3.65 |',
        '',
        '> 口径：Cpk ≥ 1.33 为合格。',
      ].join('\n'),
      ok: true,
      model: 'deepseek-chat',
      errorMessage: null,
      skipReason: null,
      sentFields: ['moduleTitle'],
    },
    {
      moduleId: 'defect',
      title: '不良统计',
      markdown: '',
      ok: false,
      model: '',
      errorMessage: null,
      skipReason: '本次未导入不良记录，无法进行不良统计。',
      sentFields: [],
    },
  ];
}

const META: AiReportMeta = {
  model: 'deepseek-chat',
  focusIds: ['capability', 'riskWarning'],
  generatedAt: '2026-09-19T09:30:00.000Z',
};

function readPart(buffer: ArrayBuffer, name: string): string {
  const entry = readZipEntries(buffer).find((e) => e.name === name);
  expect(entry, `产物里必须有 ${name}`).toBeTruthy();
  return new TextDecoder().decode((entry as { data: Uint8Array }).data);
}

describe('escapeXml / parseInlineRuns', () => {
  it('& 先于其它字符转义（避免二次转义）', () => {
    expect(escapeXml('a & <b> "c" \'d\'')).toBe('a &amp; &lt;b&gt; &quot;c&quot; &apos;d&apos;');
    expect(escapeXml('&amp;')).toBe('&amp;amp;');
  });

  it('行内格式：**加粗** 与 `等宽`；普通文本原样', () => {
    expect(parseInlineRuns('**达标**且 `Cpk` 稳定')).toEqual([
      { text: '达标', bold: true },
      { text: '且 ' },
      { text: 'Cpk', code: true },
      { text: ' 稳定' },
    ]);
    expect(parseInlineRuns('无格式')).toEqual([{ text: '无格式' }]);
  });
});

describe('parseMarkdownBlocks', () => {
  it('标题 / 列表 / 引用 / 表格各自成块，分隔线被丢弃', () => {
    const blocks = parseMarkdownBlocks(
      ['## 小结', '1. 先收紧公差', '- 再看 Cpk', '> 口径说明', '|---|---|', '| a | b |', '正文段落'].join('\n'),
    );
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: '小结' },
      { kind: 'ordered', order: '1', text: '先收紧公差' },
      { kind: 'bullet', text: '再看 Cpk' },
      { kind: 'quote', text: '口径说明' },
      { kind: 'table', rows: [['a', 'b']] },
      { kind: 'para', text: '正文段落' },
    ]);
  });

  it('### 及更深标题降为三级（Heading3），## 以内是二级', () => {
    const blocks = parseMarkdownBlocks('## 二级\n### 三级\n#### 四级');
    expect(blocks).toEqual([
      { kind: 'heading', level: 2, text: '二级' },
      { kind: 'heading', level: 3, text: '三级' },
      { kind: 'heading', level: 3, text: '四级' },
    ]);
  });
});

describe('buildAiReportDocx', () => {
  it('★ 包结构完整：7 个部件齐全，且都登记在 [Content_Types].xml 里', () => {
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META);
    const names = readZipEntries(buffer).map((e) => e.name);
    expect(names).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
      'word/_rels/document.xml.rels',
      'word/styles.xml',
      'docProps/core.xml',
      'docProps/app.xml',
    ]);
    const types = readPart(buffer, '[Content_Types].xml');
    for (const part of ['/word/document.xml', '/word/styles.xml', '/docProps/core.xml']) {
      expect(types).toContain(`PartName="${part}"`);
    }
  });

  it('★ 排版：标题层级 / 项目符号 / 真表格 / 引用样式都进 document.xml（不是一坨纯文本）', () => {
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META);
    const xml = readPart(buffer, 'word/document.xml');

    expect(xml).toContain('<w:pStyle w:val="Title"/>');
    expect(xml).toContain('外壳长度项目 —— AI 分析报表');
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading2"/>');
    expect(xml).toContain('<w:pStyle w:val="Heading3"/>');
    expect(xml).toContain('<w:pStyle w:val="ListParagraph"/>');
    expect(xml).toContain('<w:pStyle w:val="Quote"/>');
    expect(xml).toContain('<w:tbl>');
    // Markdown 标记不能原样残留
    expect(xml).not.toContain('###');
    expect(xml).not.toContain('|---');
    expect(xml).not.toContain('**');
  });

  it('★ 未生成的模块不消失：总览表 + 文末原因都写明', () => {
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META);
    const xml = readPart(buffer, 'word/document.xml');
    expect(xml).toContain('一、CPK 汇总');
    expect(xml).toContain('二、不良统计');
    expect(xml).toContain('未生成 AI 分析：本次未导入不良记录');
    expect(xml).toContain('附：未生成分析的模块与原因');
    expect(xml).toContain('共 2 个模块，其中 1 个已生成');
  });

  it('★ 用户文本里的 & < > 必须转义（否则 Word 会报文件损坏）', () => {
    const analyses: ModuleAnalysis[] = [
      {
        moduleId: 'cpk',
        title: 'A & B <特性>',
        markdown: '- 尺寸 < 下限 & 超差 > 0',
        ok: true,
        model: 'm',
        errorMessage: null,
        skipReason: null,
        sentFields: [],
      },
    ];
    const xml = readPart(buildAiReportDocx(makeModel(), analyses, META), 'word/document.xml');
    expect(xml).toContain('A &amp; B &lt;特性&gt;');
    expect(xml).toContain('尺寸 &lt; 下限 &amp; 超差 &gt; 0');
    expect(xml).not.toContain('<特性>');
  });

  it('core.xml 带标题，文件名带项目名与日期', () => {
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META);
    expect(readPart(buffer, 'docProps/core.xml')).toContain('外壳长度项目 —— AI 分析报表');
    expect(aiReportDocxFileName(makeModel())).toBe('外壳长度项目_2026-09-19_AI分析.docx');
  });

  it('documentBodyXml 可独立取用（供后续内嵌图表等扩展）', () => {
    const body = documentBodyXml(makeModel(), makeAnalyses(), META);
    expect(body).toContain('<w:sectPr>');
    expect(body.endsWith('</w:sectPr>')).toBe(true);
  });
});