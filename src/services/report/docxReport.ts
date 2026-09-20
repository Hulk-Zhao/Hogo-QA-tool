/**
 * docxReport —— 「AI 分析报表」的 Word(.docx) 产物（P5-D 新增）。
 *
 * 为什么自己拼 OOXML：用户反馈「AI 分析导出 excel 排版太乱，可以整理为 word 文档」。
 * Excel 单元格本来就不适合承载 Markdown 长文（实测 SheetJS 社区版也没有单元格级
 * wrapText），而引入 `docx` 之类的库会明显抬高前端产物体积。本工具已有 `zipStore`
 * （STORE 打包 + 自算 CRC32），写一个最小 OOXML 包就够 Word / WPS 正常打开。
 *
 * 与 Markdown 出口**同源**（同一份 `ModuleAnalysis[]` + `AiReportMeta`），只是把
 * Markdown 结构翻译成真正的 Word 样式（标题层级 / 项目符号 / 表格），不引入第二套口径。
 *
 * 诚实口径：没拿到正文的模块不会消失，会在开头总览表与文末「未生成分析的模块与原因」
 * 里逐条写明原因。
 */

import type { ModuleAnalysis } from '@/services/ai/reportAnalysis';
import { focusLabels } from '@/services/ai/analysisFocus';
import type { ReportModel } from '@/data/exporter/reportModel';
import { writeZip, type ZipEntry } from '@/data/exporter/zipStore';
import { cnOrdinal, toAiSheetRows, type AiReportMeta } from './aiReportDoc';
import type { ChartImage } from '@/data/exporter/excelImages';

/** Word（.docx）MIME。 */
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** XML 文本转义（`&` 必须第一个替换，否则会二次转义）。 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 一段带格式的 run。 */
export interface DocRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/**
 * 把一行 Markdown 拆成带格式的 run（支持 `**加粗**` 与 `` `等宽` ``）。
 *
 * @param text 行内文本
 * @returns run 列表（至少一个）
 */
export function parseInlineRuns(text: string): DocRun[] {
  const runs: DocRun[] = [];
  const pattern = /\*\*(.+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null = pattern.exec(text);
  while (m !== null) {
    if (m.index > last) {
      runs.push({ text: text.slice(last, m.index) });
    }
    if (m[1] !== undefined) {
      runs.push({ text: m[1], bold: true });
    } else if (m[2] !== undefined) {
      runs.push({ text: m[2], code: true });
    }
    last = m.index + m[0].length;
    m = pattern.exec(text);
  }
  if (last < text.length) {
    runs.push({ text: text.slice(last) });
  }
  return runs.length > 0 ? runs : [{ text }];
}

/** run 列表 → OOXML。 */
function runsXml(runs: readonly DocRun[]): string {
  return runs
    .map((r) => {
      const props: string[] = [];
      if (r.bold) {
        props.push('<w:b/>');
      }
      if (r.italic) {
        props.push('<w:i/>');
      }
      if (r.code) {
        props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      }
      const pr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
      return `<w:r>${pr}<w:t xml:space="preserve">${escapeXml(r.text)}</w:t></w:r>`;
    })
    .join('');
}

/** 段落。 */
function paragraph(text: string, styleId?: string, extraPr = ''): string {
  const pr =
    styleId !== undefined || extraPr.length > 0
      ? `<w:pPr>${styleId !== undefined ? `<w:pStyle w:val="${styleId}"/>` : ''}${extraPr}</w:pPr>`
      : '';
  return `<w:p>${pr}${runsXml(parseInlineRuns(text))}</w:p>`;
}

/** 一个正文块。 */
export type DocBlock =
  | { kind: 'heading'; level: 2 | 3; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'ordered'; order: string; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][] };

/** 是否 Markdown 表格分隔行（|---|---|）。 */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

/** `| a | b |` → ['a','b']。 */
function splitTableRow(line: string): string[] {
  return line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * 把模块分析正文（Markdown）解析为块级结构。
 *
 * @param markdown 分析正文
 * @returns 块列表
 */
export function parseMarkdownBlocks(markdown: string): DocBlock[] {
  const blocks: DocBlock[] = [];
  const lines = (markdown ?? '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    i += 1;
    if (line.length === 0 || /^[-*_]{3,}$/.test(line)) {
      continue;
    }
    const heading = /^(#{1,6})\s*(.+)$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length <= 2 ? 2 : 3, text: heading[2].trim() });
      continue;
    }
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      let cursor = i - 1;
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        const tableLine = lines[cursor].trim();
        if (!isTableSeparator(tableLine)) {
          rows.push(splitTableRow(tableLine));
        }
        cursor += 1;
      }
      i = cursor;
      if (rows.length > 0) {
        blocks.push({ kind: 'table', rows });
      }
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/.exec(line);
    if (bullet) {
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }
    const ordered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      blocks.push({ kind: 'ordered', order: ordered[1], text: ordered[2].trim() });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push({ kind: 'quote', text: quote[1].trim() });
      continue;
    }
    blocks.push({ kind: 'para', text: line });
  }
  return blocks;
}

