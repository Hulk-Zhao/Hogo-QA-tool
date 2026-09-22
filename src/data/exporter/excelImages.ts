/**
 * excelImages —— 把图表 PNG 内嵌进导出的 xlsx（用户需求：导出 Excel 也要有图片）。
 *
 * 背景：`xlsx@0.18.5` 社区版的 `ws['!images']` 不生效（实测产物里
 * 连 `xl/media/` 都没有），所以走「OOXML 包手术」这条路：
 *  1. 把 xlsx 当 ZIP 拆成条目（见 zipStore，STORE 同步读写）；
 *  2. 新增一个「图表」sheet：`xl/worksheets/sheetN.xml` + 它的 `_rels`；
 *  3. 新增 `xl/drawings/drawing1.xml`（oneCellAnchor 定位）与它的 `_rels`；
 *  4. 每张图落一个 `xl/media/imageK.png`；
 *  5. 改 `xl/workbook.xml`（加 sheet）、`xl/_rels/workbook.xml.rels`（加关系）、
 *     `[Content_Types].xml`（加 Override）、`docProps/app.xml`（工作表清单）。
 * 全部是纯字符串拼接 + 字节搬运，无第三方依赖、无异步。
 *
 * 验收（tests + .probe）：产物能被 SheetJS 与 Python openpyxl 两个独立解析器
 * 读成 5 个 sheet，且「图表」sheet 里能取回与源 PNG **字节一致**的图片。
 */

import { readZipEntries, writeZip, type ZipEntry } from './zipStore';

/** 图表 sheet 名。 */
export const CHART_SHEET_NAME = '图表';

/** OOXML 里的图片定位单位：1 英寸 = 914400 EMU，96 DPI 下 1 px = 9525 EMU。 */
export const EMU_PER_PX = 9525;

/** Excel 默认行高约 20 px（15 pt）。 */
const ROW_HEIGHT_PX = 20;

/** 一张待内嵌的图表。 */
export interface ChartImage {
  /** 图题（写进「图表」sheet 的 A 列，也用于图片替换文字）。 */
  name: string;
  /** PNG 字节。 */
  png: Uint8Array;
  /** 像素宽。 */
  widthPx: number;
  /** 像素高。 */
  heightPx: number;
}

/**
 * px → EMU。
 *
 * @param px 像素
 * @returns EMU（取整）
 */
export function emuFromPx(px: number): number {
  return Math.round(px * EMU_PER_PX);
}

/**
 * 解析 `data:image/png;base64,...`。
 *
 * 只认 PNG，且从 IHDR 直接读宽高 —— 不依赖 `Image`/DOM，纯函数可单测。
 *
 * @param dataUrl 数据 URL
 * @returns 图片；非 PNG 或格式损坏时返回 null
 */
export function decodePngDataUrl(dataUrl: string): ChartImage | null {
  const marker = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(marker)) {
    return null;
  }
  let png: Uint8Array;
  try {
    const binary = atob(dataUrl.slice(marker.length));
    png = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      png[i] = binary.charCodeAt(i);
    }
  } catch {
    return null;
  }
  if (png.length < 24) {
    return null;
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => png[i] === b)) {
    return null;
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const widthPx = view.getUint32(16, false);
  const heightPx = view.getUint32(20, false);
  if (widthPx <= 0 || heightPx <= 0) {
    return null;
  }
  return { name: '', png, widthPx, heightPx };
}

/** XML 文本转义。 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/**
 * 构造「图表」sheet 的 worksheet XML。
 *
 * @param images 图表列表
 * @returns sheetN.xml 内容
 */
export function buildChartSheetXml(images: ChartImage[]): string {
  const rows: string[] = [];
  let rowIndex = 1;
  for (const img of images) {
    rows.push(`<row r="${rowIndex}"><c r="A${rowIndex}" t="str"><v>${esc(img.name)}</v></c></row>`);
    rowIndex += Math.ceil(img.heightPx / ROW_HEIGHT_PX) + 2;
  }
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews>' +
    `<sheetData>${rows.join('')}</sheetData>` +
    '<drawing r:id="rId1"/>' +
    '</worksheet>'
  );
}

/**
 * 构造 drawing1.xml（每张图一个 oneCellAnchor，尺寸按像素精确给定）。
 *
 * @param images 图表列表
 * @returns drawing XML
 */
