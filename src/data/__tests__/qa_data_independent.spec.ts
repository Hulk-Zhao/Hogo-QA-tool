/**
 * QA 独立验证（T02 数据层）——由 QA 单独编写，不复用开发者测试用例。
 *
 * 立场：证伪优先。重点攻击开发者自测未覆盖的角落：
 * 1. 真实 xlsx 结构性校验（用原始字节独立统计 sheet 名/行数/列数，
 *    不依赖 parseXlsx 自报），交叉核对 buildModel 聚合结果；
 * 2. 精度保真（不做舍入）——用原始字节解析出的首/末值逐一比对；
 * 3. JSON 项目包 round-trip 的「逐字段深比较」；含重复测（幂等）；
 * 4. schemaVersion 迁移的边界（null/数组/字符串版本、v2 骨架、迁移后版本号）；
 * 5. 列名变体容错与错误定位（sheet 名 + 行号 + 列名）;
 * 6. 20 万测量值上限「提示行为」（架构 §0.2 #9）——独立核查是否存在。
 */

import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { HogoError } from '../errors';
import { parseXlsx } from '../importer/xlsxImporter';
import { parseCsv } from '../importer/csvImporter';
import { buildModel } from '../importer/buildModel';
import { autoMapColumns } from '../importer/xlsxImporter';
import {
  exportProjectPackage,
  importProjectPackage,
  importProjectPackageWithIdOption,
} from '../exporter/projectPackage';
import { canMigrate, migrateProject, readSchemaVersion, validateProject } from '../migrations';
import { CURRENT_SCHEMA_VERSION, type Project } from '../schema';

import { describeReal, readRealXlsx } from './realData';

/** 手工构造 xlsx（ArrayBuffer）。 */
function makeXlsx(sheets: Record<string, unknown[][]>): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
}

/** 深比较用：把对象规范成稳定字符串（排序 key）。 */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

describeReal('QA-D1 真实 xlsx 结构独立核验（不信任 parseXlsx 自报）', () => {
  it('用原始字节读 sheet 名与行数，核对 parseXlsx 的结果', () => {
    const buf = readRealXlsx();
    // 独立读取（不经 parseXlsx）
    const wb = XLSX.read(buf, { type: 'array' });
    const sheetNames = wb.SheetNames;
    // 至少存在一个 dimension 类与 defect 类 sheet
    const dimName = sheetNames.find(
      (n) => n.toLowerCase().includes('dimension') || n.includes('尺寸') || n.includes('测量'),
    );
    const defName = sheetNames.find(
      (n) => n.toLowerCase().includes('defect') || n.includes('不良') || n.includes('缺陷'),
    );
    expect(dimName).toBeTruthy();
    expect(defName).toBeTruthy();

    const dimRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[dimName!], {
      header: 1,
      blankrows: false,
      defval: null,
    });
    const defRows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[defName!], {
      header: 1,
      blankrows: false,
      defval: null,
    });
    // 独立统计：dimension = 1 表头 + 150 数据；defect = 1 表头 + 6 数据
    expect(dimRows.length).toBe(151);
    expect(defRows.length).toBe(7);

    // 与 parseXlsx 自报一致
    const parsed = parseXlsx(buf);
    expect(parsed.dimensionSheet!.rows.length).toBe(150);
    expect(parsed.defectSheet!.rows.length).toBe(6);
    expect(parsed.measurementCount).toBe(150);
    expect(parsed.errors).toEqual([]);
  });

  it('独立点数：3 物料各 50，且 defect 合计 = 838', () => {
    const parsed = parseXlsx(readRealXlsx());
    const built = buildModel({
      projectId: 'qa',
      datasetName: 'q',
      sourceType: 'xlsx',
      rawFileName: 'q.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: { sheet: parsed.defectSheet!, mapping: parsed.defectMapping!.mapping },
    });
    const byName = new Map(built.dataset.characteristics.map((c) => [c.name, c.measurements.length]));
    expect(byName.size).toBe(3);
    expect([...byName.values()].every((n) => n === 50)).toBe(true);
    expect(built.totalMeasurements).toBe(150);
    expect(built.totalNullCount).toBe(0);
    const defSum = built.dataset.defectRecords.reduce((s, d) => s + d.count, 0);
    expect(defSum).toBe(838);
  });

  it('精度保真：独立解析出的首/末测量值在 buildModel 中逐位一致（不舍入）', () => {
    const buf = readRealXlsx();
    const wb = XLSX.read(buf, { type: 'array' });
    const dimName = wb.SheetNames.find(
      (n) => n.toLowerCase().includes('dimension') || n.includes('尺寸') || n.includes('测量'),
    )!;
    // 独立取原始数值列（假设测量值在第 2 列，用列别名独立确认）
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[dimName], {
      header: 1,
      blankrows: false,
      defval: null,
      raw: true,
    });
    const header = (matrix[0] as unknown[]).map((c) => String(c ?? ''));
    const parsed = parseXlsx(buf);
    const valueCol = parsed.dimensionMapping!.mapping.value;
    expect(valueCol).toBeGreaterThanOrEqual(0);

    // 独立算出第一组的原始浮点（material 相同的前若干行），与 buildModel 逐位比对
    const matCol = parsed.dimensionMapping!.mapping.material;
    const firstMaterial = String((matrix[1] as unknown[])[matCol] ?? '');
    const rawValues: number[] = [];
    for (let i = 1; i < matrix.length; i += 1) {
      const r = matrix[i] as unknown[];
      if (String(r[matCol] ?? '') !== firstMaterial) break;
      rawValues.push(Number(r[valueCol]));
    }
    const built = buildModel({
      projectId: 'qa',
      datasetName: 'q',
      sourceType: 'xlsx',
      rawFileName: 'q.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: null,
    });
    const c = built.dataset.characteristics.find((x) => x.name === firstMaterial)!;
    expect(c.measurements.length).toBe(rawValues.length);
    for (let i = 0; i < rawValues.length; i += 1) {
      // 逐位比对：Object.is 保证 NaN/精度不掩藏
      expect(Object.is(c.measurements[i].value, rawValues[i])).toBe(true);
    }
    void header;
  });
});