/** 表格 → OOXML（首行加粗，浅灰网格线）。 */
function tableXml(rows: readonly string[][]): string {
  const borders =
    '<w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
      .join('')
    + '</w:tblBorders>';
  const trs = rows
    .map((cells, rowIndex) => {
      const tcs = cells
        .map((cell) => {
          const runs = parseInlineRuns(cell).map((r) =>
            rowIndex === 0 ? { ...r, bold: true } : r,
          );
          return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runsXml(runs)}</w:p></w:tc>`;
        })
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${trs}</w:tbl>`;
}

/** Word 正文可用宽度（A4 21cm - 左右各 2.25cm 页边距 ≈ 16.5cm）。 */
export const DOCX_CONTENT_WIDTH_EMU = 5_940_000;

/** 单张图片的最大高度（20cm）：控制图这类竖长图按高度收敛，避免溢出到第三页。 */
export const DOCX_MAX_IMAGE_HEIGHT_EMU = 7_200_000;

/**
 * 按最大宽高**等比**收敛图片尺寸（EMU）。
 *
 * 为什么不能直接用「像素 × 9525」：打印快照的像素宽可达 2364px，
 * 按 96dpi 折算就是 22.5cm，比 A4 可打印宽度还宽，Word 会把它缩到页边距内
 * 但比例不再可控。这里统一按「装进 16.5cm × 20cm」等比缩放，输出可预期。
 *
 * @param widthPx PNG 像素宽
 * @param heightPx PNG 像素高
 * @returns { cx, cy }（EMU，均 >= 1）
 */
export function fitImageSizeEmu(
  widthPx: number,
  heightPx: number,
): { cx: number; cy: number } {
  if (!Number.isFinite(widthPx) || !Number.isFinite(heightPx) || widthPx <= 0 || heightPx <= 0) {
    return { cx: DOCX_CONTENT_WIDTH_EMU, cy: DOCX_CONTENT_WIDTH_EMU };
  }
  const byWidth = DOCX_CONTENT_WIDTH_EMU / widthPx;
  const byHeight = DOCX_MAX_IMAGE_HEIGHT_EMU / heightPx;
  const scale = Math.min(byWidth, byHeight);
  return {
    cx: Math.max(1, Math.round(widthPx * scale)),
    cy: Math.max(1, Math.round(heightPx * scale)),
  };
}

/**
 * 一张内嵌图片的段落（居中 + 图题）。
 *
 * @param relId 关系 id（`r:embed`）
 * @param docPrId drawing 的稳定编号（从 1 起）
 * @param image 图片（名称 + 像素尺寸）
 * @param imageIndex 图片序号（用于 pic:cNvPr 名称）
 * @returns 段落 XML
 */
function imageParagraphXml(
  relId: string,
  docPrId: number,
  image: { name: string; widthPx: number; heightPx: number },
  imageIndex: number,
): string {
  const { cx, cy } = fitImageSizeEmu(image.widthPx, image.heightPx);
  const caption = image.name.trim().length > 0 ? image.name.trim() : `图表 ${imageIndex}`;
  const drawing =
    '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0" '
    + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing">'
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${docPrId}" name="图表 ${docPrId}" descr="${escapeXml(caption)}"/>`
    + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
    + '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + '<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    + `<pic:nvPicPr><pic:cNvPr id="${imageIndex}" name="${escapeXml(`image${imageIndex}.png`)}"/>`
    + '<pic:cNvPicPr/></pic:nvPicPr>'
    + `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + '<pic:spPr><a:xfrm><a:off x="0" y="0"/>'
    + `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  return `<w:p><w:pPr><w:jc w:val="center"/></w:pPr>${drawing}</w:p>${paragraph(caption, 'Quote')}`;
}
/** 块列表 → OOXML。 */
function blocksXml(blocks: readonly DocBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'heading':
          return paragraph(b.text, b.level === 2 ? 'Heading2' : 'Heading3');
        case 'bullet':
          return paragraph(`• ${b.text}`, 'ListParagraph');
        case 'ordered':
          return paragraph(`${b.order}. ${b.text}`, 'ListParagraph');
        case 'quote':
          return paragraph(b.text, 'Quote');
        case 'table':
          return tableXml(b.rows);
        default:
          return paragraph(b.text);
      }
    })
    .join('');
}