export function buildDrawingXml(images: ChartImage[]): string {
  const anchors = images.map((img, i) => {
    const cx = emuFromPx(img.widthPx);
    const cy = emuFromPx(img.heightPx);
    const row = 1 + images
      .slice(0, i)
      .reduce((sum, prev) => sum + Math.ceil(prev.heightPx / ROW_HEIGHT_PX) + 2, 0);
    return (
      '<xdr:oneCellAnchor>' +
      `<xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:ext cx="${cx}" cy="${cy}"/>` +
      '<xdr:pic>' +
      '<xdr:nvPicPr>' +
      `<xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}" descr="${esc(img.name)}"/>` +
      '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>' +
      '</xdr:nvPicPr>' +
      `<xdr:blipFill><a:blip r:embed="rId${i + 1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
      '<xdr:spPr><a:xfrm>' +
      `<a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/>` +
      '</a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>' +
      '</xdr:pic>' +
      '<xdr:clientData/>' +
      '</xdr:oneCellAnchor>'
    );
  });
  return (
    XML_HEAD +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
    ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    anchors.join('') +
    '</xdr:wsDr>'
  );
}

const RELS_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const RELS_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 构造 drawing 的关系文件（rIdK → ../media/imageK.png）。 */
export function buildDrawingRels(images: ChartImage[]): string {
  const rels = images
    .map(
      (_img, i) =>
        `<Relationship Id="rId${i + 1}" Type="${RELS_NS}/image" Target="../media/image${i + 1}.png"/>`,
    )
    .join('');
  return (
    RELS_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels +
    '</Relationships>'
  );
}

/** 下一个可用的 xl 部件序号（sheet / drawing）。 */
function nextIndex(names: Iterable<string>, pattern: RegExp): number {
  let max = 0;
  for (const name of names) {
    const m = pattern.exec(name);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max + 1;
}

/** 读取条目文本。 */
function textOf(entries: Map<string, ZipEntry>, name: string): string {
  const entry = entries.get(name);
  if (!entry) {
    throw new Error(`xlsx 缺少必需部件：${name}`);
  }
  return new TextDecoder('utf-8').decode(entry.data);
}

/** 以 UTF-8 覆盖/新增一个文本条目。 */
function putText(entries: Map<string, ZipEntry>, name: string, text: string): void {
  entries.set(name, { name, data: new TextEncoder().encode(text) });
}

/**
 * 在 `<worksheet>` 末尾插入 `<drawing r:id="rId1"/>`。
 *
 * CT_Worksheet 的元素顺序里 `drawing` 位于 `ignoredErrors` 之后、`extLst` 之前，
 * 因此必须插在 `<extLst>` 之前（有的话），否则 Excel 会判定顺序非法。
 *
 * @param xml 原 sheet XML
 * @param relId 关系 id
 * @returns 新 XML
 */
export function attachDrawingToSheet(xml: string, relId: string): string {
  const tag = `<drawing r:id="${relId}"/>`;
  const extIndex = xml.indexOf('<extLst');
  if (extIndex >= 0) {
    return `${xml.slice(0, extIndex)}${tag}${xml.slice(extIndex)}`;
  }
  const closeIndex = xml.lastIndexOf('</worksheet>');
  if (closeIndex < 0) {
    throw new Error('sheet XML 结构异常：缺少 </worksheet>。');
  }
  return `${xml.slice(0, closeIndex)}${tag}${xml.slice(closeIndex)}`;
}

/**
 * 把图表图片内嵌进 xlsx，返回新的二进制。
 *
 * @param xlsx 原始 xlsx（必须由 `compression: false` 写出）
 * @param images 图表列表；为空时原样返回
 * @returns 内嵌图片后的 xlsx
 */
export function embedChartImages(
  xlsx: ArrayBuffer | Uint8Array,
  images: ChartImage[],
): ArrayBuffer {
  const original = xlsx instanceof Uint8Array ? xlsx : new Uint8Array(xlsx);
  if (images.length === 0) {
    if (xlsx instanceof Uint8Array) {
      return xlsx.buffer.slice(xlsx.byteOffset, xlsx.byteOffset + xlsx.byteLength) as ArrayBuffer;
    }
    return xlsx;
  }

  const entries = new Map<string, ZipEntry>();
  for (const e of readZipEntries(original)) {
    entries.set(e.name, e);
  }

  const names = [...entries.keys()];
  const sheetIndex = nextIndex(names, /^xl\/worksheets\/sheet(\d+)\.xml$/);
  const drawingIndex = nextIndex(names, /^xl\/drawings\/drawing(\d+)\.xml$/);
  const sheetPath = `xl/worksheets/sheet${sheetIndex}.xml`;
  const drawingPath = `xl/drawings/drawing${drawingIndex}.xml`;

  // 1) workbook.xml：追加一个 sheet（sheetId 取最大值 +1）
  const workbook = textOf(entries, 'xl/workbook.xml');
  const sheetIds = [...workbook.matchAll(/<sheet [^>]*sheetId="(\d+)"/g)].map((m) => Number(m[1]));
  const sheetId = (sheetIds.length ? Math.max(...sheetIds) : 0) + 1;

  const rels = textOf(entries, 'xl/_rels/workbook.xml.rels');
  const relIds = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
  const sheetRelId = `rId${(relIds.length ? Math.max(...relIds) : 0) + 1}`;

  const sheetTag = `<sheet name="${esc(CHART_SHEET_NAME)}" sheetId="${sheetId}" r:id="${sheetRelId}"/>`;
  if (!workbook.includes('</sheets>')) {
    throw new Error('xl/workbook.xml 结构异常：缺少 </sheets>。');
  }
  putText(entries, 'xl/workbook.xml', workbook.replace('</sheets>', `${sheetTag}</sheets>`));

  // 2) workbook 关系：指向新 sheet
  if (!rels.includes('</Relationships>')) {
    throw new Error('xl/_rels/workbook.xml.rels 结构异常。');
  }
  putText(
    entries,
    'xl/_rels/workbook.xml.rels',
    rels.replace(
      '</Relationships>',
      `<Relationship Id="${sheetRelId}" Type="${RELS_NS}/worksheet" Target="worksheets/sheet${sheetIndex}.xml"/></Relationships>`,
    ),
  );

  // 3) [Content_Types].xml：登记新 sheet + **drawing 部件**（png 的 Default 已由 SheetJS 给出）
  //
  //    ⚠️ drawing 的 Override 是这一整块的关键，也是「用户看不到图片」的真凶：
  //    SheetJS 写出的 [Content_Types].xml 只有
  //      <Default Extension="xml" ContentType="application/xml"/>
  //    而没有 drawing 的 Override。按 OOXML 的内容类型解析规则，
  //    `xl/drawings/drawing1.xml` 于是落到 Default 上、被声明成 `application/xml`，
  //    这是**违规**的（规范要求 application/vnd.openxmlformats-officedocument.drawing+xml）。
  //    Excel / WPS 会因此判定「文件内容有问题」并把整张 drawing 丢掉 ——
  //    用户看到的现象正是「导出的 Excel 没有图片」；
  //    而 openpyxl 是按 workbook/sheet 关系去找 drawing 的、根本不读 content type，
  //    所以组件测试与 openpyxl 全绿，却和用户的真实观感相反。
  //    实证：修复前 `.probe/downloads/report.xlsx` 的 [Content_Types].xml 里
  //    搜不到 drawing（基线由 `.probe/` 下的探针现场生成，产物不入库）。
  const contentTypes = textOf(entries, '[Content_Types].xml');
  let patchedTypes = contentTypes;
  if (!/Extension="png"/.test(patchedTypes)) {
    // 正常由 SheetJS 给出；这里只是兜底，避免换库后 png 未登记。
    patchedTypes = patchedTypes.replace(
      '</Types>',
      '<Default Extension="png" ContentType="image/png"/></Types>',
    );
  }
  if (!patchedTypes.includes('</Types>')) {
    throw new Error('[Content_Types].xml 结构异常：缺少 </Types>。');
  }
  const overrides =
    `<Override PartName="/${sheetPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`;
  putText(entries, '[Content_Types].xml', patchedTypes.replace('</Types>', overrides + '</Types>'));

  // 4) 新 sheet 本体 + 它的关系
  putText(entries, sheetPath, buildChartSheetXml(images));
  putText(
    entries,
    `xl/worksheets/_rels/sheet${sheetIndex}.xml.rels`,
    RELS_HEAD +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      `<Relationship Id="rId1" Type="${RELS_NS}/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>` +
      '</Relationships>',
  );

  // 5) drawing + 关系 + 图片字节
  putText(entries, drawingPath, buildDrawingXml(images));
  putText(entries, `xl/drawings/_rels/drawing${drawingIndex}.xml.rels`, buildDrawingRels(images));
  images.forEach((img, i) => {
    entries.set(`xl/media/image${i + 1}.png`, { name: `xl/media/image${i + 1}.png`, data: img.png });
  });

  // 6) docProps/app.xml：工作表清单（Excel 靠它填「标题/部件」，数不齐会显示旧清单）
  const appPath = 'docProps/app.xml';
  if (entries.has(appPath)) {
    const app = textOf(entries, appPath);
    const withTitles = app.replace(
      /<TitlesOfParts><vt:vector size="(\d+)" baseType="lpstr">/,
      (_m, size: string) =>
        `<TitlesOfParts><vt:vector size="${Number(size) + 1}" baseType="lpstr">`,
    ).replace(
      '</vt:vector></TitlesOfParts>',
      `<vt:lpstr>${esc(CHART_SHEET_NAME)}</vt:lpstr></vt:vector></TitlesOfParts>`,
    );
    const withHeading = withTitles.replace(
      /<vt:variant><vt:lpstr>Worksheets<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>(\d+)<\/vt:i4><\/vt:variant>/,
      (_m, count: string) =>
        `<vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${Number(count) + 1}</vt:i4></vt:variant>`,
    );
    putText(entries, appPath, withHeading);
  }

  // 注意：必须用「最新的全部条目」重打包 —— 上面新加的部件（sheet/drawing/media）
  // 不在最初的 names 快照里，用快照会静默丢掉它们（这正是本文件第一版的实际 bug）。
  return writeZip([...entries.values()]);
}