describe('QA-D2 JSON 项目包 round-trip（逐字段深比较 + 幂等）', () => {
  function makeRichProject(): Project {
    return {
      id: 'proj_qa',
      name: 'QA 深比较',
      description: '含特殊字符 / 中文 \\ 换行\n',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      datasets: [
        {
          id: 'ds_qa',
          projectId: 'proj_qa',
          name: 'q',
          sourceType: 'xlsx',
          importedAt: '2026-02-01T00:00:00.000Z',
          rawFileName: 'q.xlsx',
          characteristics: [
            {
              id: 'c_qa',
              datasetId: 'ds_qa',
              name: '外壳长度',
              specLimits: { usl: 50.2, lsl: 49.8, target: 50, unit: 'mm' },
              measurements: [
                {
                  id: 'm1',
                  characteristicId: 'c_qa',
                  value: 50.0091,
                  subgroupId: 'sg1',
                  timestamp: '2026-02-01T08:00:00.000Z',
                  batch: 'B-1',
                  excluded: true,
                  excludeReason: '冷启动',
                },
                {
                  id: 'm2',
                  characteristicId: 'c_qa',
                  value: -0.0000001,
                  subgroupId: null,
                  timestamp: null,
                  batch: null,
                  excluded: false,
                  excludeReason: null,
                },
              ],
              subgroups: [
                {
                  id: 'sg1',
                  characteristicId: 'c_qa',
                  index: 0,
                  size: 2,
                  measurementIds: ['m1', 'm2'],
                  mean: 25,
                  range: 1,
                  std: 0.5,
                },
              ],
              nullCount: 3,
              outlierFlags: [
                { measurementId: 'm1', method: 'iqr', statistic: 3.2, threshold: 3, confirmed: true },
              ],
              preprocessConfigRef: 'ppc_1',
              measurementBlobRef: 'blob_1',
            },
          ],
          defectRecords: [
            { id: 'd1', datasetId: 'ds_qa', defectType: '划伤', count: 320, category: '外观' },
          ],
        },
      ],
      analysisConfigs: [
        {
          id: 'cfg_qa',
          projectId: 'proj_qa',
          name: '默认',
          subgroupCapacity: 5,
          subgroupMode: 'fixed',
          sigmaMode: 'S',
          outlierMethod: 'iqr',
          outlierConfirmedIds: ['m1'],
          weRules: { W1: true, W2: false, W3: true, W4: false },
          nelsonRules: {
            N1: true,
            N2: false,
            N3: true,
            N4: false,
            N5: true,
            N6: false,
            N7: true,
            N8: false,
          },
        },
      ],
      aiUsageLogs: [
        {
          id: 'log1',
          projectId: 'proj_qa',
          feature: 'capExplain',
          sentPayloadScope: 'summary',
          model: 'gpt-x',
          requestedAt: '2026-02-02T00:00:00.000Z',
          ok: true,
        },
      ],
    };
  }

  it('导出→导入：全部子结构逐字段深比较相等', () => {
    const src = makeRichProject();
    const back = importProjectPackage(exportProjectPackage(src));
    expect(stableStringify(back)).toBe(stableStringify(src));
  });

  it('round-trip 幂等：连续两次导入结果一致', () => {
    const src = makeRichProject();
    const once = importProjectPackage(exportProjectPackage(src));
    const twice = importProjectPackage(exportProjectPackage(once));
    expect(stableStringify(once)).toBe(stableStringify(twice));
  });

  it('导入不修改入参以外状态：同一 JSON 文本导入两次互不影响', () => {
    const json = exportProjectPackage(makeRichProject());
    const a = importProjectPackage(json);
    const b = importProjectPackage(json);
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('importProjectPackageWithIdOption(true) 仅换 id，其余字段保持一致', () => {
    const src = makeRichProject();
    const json = exportProjectPackage(src);
    const fresh = importProjectPackageWithIdOption(json, true);
    expect(fresh.id).not.toBe(src.id);
    const a = { ...fresh, id: src.id };
    expect(stableStringify(a)).toBe(stableStringify(src));
  });
});

describe('QA-D3 schemaVersion 迁移边界', () => {
  const base = { id: 'p', name: 'x', schemaVersion: 1 };

  it('readSchemaVersion：null / 数组 / 字符串版本 均抛 SCHEMA_VERSION_UNSUPPORTED', () => {
    for (const bad of [null, [], '1', 1.5, 0, -1, undefined]) {
      expect(() => readSchemaVersion(bad)).toThrowError(HogoError);
      try {
        readSchemaVersion(bad);
      } catch (e) {
        expect((e as HogoError).code).toBe('SCHEMA_VERSION_UNSUPPORTED');
      }
    }
  });

  it('缺 schemaVersion 字段 → 抛错（不静默当 v1）', () => {
    const noVer: Record<string, unknown> = { id: 'p', name: 'x' };
    expect(() => migrateProject(noVer)).toThrowError(HogoError);
  });

  it('字符串 "1" 不会被当成数字 1 放行', () => {
    expect(() => migrateProject({ ...base, schemaVersion: '1' })).toThrowError(HogoError);
  });

  it('canMigrate：0 / -1 / 1.5 / 2 均 false；仅 1 true', () => {
    expect(canMigrate(1)).toBe(true);
    expect(canMigrate(0)).toBe(false);
    expect(canMigrate(-1)).toBe(false);
    expect(canMigrate(1.5)).toBe(false);
    expect(canMigrate(2)).toBe(false);
  });

  it('迁移后 schemaVersion 被规范为 CURRENT_SCHEMA_VERSION', () => {
    const p = migrateProject({ id: 'p', name: 'x', schemaVersion: 1 });
    expect(p.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('v2 骨架函数不引入未知字段（纯规范化容器）', () => {
    // 通过迁移入口间接触达：v1 缺容器 → 补空数组
    const p = migrateProject({ id: 'p', name: 'x', schemaVersion: 1 });
    expect(Array.isArray(p.datasets)).toBe(true);
    expect(Array.isArray(p.analysisConfigs)).toBe(true);
    expect(Array.isArray(p.aiUsageLogs)).toBe(true);
  });

  it('validateProject：analysisConfigs 中规则布尔被严格规范化', () => {
    const proj = validateProject({
      id: 'p',
      analysisConfigs: [{ weRules: { W1: false, W2: 'no' }, nelsonRules: { N5: false } }],
    });
    // 显式 false 保留为 false，非布尔（'no'）→ true（默认开启）
    expect(proj.analysisConfigs[0].weRules.W1).toBe(false);
    expect(proj.analysisConfigs[0].weRules.W2).toBe(true);
    expect(proj.analysisConfigs[0].nelsonRules.N5).toBe(false);
    // 未提供的键默认 true
    expect(proj.analysisConfigs[0].nelsonRules.N1).toBe(true);
  });
});

describe('QA-D4 列名变体容错与错误定位', () => {
  it('全角空格/大小写混合列名可识别', () => {
    // 用全角空格（\u3000）分隔 + 大小写混合；别名表声明支持「去空白 + 全角空格 + 大小写」。
    const buf = makeXlsx({
      dimension: [
        ['　物料名称　', 'MEASUREMENT', 'USL', ' lsl '],
        ['A', 1.0, 2.0, 0.0],
      ],
    });
    const r = parseXlsx(buf);
    expect(r.dimensionMapping!.missingRoles).toEqual([]);
    expect(r.dimensionMapping!.mapping.material).toBe(0);
    expect(r.dimensionMapping!.mapping.value).toBe(1);
    expect(r.dimensionMapping!.mapping.usl).toBe(2);
    expect(r.dimensionMapping!.mapping.lsl).toBe(3);
  });

  it('全角字母列名可识别（P2-C 修复「文档称全角转半角、实现只转全角空格」）', () => {
    // 历史：columnAliases.ts 注释一直写着「规范化（去空白、全角转半角、转小写）」，
    // 但 normalizeColumnName 只把全角空格换成半角，「全角字母」从未实现 ——
    // 现场用中文输入法导入的 ＵＳＬ/ＬＳＬ 一律被判定为未识别列。
    // 本轮 P2-C 补齐 toHalfWidthAscii 后，本用例由「记录不一致现状」转为回归防护。
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值', 'ＵＳＬ', 'ＬＳＬ'],
        ['A', 1.0, 2.0, 0.0],
      ],
    });
    const r = parseXlsx(buf);
    expect(r.dimensionMapping!.mapping.usl).toBe(2);
    expect(r.dimensionMapping!.mapping.lsl).toBe(3);
    expect(r.dimensionMapping!.missingRoles).toEqual([]);
  });

  it('千分位/全角数值可解析（1,234.5 与全角数字）', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值'],
        ['A', '1,234.5'],
        ['A', '１２３'],
      ],
    });
    const parsed = parseXlsx(buf);
    expect(parsed.errors).toEqual([]);
    const built = buildModel({
      projectId: 'q',
      datasetName: 'q',
      sourceType: 'xlsx',
      rawFileName: 'q.xlsx',
      dimension: { sheet: parsed.dimensionSheet!, mapping: parsed.dimensionMapping!.mapping },
      defect: null,
    });
    expect(built.dataset.characteristics[0].measurements.map((m) => m.value)).toEqual([1234.5, 123]);
  });

  it('错误定位带 sheet 名 + 行号 + 列名（非法值）', () => {
    const buf = makeXlsx({
      dimension: [
        ['物料名称', '测量值'],
        ['A', 1.0],
        ['A', 'oops'],
      ],
    });
    const r = parseXlsx(buf);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0].sheetName).toBe('dimension');
    expect(r.errors[0].rowNumber).toBe(3); // 表头为第 1 行
    expect(r.errors[0].column).toContain('测量值');
    expect(r.errors[0].rawValue).toBe('oops');
  });

  it('defect 缺不良数量列 → IMPORT_COLUMN_MISMATCH 且文案含缺失列名', () => {
    const buf = makeXlsx({
      defect: [
        ['不良类型'],
        ['划伤'],
      ],
    });
    try {
      parseXlsx(buf);
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(HogoError);
      expect((e as HogoError).code).toBe('IMPORT_COLUMN_MISMATCH');
      expect((e as HogoError).message).toContain('不良数量');
    }
  });

  it('同名列重复时只取首列（不误吞）', () => {
    const sheet = {
      sheetName: 'dimension',
      header: ['物料名称', '测量值', '测量值'],
      rows: [['A', 1, 2]],
      firstDataRowNumber: 2,
    };
    const m = autoMapColumns(sheet, 'dimension');
    expect(m.mapping.value).toBe(1);
    // 第二列同名 → 归入 unmapped
    expect(m.unmappedColumns.some((u) => u.index === 2)).toBe(true);
  });

  it('空表（仅表头无数据）→ 该 sheet 视为空并出 warning，不抛', () => {
    const buf = makeXlsx({ dimension: [['物料名称', '测量值']] });
    const r = parseXlsx(buf);
    expect(r.warnings.length).toBeGreaterThanOrEqual(1);
    expect(r.measurementCount).toBe(0);
  });
});

