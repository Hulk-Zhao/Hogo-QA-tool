/**
 * xlsxImporter 测试：旧工具真实文件导入 + 列名变体容错。
 *
 * 硬要求（team-lead T02）：直接导入
 * 旧版 Python 工具的 quality_data.xlsx（现随仓库提供：`src/data/__tests__/fixtures/quality_data.xlsx`），不改列名；
 * dimension 150 行（3 物料各 50），defect 6 类与真实值一致。
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { HogoError } from '../errors';
import { parseXlsx } from '../importer/xlsxImporter';
import { buildModel } from '../importer/buildModel';

import { describeReal, readRealXlsx } from './realData';

/** 用 SheetJS 手工构造一个含指定列的 xlsx（列名变体测试用）。 */
function makeXlsx(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

describeReal('parseXlsx：真实基准文件', () => {
  it('识别 dimension / defect，解析出正确条数', () => {
    const result = parseXlsx(readRealXlsx());
    expect(result.dimensionSheet).not.toBeNull();
    expect(result.defectSheet).not.toBeNull();
    expect(result.dimensionSheet!.rows.length).toBe(150);
    expect(result.defectSheet!.rows.length).toBe(6);
    expect(result.measurementCount).toBe(150);
    expect(result.errors).toEqual([]);
  });

  it('自动映射 dimension 四列（物料名称/测量值/USL/LSL）', () => {
    const result = parseXlsx(readRealXlsx());
    const m = result.dimensionMapping!;
    expect(m.missingRoles).toEqual([]);
    expect(m.mapping.material).toBe(0);
    expect(m.mapping.value).toBe(1);
    expect(m.mapping.usl).toBe(2);
    expect(m.mapping.lsl).toBe(3);
  });

  it('自动映射 defect 两列（不良类型/不良数量）', () => {
    const result = parseXlsx(readRealXlsx());
    const m = result.defectMapping!;
    expect(m.missingRoles).toEqual([]);
    expect(m.mapping.defectType).toBe(0);
    expect(m.mapping.defectCount).toBe(1);
  });

  it('buildModel：3 个物料各 50 条，USL/LSL 正确落到 specLimits', () => {
    const parsed = parseXlsx(readRealXlsx());
    const built = buildModel({
      projectId: 'p1',
      datasetName: 'quality_data',
      sourceType: 'xlsx',
      rawFileName: 'quality_data.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: { sheet: parsed.defectSheet!, mapping: parsed.defectMapping!.mapping },
    });
    expect(built.dataset.characteristics.length).toBe(3);
    const names = built.dataset.characteristics.map((c) => c.name);
    expect(names).toEqual(['外壳长度', '转轴直径', '安装孔径']);
    const shell = built.dataset.characteristics[0];
    expect(shell.measurements.length).toBe(50);
    expect(shell.specLimits.usl).toBeCloseTo(50.2, 6);
    expect(shell.specLimits.lsl).toBeCloseTo(49.8, 6);
    expect(shell.nullCount).toBe(0);
    const shaft = built.dataset.characteristics[1];
    expect(shaft.specLimits.usl).toBeCloseTo(12.02, 6);
    expect(shaft.specLimits.lsl).toBeCloseTo(11.98, 6);
    const hole = built.dataset.characteristics[2];
    expect(hole.specLimits.usl).toBeCloseTo(8.1, 6);
    expect(hole.specLimits.lsl).toBeCloseTo(7.9, 6);
    expect(built.totalMeasurements).toBe(150);
    expect(built.totalNullCount).toBe(0);

    // 首值精度保留（不做舍入）
    expect(shell.measurements[0].value).toBe(50.0091);
  });

  it('buildModel：6 类不良数量与真实值一致', () => {
    const parsed = parseXlsx(readRealXlsx());
    const built = buildModel({
      projectId: 'p1',
      datasetName: 'quality_data',
      sourceType: 'xlsx',
      rawFileName: 'quality_data.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: { sheet: parsed.defectSheet!, mapping: parsed.defectMapping!.mapping },
    });
    const counts: Record<string, number> = {};
    for (const d of built.dataset.defectRecords) {
      counts[d.defectType] = d.count;
    }
    expect(counts).toEqual({
      划伤: 320,
      尺寸超差: 215,
      毛边: 148,
      色差: 92,
      变形: 45,
      异物: 18,
    });
    expect(built.dataset.defectRecords.length).toBe(6);
  });
});

describe('parseXlsx：列名变体容错', () => {
  it('识别 USL/usl/规格上限 变体', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值', 'usl', '规格下限'],
        ['A', 1.0, 2.0, 0.0],
      ],
    });
    const result = parseXlsx(buf);
    expect(result.dimensionMapping!.missingRoles).toEqual([]);
    expect(result.dimensionMapping!.mapping.usl).toBe(2);
    expect(result.dimensionMapping!.mapping.lsl).toBe(3);
  });

  it('识别复数变体（零件名称/实测值/上公差/下公差）', () => {
    const buf = makeXlsx({
      dimension: [
        ['零件名称', '实测值', '上公差', '下公差'],
        ['B', 5.0, 6.0, 4.0],
      ],
    });
    const result = parseXlsx(buf);
    expect(result.dimensionMapping!.missingRoles).toEqual([]);
    expect(result.dimensionMapping!.mapping.material).toBe(0);
    expect(result.dimensionMapping!.mapping.value).toBe(1);
  });

  it('缺少测量值列 → 抛 IMPORT_COLUMN_MISMATCH，信息含工作表名与缺失列', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', 'USL', 'LSL'],
        ['A', 2.0, 0.0],
      ],
    });
    try {
      parseXlsx(buf);
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(HogoError);
      const err = e as HogoError;
      expect(err.code).toBe('IMPORT_COLUMN_MISMATCH');
      expect(err.message).toContain('测量值');
      expect(err.message).toContain('dimension');
    }
  });

  it('完全无法识别的列名 → 抛 IMPORT_COLUMN_MISMATCH', () => {
    const buf = makeXlsx({
      dimension: [
        ['colA', 'colB'],
        ['x', 'y'],
      ],
    });
    expect(() => parseXlsx(buf)).toThrowError(HogoError);
  });

  it('无 dimension/defect sheet → 抛 IMPORT_EMPTY', () => {
    const buf = makeXlsx({ random: [['a', 'b'], [1, 2]] });
    try {
      parseXlsx(buf);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as HogoError).code).toBe('IMPORT_EMPTY');
    }
  });
});

describe('parseXlsx：空值与非法值', () => {
  it('空测量值计入 errors 但不阻断（null 语义）', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值'],
        ['A', 1.0],
        ['A', null],
        ['A', 'abc'],
      ],
    });
    const result = parseXlsx(buf);
    // 'abc' 报非法；null 视为空值不报错。
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].reason).toContain('非法数值');
    expect(result.errors[0].rowNumber).toBe(4);
    expect(result.errors[0].column).toContain('测量值');
  });

  it('缺失物料名称报错并定位行号', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值'],
        ['', 1.0],
      ],
    });
    const result = parseXlsx(buf);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0].reason).toContain('物料名称');
  });
});
