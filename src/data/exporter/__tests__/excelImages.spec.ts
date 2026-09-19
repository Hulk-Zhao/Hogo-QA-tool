/**
 * excelImages / zipStore 测试（P3-D：导出 Excel 内嵌图表图片）。
 *
 * 用户需求：「给导出 excel也添加图片」。
 * 背景：`xlsx@0.18.5` 社区版的 `ws['!images']` 不生效（实测产物里没有
 * `xl/media/`），所以图片由我们自己做 OOXML 包手术写进去。
 *
 * 证伪立场（每条断言都必须能因为「少写一个部件」而变红）：
 *  - 不写 xl/media/imageN.png → 字节比对用例变红；
 *  - 不写 xl/drawings/drawing1.xml / 它的 rels → 关系断言变红；
 *  - 不给 sheet 挂 <drawing r:id> → sheet 关系用例变红；
 *  - 不在 workbook.xml / [Content_Types].xml 登记新 sheet → SheetJS 读回只有 4 sheet；
 *  - zipStore 不再校验 DEFLATE → 「压缩包必须显式报错」用例变红。
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { buildReportModel } from '../reportModel';
import { buildExcelReport } from '../excelReport';
import {
  CHART_SHEET_NAME,
  attachDrawingToSheet,
  buildChartSheetXml,
  buildDrawingRels,
  buildDrawingXml,
  decodePngDataUrl,
  embedChartImages,
  emuFromPx,
  type ChartImage,
} from '../excelImages';
import { crc32, readZipEntries, writeZip } from '../zipStore';
import type { Project } from '@/data/schema';
import { CURRENT_SCHEMA_VERSION } from '@/data/schema';

/** 造一张最小可用 PNG（签名 + IHDR + IEND；CRC 置 0，本工具不解 CRC）。 */
function makePng(width: number, height: number, tag = 7): Uint8Array {
  const bytes = new Uint8Array(8 + 25 + 12);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 33); // IEND
  bytes[30] = tag; // 保证不同图的字节不同，便于断言「哪张图进了哪个 media」
  return bytes;
}