/** 生成时间文案（与 Markdown 出口保持一致的口径）。 */
function generatedText(meta: AiReportMeta): string {
  const generated = new Date(meta.generatedAt ?? Date.now());
  return Number.isNaN(generated.getTime())
    ? String(meta.generatedAt ?? '')
    : generated.toLocaleString('zh-CN');
}

/**
 * 正文（`word/document.xml` 的 body 内容）。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析
 * @param meta 元信息
 * @returns body XML
 */
export function documentBodyXml(
  model: ReportModel,
  analyses: readonly ModuleAnalysis[],
  meta: AiReportMeta,
  charts: readonly ChartImage[] = [],
): string {
  const out: string[] = [];
  const labels = focusLabels(meta.focusIds);
  const rows = toAiSheetRows(analyses);
  const done = analyses.filter((a) => a.ok).length;

  out.push(paragraph(`${model.projectName || '质量报表'} —— AI 分析报表`, 'Title'));
  out.push(paragraph(`生成时间：${generatedText(meta)}`));
  out.push(paragraph(`使用模型：${meta.model.trim().length > 0 ? meta.model : '（未成功调用）'}`));
  out.push(paragraph(`分析方向：${labels.length > 0 ? labels.join('、') : '未选择'}`));
  out.push(paragraph('数据口径：仅发送统计摘要，未发送逐条原始测量值。'));
  out.push(
    paragraph(
      `本报表共 ${analyses.length} 个模块，其中 ${done} 个已生成 AI 分析、`
      + `${analyses.length - done} 个未生成（原因见文末）。`,
    ),
  );

  out.push(paragraph('模块总览', 'Heading1'));
  out.push(tableXml([['报表模块', '状态', '模型'], ...rows.map((r) => [r.module, r.status, r.model])]));

  analyses.forEach((a, index) => {
    out.push(paragraph(`${cnOrdinal(index)}、${a.title}`, 'Heading1'));
    if (a.ok) {
      out.push(blocksXml(parseMarkdownBlocks(a.markdown)));
    } else {
      out.push(paragraph(`未生成 AI 分析：${a.errorMessage ?? a.skipReason ?? '未知原因'}`, 'Quote'));
    }
  });

  const notDone = analyses.filter((a) => !a.ok);
  if (notDone.length > 0) {
    out.push(paragraph('附：未生成分析的模块与原因', 'Heading1'));
    for (const a of notDone) {
      out.push(paragraph(`• ${a.title}：${a.errorMessage ?? a.skipReason ?? '未知原因'}`, 'ListParagraph'));
    }
  }

  if (charts.length > 0) {
    // 图表放在分析之后、免责声明之前：先结论后证据，和报表页的阅读顺序一致。
    out.push(paragraph('图表', 'Heading1'));
    charts.forEach((img, i) => {
      out.push(imageParagraphXml(`rIdImg${i + 1}`, i + 1, img, i + 1));
    });
  }

  out.push(paragraph('———'));
  out.push(
    paragraph(
      'AI 分析由 Hogo-QA-tool 调用用户自行配置的 LLM 生成，仅为统计量的解读建议，'
      + '不替代质量判定与工程评审；请对照各模块的统计表复核。',
      'Quote',
    ),
  );
  out.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>',
  );
  return out.join('');
}

/** 样式表（字体 / 标题层级 / 列表缩进）。 */
const STYLES_XML =
  '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
  + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="微软雅黑"/>'
  + '<w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault>'
  + '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:spacing w:before="240" w:after="240"/><w:jc w:val="center"/></w:pPr>'
  + '<w:rPr><w:b/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="320" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr>'
  + '<w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr>'
  + '<w:rPr><w:b/><w:color w:val="2E5496"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:keepNext/><w:spacing w:before="200" w:after="100"/><w:outlineLvl w:val="2"/></w:pPr>'
  + '<w:rPr><w:b/><w:color w:val="333333"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:ind w:left="420" w:hanging="240"/><w:spacing w:after="60"/></w:pPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/>'
  + '<w:pPr><w:ind w:left="360"/></w:pPr>'
  + '<w:rPr><w:i/><w:color w:val="595959"/></w:rPr></w:style>'
  + '</w:styles>';

