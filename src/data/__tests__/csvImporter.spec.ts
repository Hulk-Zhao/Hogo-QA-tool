/**
 * csvImporter / clipboardImporter 测试（PRD P0-16）。
 *
 * 覆盖：正常长表、缺列、非法数值、空值、宽表展开、分隔符探测、粘贴。
 */

import { describe, expect, it } from 'vitest';
import { HogoError } from '../errors';
import { detectDelimiter, parseCsv, parseCsvLine } from '../importer/csvImporter';
import { parseClipboard } from '../importer/clipboardImporter';
import { buildModel } from '../importer/buildModel';

describe('detectDelimiter', () => {
  it('识别制表符', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('识别逗号', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('识别分号', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
});

describe('parseCsvLine', () => {
  it('处理引号与转义引号', () => {
    expect(parseCsvLine('"a,b",c', ',')).toEqual(['a,b', 'c']);
    expect(parseCsvLine('"he said ""hi""",x', ',')).toEqual(['he said "hi"', 'x']);
  });
});

describe('parseCsv：长表', () => {
  it('正常长表解析 + 自动映射', () => {
    const csv = ['物料名称,测量值,USL,LSL', '外壳长度,50.0091,50.2,49.8', '外壳长度,49.9688,50.2,49.8'].join(
      '\n',
    );
    const out = parseCsv(csv);
    expect(out.wideExpanded).toBe(false);
    expect(out.errors).toEqual([]);
    expect(out.mapping.mapping.material).toBe(0);
    expect(out.mapping.mapping.value).toBe(1);
    expect(out.sheet.rows.length).toBe(2);
  });

  it('缺列 → 抛 IMPORT_COLUMN_MISMATCH', () => {
    const csv = ['物料名称,USL,LSL', 'A,2,0'].join('\n');
    try {
      parseCsv(csv, { forceShape: 'long' });
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as HogoError).code).toBe('IMPORT_COLUMN_MISMATCH');
    }
  });

  it('非法数值报出行号与原因', () => {
    const csv = ['物料名称,测量值', 'A,1.0', 'A,abc', 'A,2.0'].join('\n');
    const out = parseCsv(csv);
    expect(out.errors.length).toBe(1);
    expect(out.errors[0].rowNumber).toBe(3);
    expect(out.errors[0].reason).toContain('非法数值');
    expect(out.errors[0].rawValue).toBe('abc');
  });

  it('空值不报错（缺失语义）', () => {
    const csv = ['物料名称,测量值', 'A,1.0', 'A,', 'A,2.0'].join('\n');
    const out = parseCsv(csv);
    expect(out.errors).toEqual([]);
  });

  it('空 CSV → 抛 IMPORT_EMPTY', () => {
    expect(() => parseCsv('')).toThrowError(HogoError);
  });
});

describe('parseCsv：宽表', () => {
  it('一行一子组展开为长表', () => {
    const csv = ['物料名称,1,2,3', '外壳长度,50.0091,49.9688,50.0225'].join('\n');
    const out = parseCsv(csv, { forceShape: 'wide' });
    expect(out.wideExpanded).toBe(true);
    expect(out.sheet.rows.length).toBe(3);
    expect(out.sheet.rows[0][0]).toBe('外壳长度');
    expect(out.sheet.rows[0][1]).toBe(50.0091);
    // 子组键来自行序号
    expect(out.sheet.rows[0][2]).toBe('1');
  });

  it('宽表非法单元格报错并跳过', () => {
    const csv = ['物料名称,1,2', '外壳长度,50.0,oops'].join('\n');
    const out = parseCsv(csv, { forceShape: 'wide' });
    expect(out.errors.length).toBe(1);
    expect(out.errors[0].rawValue).toBe('oops');
    // 仅展开合法单元格
    expect(out.sheet.rows.length).toBe(1);
  });
});

describe('parseClipboard', () => {
  it('解析 Tab 分隔的粘贴内容', () => {
    const text = ['物料名称\t测量值\tUSL\tLSL', '外壳长度\t50.0091\t50.2\t49.8'].join('\n');
    const out = parseClipboard(text);
    expect(out.sheet.rows.length).toBe(1);
    expect(out.sheet.rows[0][1]).toBe(50.0091);
  });

  it('CRLF 归一化', () => {
    const text = '物料名称,测量值\r\nA,1.5\r\nA,2.5';
    const out = parseClipboard(text);
    expect(out.sheet.rows.length).toBe(2);
  });
});

describe('buildModel：CSV 空值计入 nullCount', () => {
  it('空测量值累加 nullCount 且不生成 Measurement', () => {
    const csv = ['物料名称,测量值', 'A,1.0', 'A,', 'A,3.0'].join('\n');
    const out = parseCsv(csv);
    const built = buildModel({
      projectId: 'p1',
      datasetName: 'csv-ds',
      sourceType: 'csv',
      rawFileName: 'data.csv',
      dimension: { sheet: out.sheet, mapping: out.mapping.mapping },
      defect: null,
    });
    expect(built.dataset.characteristics.length).toBe(1);
    expect(built.dataset.characteristics[0].measurements.length).toBe(2);
    expect(built.dataset.characteristics[0].nullCount).toBe(1);
    expect(built.totalNullCount).toBe(1);
  });
});
