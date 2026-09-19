/**
 * exportExcelReportDetailed 接线测试（P3-D）。
 *
 * 证伪立场：把 `embedChartImages(...)` 换成直接返回数据包（即「忘了内嵌」）
 * → 「产物里必须有 xl/media」变红；把 imageCount 写死成 0 → 提示用例变红；
 * 把 aiRows 漏传给 buildExcelReport → 「AI 分析 sheet 存在 + 正文在 D 列」变红。
 */

import { describe, expect, it, vi } from 'vitest';
import { readZipEntries } from '@/data/exporter/zipStore';
import { buildReportModel } from '@/data/exporter/reportModel';
import { exportExcelReport, exportExcelReportDetailed } from '@/services/report/reportService';
import * as XLSX from 'xlsx';
import type { ChartImage } from '@/data/exporter/excelImages';
import { AI_SHEET_NAME, type AiSheetRow } from '@/data/exporter/excelReport';
import type { Project } from '@/data/schema';
import { CURRENT_SCHEMA_VERSION } from '@/data/schema';

function makePng(width: number, height: number): Uint8Array {
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

const IMAGES: ChartImage[] = [
  { name: '控制图', png: makePng(800, 300), widthPx: 800, heightPx: 300 },
  { name: '能力图', png: makePng(800, 320), widthPx: 800, heightPx: 320 },
];

function makeProject(): Project {
  const values = Array.from({ length: 40 }, (_, i) => 50 + Math.sin(i) * 0.02);
  return {
    id: 'p1',
    name: '质量日报',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [
      {
        id: 'ds1',
        projectId: 'p1',
        name: 'd',
        sourceType: 'xlsx',
        importedAt: '2026-01-01T00:00:00.000Z',
        rawFileName: 'd.xlsx',
        characteristics: [
          {
            id: 'c1',
            datasetId: 'ds1',
            name: '外壳长度',
            specLimits: { usl: 50.2, lsl: 49.8, target: null, unit: 'mm' },
            measurements: values.map((v, i) => ({
              id: 'm' + String(i),
              characteristicId: 'c1',
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
          },
        ],
        defectRecords: [],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

function model() {
  return buildReportModel(makeProject());
}

describe('exportExcelReportDetailed', () => {
  it('aiRows 真的进了产物：多出「AI 分析」sheet，正文落在 D 列', () => {
    const save = vi.fn<(data: ArrayBuffer, name: string, mime: string) => void>();
    const rows: AiSheetRow[] = [
      { module: 'CPK 汇总', status: '已生成', model: 'qwen3.5:9b', analysis: '正文' },
    ];
    const result = exportExcelReportDetailed(model(), save, () => IMAGES, rows);

    expect(result.aiModuleCount).toBe(1);
    const wb = XLSX.read(save.mock.calls[0][0], { type: 'array' }) as XLSX.WorkBook;
    expect(wb.SheetNames).toContain(AI_SHEET_NAME);
    expect(wb.SheetNames).toContain('图表');
    const sheet = wb.Sheets[AI_SHEET_NAME] as XLSX.WorkSheet;
    expect(sheet.A1?.v).toBe('报表模块');
    expect(sheet.D2?.v).toBe('正文');
  });

  it('不传 aiRows：没有「AI 分析」sheet，aiModuleCount=0', () => {
    const save = vi.fn<(data: ArrayBuffer, name: string, mime: string) => void>();
    const result = exportExcelReportDetailed(model(), save, () => IMAGES);

    expect(result.aiModuleCount).toBe(0);
    const wb = XLSX.read(save.mock.calls[0][0], { type: 'array' }) as XLSX.WorkBook;
    expect(wb.SheetNames).not.toContain(AI_SHEET_NAME);
  });
  it('有图表：产物含 xl/media 与「图表」sheet，并返回内嵌张数', () => {
    const save = vi.fn<(data: ArrayBuffer, name: string, mime: string) => void>();
    const result = exportExcelReportDetailed(model(), save, () => IMAGES);

    expect(result.imageCount).toBe(2);
    expect(result.fileName.endsWith('.xlsx')).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);

    const [buffer, fileName, mime] = save.mock.calls[0];
    expect(fileName).toBe(result.fileName);
    expect(mime).toContain('spreadsheetml');
    const names = readZipEntries(buffer).map((e) => e.name);
    expect(names).toContain('xl/media/image1.png');
    expect(names).toContain('xl/media/image2.png');
    expect(names).toContain('xl/worksheets/sheet5.xml');
    expect(names).toContain('xl/drawings/drawing1.xml');
  });

  it('页面没有图表：退化为纯数据文件（不塞空 media、imageCount=0）', () => {
    const save = vi.fn<(data: ArrayBuffer, name: string, mime: string) => void>();
    const result = exportExcelReportDetailed(model(), save, () => []);

    expect(result.imageCount).toBe(0);
    const names = readZipEntries(save.mock.calls[0][0]).map((e) => e.name);
    expect(names.some((n) => n.startsWith('xl/media/'))).toBe(false);
    expect(names).not.toContain('xl/worksheets/sheet5.xml');
  });

  it('exportExcelReport 兼容入口仍然只返回文件名', () => {
    const save = vi.fn<(data: ArrayBuffer, name: string, mime: string) => void>();
    expect(exportExcelReport(model(), save)).toContain('.xlsx');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