describe('QA-D5 20 万测量值上限「提示行为」（架构 §0.2 #9；仅提示不阻断不截断）', () => {
  const LIMIT_RE = /20\s*万|200000|上限|分批|超出|超过/;

  /** 构造 dimension xlsx（指定数据行数）。 */
  function makeDimXlsx(rowCount: number): ArrayBuffer {
    const rows: (string | number | null)[][] = [];
    for (let i = 0; i < rowCount; i += 1) rows.push(['A', i * 0.001]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([['物料名称', '测量值'], ...rows]),
      'dimension',
    );
    return XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  }

  it('阈值边界：恰好 200000 条 → 不提示（上限「含」）', () => {
    const r = parseXlsx(makeDimXlsx(200_000));
    expect(r.measurementCount).toBe(200_000);
    expect(r.warnings.filter((w) => LIMIT_RE.test(w)).length).toBe(0);
  });

  it('200001 条 → 出现且仅出现 1 条超限提示，measurementCount 不截断', () => {
    const r = parseXlsx(makeDimXlsx(200_001));
    expect(r.measurementCount).toBe(200_001); // 不截断
    const hits = r.warnings.filter((w) => LIMIT_RE.test(w));
    expect(hits.length).toBe(1);
    // 文案应含「200000」与「分批」语义
    expect(hits[0]).toContain('200000');
    expect(hits[0]).toMatch(/分批/);
  });

  it('超限仅提示：不抛错，且有效测量值全部保留（建模条数一致）', () => {
    const r = parseXlsx(makeDimXlsx(200_001));
    // 不抛 —— 若抛错上一行即失败
    expect(r.errors).toEqual([]);
    const built = buildModel({
      projectId: 'qa',
      datasetName: 'q',
      sourceType: 'xlsx',
      rawFileName: 'q.xlsx',
      dimension: { sheet: r.dimensionSheet!, mapping: r.dimensionMapping!.mapping },
      defect: null,
    });
    // 数据未被静默截断（静默截断比不提示更危险）
    expect(built.totalMeasurements).toBe(200_001);
  });

  it('不同来源文案可区分：xlsx 来源标识存在', () => {
    const r = parseXlsx(makeDimXlsx(200_001));
    const hit = r.warnings.find((w) => LIMIT_RE.test(w))!;
    expect(hit).toMatch(/xlsx/i);
  });

  it('csv 长表 20 万边界：parseCsv 暴露 measurementCount 且未超限不提示', () => {
    const lines = ['物料名称,测量值'];
    for (let i = 0; i < 1000; i += 1) lines.push(`A,${i}`);
    const r = parseCsv(lines.join('\n'));
    expect(r.measurementCount).toBe(1000);
    expect(r.warnings.filter((w) => LIMIT_RE.test(w)).length).toBe(0);
  });
});
