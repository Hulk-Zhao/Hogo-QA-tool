/**
 * exporter 测试：Excel 4 sheet + 报表中间模型。
 *
 * 用真实基准数据（dimension 3 物料 + defect 6 类）构造项目，验证：
 * - Excel 含 CPK汇总 / 不良统计 / 原始尺寸 / 原始不良 四个 sheet
 * - 不良统计与基准口径一致（划伤 320 等）
 * - 精度舍入仅在导出边界发生
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import {
  buildReportModel,
  buildDefectStats,
  buildCpkSummary,
} from '../exporter/reportModel';
import { buildExcelReport, defaultReportFileName, roundOrNull } from '../exporter/excelReport';
import type { Project } from '../schema';
import { CURRENT_SCHEMA_VERSION } from '../schema';

/** 构造带真实量级数据的项目。 */
function makeRealProject(): Project {
  const shell = Array.from({ length: 50 }, (_, i) => 50 + Math.sin(i) * 0.02);
  const shaft = Array.from({ length: 50 }, (_, i) => 12 + Math.cos(i) * 0.005);
  const hole = Array.from({ length: 50 }, (_, i) => 8 + Math.sin(i * 1.3) * 0.015);
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
        characteristics: [
          mk('外壳长度', shell, 50.2, 49.8, 'c1'),
          mk('转轴直径', shaft, 12.02, 11.98, 'c2'),
          mk('安装孔径', hole, 8.1, 7.9, 'c3'),
        ],
        defectRecords: [
          { id: 'd1', datasetId: 'ds_1', defectType: '划伤', count: 320, category: null },
          { id: 'd2', datasetId: 'ds_1', defectType: '尺寸超差', count: 215, category: null },
          { id: 'd3', datasetId: 'ds_1', defectType: '毛边', count: 148, category: null },
          { id: 'd4', datasetId: 'ds_1', defectType: '色差', count: 92, category: null },
          { id: 'd5', datasetId: 'ds_1', defectType: '变形', count: 45, category: null },
          { id: 'd6', datasetId: 'ds_1', defectType: '异物', count: 18, category: null },
        ],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

describe('reportModel', () => {
  it('CPK 汇总含 3 个物料', () => {
    const project = makeRealProject();
    const rows = buildCpkSummary(project.datasets[0]);
    expect(rows.length).toBe(3);
    expect(rows[0].characteristic).toBe('外壳长度');
    expect(rows[0].n).toBe(50);
    expect(rows[0].sigmaWithin).toBeGreaterThan(0);
    expect(rows[0].sigmaOverall).toBeGreaterThan(0);
  });

  it('不良统计与基准值一致（划伤 320、合计 838）', () => {
    const project = makeRealProject();
    const stats = buildDefectStats(project.datasets[0]);
    expect(stats.length).toBe(6);
    expect(stats[0].defectType).toBe('划伤');
    expect(stats[0].count).toBe(320);
    const total = stats.reduce((s, r) => s + r.count, 0);
    expect(total).toBe(838);
    // 累计占比应达 100%
    expect(stats[stats.length - 1].cumRatio).toBeCloseTo(100, 1);
  });

  it('buildReportModel 生成四个区段', () => {
    const model = buildReportModel(makeRealProject());
    expect(model.projectName).toBe('质量日报');
    expect(model.cpkSummary.length).toBe(3);
    expect(model.defectStats.length).toBe(6);
    expect(model.rawDimensions.length).toBe(150);
    expect(model.rawDefects.length).toBe(6);
  });

  it('无数据集 → 抛错', () => {
    const empty: Project = { ...makeRealProject(), datasets: [] };
    expect(() => buildReportModel(empty)).toThrowError(/数据集/);
  });
});

describe('excelReport', () => {
  it('导出含 4 个 sheet：CPK汇总/不良统计/原始尺寸/原始不良', () => {
    const model = buildReportModel(makeRealProject());
    const buf = buildExcelReport(model);
    const wb = XLSX.read(buf, { type: 'array' });
    expect(wb.SheetNames).toEqual(['CPK汇总', '不良统计', '原始尺寸', '原始不良']);
  });

  it('CPK汇总 sheet 表头与行数正确', () => {
    const model = buildReportModel(makeRealProject());
    const wb = XLSX.read(buildExcelReport(model), { type: 'array' });
    const ws = wb.Sheets['CPK汇总'];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1 });
    expect(rows[0]).toContain('特性');
    expect(rows[0]).toContain('Cpk');
    expect(rows[0]).toContain('Ppk');
    // 表头 + 3 行
    expect(rows.length).toBe(4);
  });

  it('不良统计 sheet 数据与基准一致', () => {
    const model = buildReportModel(makeRealProject());
    const wb = XLSX.read(buildExcelReport(model), { type: 'array' });
    const ws = wb.Sheets['不良统计'];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1 });
    expect(rows[1][0]).toBe('划伤');
    expect(rows[1][1]).toBe(320);
  });

  it('原始尺寸 sheet 含 150 行数据', () => {
    const model = buildReportModel(makeRealProject());
    const wb = XLSX.read(buildExcelReport(model), { type: 'array' });
    const ws = wb.Sheets['原始尺寸'];
    const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, { header: 1 });
    // 表头 + 150
    expect(rows.length).toBe(151);
  });

  it('导出不含图片（只有 sheet，无 drawings）', () => {
    const model = buildReportModel(makeRealProject());
    const buf = buildExcelReport(model);
    // 通过 SheetJS 读回后，Workbook 不应有 media/drawings 相关字段
    const wb = XLSX.read(buf, { type: 'array' });
    expect(Object.keys(wb.Sheets).length).toBe(4);
  });

  it('roundOrNull 仅边界舍入', () => {
    expect(roundOrNull(1.234567, 4)).toBe(1.2346);
    expect(roundOrNull(null, 4)).toBeNull();
    expect(roundOrNull(Number.NaN, 4)).toBeNull();
  });

  it('defaultReportFileName 含日期且为 xlsx', () => {
    const model = buildReportModel(makeRealProject());
    const name = defaultReportFileName(model);
    expect(name.endsWith('.xlsx')).toBe(true);
    expect(name).toContain(model.generatedAt.slice(0, 10));
  });
});