function toDataUrl(png: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function makeImages(): ChartImage[] {
  const a = makePng(1200, 300, 1);
  const b = makePng(1200, 400, 2);
  return [
    { name: '控制图', png: a, widthPx: 1200, heightPx: 300 },
    { name: '能力图（直方图 + USL/LSL）', png: b, widthPx: 1200, heightPx: 400 },
  ];
}

function makeRealProject(): Project {
  const shell = Array.from({ length: 50 }, (_, i) => 50 + Math.sin(i) * 0.02);
  const mk = (name: string, values: number[], usl: number, lsl: number, id: string) => ({
    id,
    datasetId: 'ds_1',
    name,
    specLimits: { usl, lsl, target: null, unit: '' },
    measurements: values.map((v, i) => ({
      id: `${id}_${i}`,
      characteristicId: id,
      value: v,
      subgroupId: null,
      timestamp: null,
      batch: null,
      excluded: false,
      excludeReason: null,
    })),
    subgroups: [],
    nullCount: 0,
    outlierFlags: [],
    preprocessConfigRef: null,
    measurementBlobRef: null,
  });
  return {
    id: 'proj_1',
    name: '质量日报',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [
      {
        id: 'ds_1',
        projectId: 'proj_1',
        name: 'quality_data',
        sourceType: 'xlsx',
        importedAt: '2026-01-01T00:00:00.000Z',
        rawFileName: 'quality_data.xlsx',
        characteristics: [mk('外壳长度', shell, 50.2, 49.8, 'c1')],
        defectRecords: [
          { id: 'd1', datasetId: 'ds_1', defectType: '划伤', count: 320, category: null },
        ],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

describe('zipStore', () => {
  it('crc32 与标准值一致（"123456789" → 0xCBF43926）', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writeZip → readZipEntries 往返：文件名与字节都不丢', () => {
    const entries = [
      { name: 'a/b.xml', data: new TextEncoder().encode('<x/>') },
      { name: 'c.png', data: makePng(4, 4) },
    ];
    const parsed = readZipEntries(writeZip(entries));
    expect(parsed.map((e) => e.name)).toEqual(['a/b.xml', 'c.png']);
    expect(new TextDecoder().decode(parsed[0].data)).toBe('<x/>');
    expect([...parsed[1].data]).toEqual([...entries[1].data]);
  });

  it('DEFLATE 包必须显式报错（而不是静默产出坏 xlsx）', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a']]), 'S');
    const compressed = XLSX.write(wb, { bookType: 'xlsx', type: 'array', compression: true });
    expect(() => readZipEntries(compressed)).toThrow(/STORE/);
  });

  it('buildExcelReport 产出必须是 STORE（图片手术依赖这一契约）', () => {
    const buf = buildExcelReport(buildReportModel(makeRealProject()));
    expect(() => readZipEntries(buf)).not.toThrow();
    const names = readZipEntries(buf).map((e) => e.name);
    expect(names).toContain('[Content_Types].xml');
    expect(names).toContain('xl/workbook.xml');
  });
});

describe('decodePngDataUrl', () => {
  it('从 IHDR 读出宽高，且字节零改动', () => {
    const png = makePng(1234, 567);
    const decoded = decodePngDataUrl(toDataUrl(png));
    expect(decoded).not.toBeNull();
    expect(decoded!.widthPx).toBe(1234);
    expect(decoded!.heightPx).toBe(567);
    expect([...decoded!.png]).toEqual([...png]);
  });

  it('非 PNG data URL / 截断字节 / 空串一律返回 null', () => {
    expect(decodePngDataUrl('data:image/jpeg;base64,AAAA')).toBeNull();
    expect(decodePngDataUrl('')).toBeNull();
    expect(decodePngDataUrl('data:image/png;base64,AAAA')).toBeNull();
    expect(decodePngDataUrl(`data:image/png;base64,${Buffer.from([1, 2, 3]).toString('base64')}`)).toBeNull();
  });
});

describe('OOXML 片段', () => {
  it('emuFromPx：1 px = 9525 EMU（96 DPI）', () => {
    expect(emuFromPx(1)).toBe(9525);
    expect(emuFromPx(1200)).toBe(11430000);
  });

  it('attachDrawingToSheet 插在 </worksheet> 前，且不越过 <extLst>', () => {
    expect(attachDrawingToSheet('<worksheet><sheetData/></worksheet>', 'rId1')).toBe(
      '<worksheet><sheetData/><drawing r:id="rId1"/></worksheet>',
    );
    expect(attachDrawingToSheet('<worksheet><extLst><x/></extLst></worksheet>', 'rId1')).toBe(
      '<worksheet><drawing r:id="rId1"/><extLst><x/></extLst></worksheet>',
    );
    expect(() => attachDrawingToSheet('<worksheet>', 'rId1')).toThrow();
  });

  it('drawing 片段引用每张图各自的 rId 与像素尺寸', () => {
    const images = makeImages();
    const xml = buildDrawingXml(images);
    expect(xml).toContain('r:embed="rId1"');
    expect(xml).toContain('r:embed="rId2"');
    expect(xml).toContain(`cx="${emuFromPx(1200)}" cy="${emuFromPx(300)}"`);
    expect(xml).toContain(`cx="${emuFromPx(1200)}" cy="${emuFromPx(400)}"`);
    const rels = buildDrawingRels(images);
    expect(rels).toContain('Target="../media/image1.png"');
    expect(rels).toContain('Target="../media/image2.png"');
    const sheet = buildChartSheetXml(images);
    expect(sheet).toContain('<drawing r:id="rId1"/>');
    expect(sheet).toContain('控制图');
  });
});

describe('embedChartImages', () => {
  it('空图片列表 → 原样返回（不浪费一次重打包）', () => {
    const buf = buildExcelReport(buildReportModel(makeRealProject()));
    expect(embedChartImages(buf, [])).toBe(buf);
  });

  it('内嵌后：media 字节一致、drawing/rels/内容类型/工作表清单齐备', () => {
    const images = makeImages();
    const out = embedChartImages(buildExcelReport(buildReportModel(makeRealProject())), images);
    const entries = new Map(readZipEntries(out).map((e) => [e.name, e.data]));
    const text = (n: string) => new TextDecoder().decode(entries.get(n)!);

    // 1) 图片字节：必须与源 PNG 完全一致
    expect([...entries.get('xl/media/image1.png')!]).toEqual([...images[0].png]);
    expect([...entries.get('xl/media/image2.png')!]).toEqual([...images[1].png]);

    // 2) drawing 部件与它的关系
    expect(text('xl/drawings/drawing1.xml')).toContain('r:embed="rId1"');
    expect(text('xl/drawings/_rels/drawing1.xml.rels')).toContain('../media/image2.png');

    // 3) 新 sheet 部件 + 它的 drawing 关系
    const sheetName = [...entries.keys()].find((n) => n === 'xl/worksheets/sheet5.xml');
    expect(sheetName, '新 sheet 必须落在 sheet5.xml（4 个数据 sheet 之后）').toBeTruthy();
    expect(text('xl/worksheets/sheet5.xml')).toContain('<drawing r:id="rId1"/>');
    expect(text('xl/worksheets/_rels/sheet5.xml.rels')).toContain('../drawings/drawing1.xml');

    // 4) 登记：workbook.xml / workbook.xml.rels / [Content_Types].xml / docProps/app.xml
    expect(text('xl/workbook.xml')).toContain(`name="${CHART_SHEET_NAME}"`);
    expect(text('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet5.xml"');
    expect(text('[Content_Types].xml')).toContain('PartName="/xl/worksheets/sheet5.xml"');
    expect(text('[Content_Types].xml')).toContain('Extension="png"');
    expect(text('docProps/app.xml')).toContain(`<vt:lpstr>${CHART_SHEET_NAME}</vt:lpstr>`);
    expect(text('docProps/app.xml')).toContain('<vt:vector size="5" baseType="lpstr">');
  });

  it('★ [Content_Types].xml 必须给 drawing 部件登记 Override（否则 Excel/WPS 丢掉整张 drawing）', () => {
    // 这一条是「用户导出的 Excel 里一张图都没有」的真实根因：
    // SheetJS 写的 [Content_Types].xml 只有
    //   <Default Extension="xml" ContentType="application/xml"/>
    // 没有 drawing 的 Override 时，xl/drawings/drawing1.xml 会按扩展名落到 Default、
    // 被声明成 application/xml（规范要求 ...drawing+xml）。Excel / WPS 判定违规后
    // 直接丢掉整张 drawing —— 用户看到「没有图片」。
    // 而 openpyxl 是按关系找 drawing 的、根本不读 content type，所以旧探针全绿。
    const out = embedChartImages(buildExcelReport(buildReportModel(makeRealProject())), makeImages());
    const entries = new Map(readZipEntries(out).map((e) => [e.name, e.data]));
    const ct = new TextDecoder().decode(entries.get('[Content_Types].xml')!);
    expect(ct).toContain(
      'PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"',
    );
  });

  it('SheetJS 独立读回：5 个 sheet，且「图表」排最后（不破坏原有 4 个数据 sheet）', () => {
    const out = embedChartImages(buildExcelReport(buildReportModel(makeRealProject())), makeImages());
    const wb = XLSX.read(out, { type: 'array' });
    expect(wb.SheetNames).toEqual(['CPK汇总', '不良统计', '原始尺寸', '原始不良', CHART_SHEET_NAME]);
  });
});