/** `[Content_Types].xml`。 */
const CONTENT_TYPES_XML =
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  // png 默认项**无条件**声明：漏了它整张图会被 Word 丢掉（P4 在 Excel 的
  // drawing content-type 上踩过同一个坑），而未使用它完全无害。
  + '<Default Extension="png" ContentType="image/png"/>'
  + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
  + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
  + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
  + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
  + '</Types>';

/** `_rels/.rels`。 */
const ROOT_RELS_XML =
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
  + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
  + '</Relationships>';

/**
 * `word/_rels/document.xml.rels`：样式关系 + 每张图表图片一条 image 关系。
 *
 * 关系 id 用 `rIdImg{i}` 独立前缀，避免与 `rId1`（styles）撞号 ——
 * 撞号时 Word 会直接判定文件损坏（P4 在 Excel 的 content-type 上踩过同类坑）。
 *
 * @param imageCount 图片张数
 * @returns rels XML
 */
function docRelsXml(imageCount: number): string {
  const imageRels = Array.from({ length: imageCount }, (_, i) =>
    `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`).join('');
  return (
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + imageRels
    + '</Relationships>'
  );
}

/** `docProps/app.xml`。 */
const APP_XML =
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
  + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
  + '<Application>Hogo-QA-tool</Application></Properties>';

/** `docProps/core.xml`。 */
function coreXml(model: ReportModel, meta: AiReportMeta): string {
  const stamp = new Date(meta.generatedAt ?? Date.now());
  const iso = Number.isNaN(stamp.getTime()) ? new Date().toISOString() : stamp.toISOString();
  return (
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" '
    + 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${escapeXml(`${model.projectName || '质量报表'} —— AI 分析报表`)}</dc:title>`
    + '<dc:creator>Hogo-QA-tool</dc:creator>'
    + '<cp:lastModifiedBy>Hogo-QA-tool</cp:lastModifiedBy>'
    + `<dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created>`
    + `<dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified>`
    + '</cp:coreProperties>'
  );
}

/** 编码为 UTF-8 字节。 */
function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 生成「AI 分析报表」.docx 二进制。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析
 * @param meta 元信息
 * @returns .docx 二进制
 */
/** Word 导出选项。 */
export interface DocxReportOptions {
  /** 图表 PNG（来自页面画布采集，见 `chartImageCollector`）；不传 = 只出文字。 */
  charts?: readonly ChartImage[];
}

/**
 * 生成「AI 分析报表」.docx 二进制。
 *
 * @param model 报表中间模型
 * @param analyses 逐模块分析
 * @param meta 元信息
 * @param options 选项（图表图片）
 * @returns .docx 二进制
 */
export function buildAiReportDocx(
  model: ReportModel,
  analyses: readonly ModuleAnalysis[],
  meta: AiReportMeta,
  options: DocxReportOptions = {},
): ArrayBuffer {
  const charts = options.charts ?? [];
  const documentXml =
    XML_HEADER
    // xmlns:r 必须声明在根上：图表用 `r:embed` 引用图片关系，前缀未声明时
    // Word 会直接判定文件损坏（这是 XML 硬性要求，不是可选优化）。
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>'
    + documentBodyXml(model, analyses, meta, charts)
    + '</w:body></w:document>';
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc(XML_HEADER + CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: enc(XML_HEADER + ROOT_RELS_XML) },
    { name: 'word/document.xml', data: enc(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: enc(XML_HEADER + docRelsXml(charts.length)) },
    ...charts.map((img, i) => ({ name: `word/media/image${i + 1}.png`, data: img.png })),
    { name: 'word/styles.xml', data: enc(XML_HEADER + STYLES_XML) },
    { name: 'docProps/core.xml', data: enc(XML_HEADER + coreXml(model, meta)) },
    { name: 'docProps/app.xml', data: enc(XML_HEADER + APP_XML) },
  ];
  return writeZip(entries);
}

/**
 * Word 报表文件名（含日期）。
 *
 * @param model 报表中间模型
 * @returns 文件名（.docx）
 */
export function aiReportDocxFileName(model: ReportModel): string {
  const d = model.generatedAt.slice(0, 10);
  return `${model.projectName || '质量报表'}_${d}_AI分析.docx`;
}