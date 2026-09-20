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
  DOCX_CONTENT_WIDTH_EMU,
  DOCX_MAX_IMAGE_HEIGHT_EMU,
  escapeXml,
  fitImageSizeEmu,
  parseInlineRuns,
  parseMarkdownBlocks,
} from '../docxReport';
import { readZipEntries } from '@/data/exporter/zipStore';
import type { ChartImage } from '@/data/exporter/excelImages';
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

/** 造一张最小 PNG（签名 + IHDR + IEND，CRC 置 0——解码器不校验 CRC）。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 33);
  return bytes;
}

/** 两张待内嵌图表（宽度与打印快照同量级：2364px）。 */
function makeCharts(): ChartImage[] {
  return [
    { name: '控制图（外壳长度）', png: pngBytes(2364, 900), widthPx: 2364, heightPx: 900 },
    { name: '能力图（直方图 + USL/LSL）', png: pngBytes(2364, 1200), widthPx: 2364, heightPx: 1200 },
  ];
}

describe('buildAiReportDocx —— 图表内嵌（P6-A）', () => {
  it('★ 传 charts：media 部件字节与入参一致，且 rels / Content_Types / document.xml 三处都接线', () => {
    const given = makeCharts();
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META, { charts: given });
    const entries = readZipEntries(buffer);
    const names = entries.map((e) => e.name);
    expect(names).toContain('word/media/image1.png');
    expect(names).toContain('word/media/image2.png');
    expect(names).not.toContain('word/media/image3.png');

    const mediaOf = (name: string): Uint8Array => {
      const entry = entries.find((e) => e.name === name);
      expect(entry, '产物里必须有 ' + name).toBeTruthy();
      return (entry as { data: Uint8Array }).data;
    };
    // 字节必须一字不差：Word 里看到的应当是页面快照本身，而不是被二次渲染
    expect(Array.from(mediaOf('word/media/image1.png'))).toEqual(Array.from(given[0].png));
    expect(Array.from(mediaOf('word/media/image2.png'))).toEqual(Array.from(given[1].png));

    const rels = readPart(buffer, 'word/_rels/document.xml.rels');
    expect(rels).toContain('Id="rIdImg1"');
    expect(rels).toContain('Target="media/image1.png"');
    expect(rels).toContain('Id="rIdImg2"');
    expect(rels).toContain('/officeDocument/2006/relationships/image');
    // 图片关系 id 不能与 styles 的 rId1 抢号（撞号 = Word 判文件损坏）
    expect(rels.match(/Id="rId1"/g)).toHaveLength(1);

    const xml = readPart(buffer, 'word/document.xml');
    // xmlns:r 必须声明在根上，否则 r:embed 无前缀定义 → 文件损坏
    expect(xml).toContain('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
    expect(xml).toContain('r:embed="rIdImg1"');
    expect(xml).toContain('r:embed="rIdImg2"');
    expect(xml).toContain('<w:drawing>');
    expect(xml).toContain('<wp:docPr id="1"');
    expect(xml).toContain('<wp:docPr id="2"');
    expect(xml).toContain('控制图（外壳长度）');
    expect(xml).toContain('能力图（直方图 + USL/LSL）');

    // 漏了 png 默认项，Word 会丢掉整张图
    expect(readPart(buffer, '[Content_Types].xml')).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
  });

  it('★ 图表排在分析之后、免责声明之前，且各带一个「图表」一级标题', () => {
    const xml = readPart(
      buildAiReportDocx(makeModel(), makeAnalyses(), META, { charts: makeCharts() }),
      'word/document.xml',
    );
    const titleAt = xml.indexOf('<w:t xml:space="preserve">图表</w:t>');
    expect(titleAt).toBeGreaterThan(-1);
    expect(titleAt).toBeGreaterThan(xml.indexOf('一、CPK 汇总'));
    expect(titleAt).toBeLessThan(xml.indexOf('AI 分析由 Hogo-QA-tool'));
    expect(xml.match(/<w:drawing>/g)).toHaveLength(2);
    expect(xml.match(/r:embed="rIdImg/g)).toHaveLength(2);
  });

  it('不传 charts：包内没有 media 部件、rels 没有 image 关系（旧行为逐字不变）', () => {
    const buffer = buildAiReportDocx(makeModel(), makeAnalyses(), META);
    const names = readZipEntries(buffer).map((e) => e.name);
    expect(names.some((n) => n.startsWith('word/media/'))).toBe(false);
    expect(readPart(buffer, 'word/_rels/document.xml.rels')).not.toContain('relationships/image');
    expect(readPart(buffer, 'word/document.xml')).not.toContain('<w:drawing>');
    expect(documentBodyXml(makeModel(), makeAnalyses(), META)).not.toContain('<w:drawing>');
  });

  it('documentBodyXml 第 4 参可直接内嵌图表（Word 之外的出口也能复用）', () => {
    const body = documentBodyXml(makeModel(), makeAnalyses(), META, makeCharts());
    expect(body).toContain('<w:drawing>');
    expect(body.indexOf('<w:drawing>')).toBeGreaterThan(body.indexOf('一、CPK 汇总'));
    expect(body.endsWith('</w:sectPr>')).toBe(true);
  });

  it('★ fitImageSizeEmu：等比收敛进 16.5cm × 20cm，绝不溢出页边距', () => {
    // 竖长图（2364×6000）：被 20cm 高度钳制，比例保持
    const tall = fitImageSizeEmu(2364, 6000);
    expect(tall.cy).toBe(DOCX_MAX_IMAGE_HEIGHT_EMU);
    expect(tall.cx).toBeLessThanOrEqual(DOCX_CONTENT_WIDTH_EMU);
    expect(tall.cx / tall.cy).toBeCloseTo(2364 / 6000, 5);

    // 宽扁图（4000×500）：被 16.5cm 宽度钳制，比例保持
    const wide = fitImageSizeEmu(4000, 500);
    expect(wide.cx).toBe(DOCX_CONTENT_WIDTH_EMU);
    expect(wide.cy).toBeLessThan(DOCX_MAX_IMAGE_HEIGHT_EMU);
    expect(wide.cy / wide.cx).toBeCloseTo(500 / 4000, 5);

    // 非法输入（0 / 负数 / NaN / Infinity）兜底成不超框的正数，绝不产出 cx=0 的坏图
    for (const [w, h] of [[0, 0], [-1, 10], [Number.NaN, 10], [Number.POSITIVE_INFINITY, 10], [10, 0]]) {
      const size = fitImageSizeEmu(w, h);
      expect(size.cx).toBeGreaterThan(0);
      expect(size.cy).toBeGreaterThan(0);
      expect(size.cx).toBeLessThanOrEqual(DOCX_CONTENT_WIDTH_EMU);
    }
  });

  it('图题为空时兜底成「图表 N」；图题里的 < & 必须转义', () => {
    const xml = readPart(
      buildAiReportDocx(makeModel(), makeAnalyses(), META, {
        charts: [
          { name: '   ', png: pngBytes(100, 100), widthPx: 100, heightPx: 100 },
          { name: 'A < B & C', png: pngBytes(100, 100), widthPx: 100, heightPx: 100 },
        ],
      }),
      'word/document.xml',
    );
    expect(xml).toContain('<wp:docPr id="1" name="图表 1" descr="图表 1"/>');
    expect(xml).toContain('A &lt; B &amp; C');
    expect(xml).not.toContain('A < B & C');
  });
});