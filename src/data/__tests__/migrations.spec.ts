/**
 * 迁移与项目包测试（PRD P0-20；硬约束 2）。
 *
 * 覆盖：
 * - JSON 项目包 round-trip（导出→导入→数据一致）
 * - schemaVersion 迁移：旧版本包可升级；未知版本明确报错
 * - 结构校验对缺失字段的规范化
 */

import { describe, expect, it } from 'vitest';
import { HogoError } from '../errors';
import {
  exportProjectPackage,
  importProjectPackage,
  importProjectPackageWithIdOption,
  defaultPackageFileName,
} from '../exporter/projectPackage';
import { canMigrate, migrateProject, readSchemaVersion, validateProject } from '../migrations';
import { CURRENT_SCHEMA_VERSION, type Project } from '../schema';

function makeProject(): Project {
  return {
    id: 'proj_1',
    name: '外壳检验',
    description: 'baseline',
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
          {
            id: 'char_1',
            datasetId: 'ds_1',
            name: '外壳长度',
            specLimits: { usl: 50.2, lsl: 49.8, target: null, unit: '' },
            measurements: [
              {
                id: 'm1',
                characteristicId: 'char_1',
                value: 50.0091,
                subgroupId: null,
                timestamp: null,
                batch: null,
                excluded: false,
                excludeReason: null,
              },
              {
                id: 'm2',
                characteristicId: 'char_1',
                value: 49.9688,
                subgroupId: null,
                timestamp: null,
                batch: null,
                excluded: false,
                excludeReason: null,
              },
            ],
            subgroups: [],
            nullCount: 0,
            outlierFlags: [],
            preprocessConfigRef: null,
            measurementBlobRef: null,
          },
        ],
        defectRecords: [
          { id: 'def_1', datasetId: 'ds_1', defectType: '划伤', count: 320, category: null },
        ],
      },
    ],
    analysisConfigs: [
      {
        id: 'cfg_1',
        projectId: 'proj_1',
        name: '默认',
        subgroupCapacity: 5,
        subgroupMode: 'fixed',
        sigmaMode: 'R',
        outlierMethod: 'grubbs',
        outlierConfirmedIds: [],
        weRules: { W1: true, W2: true, W3: false, W4: true },
        nelsonRules: {
          N1: true,
          N2: true,
          N3: false,
          N4: true,
          N5: true,
          N6: false,
          N7: true,
          N8: false,
        },
      },
    ],
    aiUsageLogs: [],
  };
}

describe('projectPackage round-trip', () => {
  it('导出→导入 数据一致', () => {
    const src = makeProject();
    const json = exportProjectPackage(src);
    const back = importProjectPackage(json);
    expect(back.id).toBe(src.id);
    expect(back.name).toBe(src.name);
    expect(back.datasets.length).toBe(1);
    expect(back.datasets[0].characteristics[0].measurements.map((m) => m.value)).toEqual([
      50.0091, 49.9688,
    ]);
    expect(back.datasets[0].characteristics[0].specLimits.usl).toBe(50.2);
    expect(back.datasets[0].defectRecords[0].count).toBe(320);
    expect(back.analysisConfigs[0].weRules.W3).toBe(false);
  });

  it('导出 JSON 顶层含 schemaVersion 与 format', () => {
    const json = exportProjectPackage(makeProject());
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(parsed.format).toBe('hogo-qa-project');
  });

  it('可接受裸 Project（无 format 包裹）', () => {
    const src = makeProject();
    const bare = JSON.stringify(src);
    const back = importProjectPackage(bare);
    expect(back.id).toBe('proj_1');
  });

  it('importProjectPackageWithIdOption 可重分配 id', () => {
    const json = exportProjectPackage(makeProject());
    const same = importProjectPackageWithIdOption(json, false);
    expect(same.id).toBe('proj_1');
    const fresh = importProjectPackageWithIdOption(json, true);
    expect(fresh.id).not.toBe('proj_1');
    expect(fresh.id.startsWith('proj_')).toBe(true);
  });

  it('非法 JSON → IMPORT_PARSE_FAILED', () => {
    try {
      importProjectPackage('{ not json');
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as HogoError).code).toBe('IMPORT_PARSE_FAILED');
    }
  });

  it('defaultPackageFileName 去掉非法字符', () => {
    const p = makeProject();
    p.name = '外壳/长度:测试';
    expect(defaultPackageFileName(p)).not.toContain('/');
    expect(defaultPackageFileName(p).endsWith('.hogo.json')).toBe(true);
  });
});

describe('schemaVersion 迁移', () => {
  it('当前版本可直接迁移（无字段丢失）', () => {
    const p = migrateProject(makeProject());
    expect(p.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(p.datasets.length).toBe(1);
  });

  it('v1 旧包（缺容器字段）→ 升级补全为空数组', () => {
    const oldPkg = {
      id: 'proj_old',
      name: '旧包',
      description: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
      schemaVersion: 1,
      // datasets / analysisConfigs / aiUsageLogs 缺失
    };
    const p = migrateProject(oldPkg);
    expect(p.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(p.datasets).toEqual([]);
    expect(p.analysisConfigs).toEqual([]);
    expect(p.aiUsageLogs).toEqual([]);
  });

  it('未知高版本 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const future = { ...makeProject(), schemaVersion: 999 };
    try {
      migrateProject(future);
      throw new Error('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(HogoError);
      expect((e as HogoError).code).toBe('SCHEMA_VERSION_UNSUPPORTED');
      expect((e as HogoError).message).toContain('999');
    }
  });

  it('缺失 schemaVersion → SCHEMA_VERSION_UNSUPPORTED', () => {
    const noVer: Record<string, unknown> = { ...makeProject() };
    delete noVer.schemaVersion;
    try {
      migrateProject(noVer);
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as HogoError).code).toBe('SCHEMA_VERSION_UNSUPPORTED');
    }
  });

  it('schemaVersion 非整数 → SCHEMA_VERSION_UNSUPPORTED', () => {
    const bad = { ...makeProject(), schemaVersion: 1.5 };
    expect(() => migrateProject(bad)).toThrowError(HogoError);
  });

  it('readSchemaVersion 正确读出整数版本', () => {
    expect(readSchemaVersion(makeProject())).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('canMigrate：当前版本 true；过高/过低 false', () => {
    expect(canMigrate(CURRENT_SCHEMA_VERSION)).toBe(true);
    expect(canMigrate(CURRENT_SCHEMA_VERSION + 1)).toBe(false);
    expect(canMigrate(0)).toBe(false);
    expect(canMigrate(-1)).toBe(false);
  });

  it('迁移链结构完整性：从任一支持版本均可到达当前版本', () => {
    // 首期 CURRENT=1，仅版本 1 支持；canMigrate(1)=true。
    let reachable = true;
    for (let v = 1; v <= CURRENT_SCHEMA_VERSION; v += 1) {
      if (!canMigrate(v)) reachable = false;
    }
    expect(reachable).toBe(true);
  });
});

describe('validateProject 结构规范化', () => {
  it('缺失 id → 抛错', () => {
    expect(() => validateProject({ name: 'x' })).toThrowError(HogoError);
  });

  it('非法字段类型被规范化为安全默认值', () => {
    const messy = {
      id: 'p1',
      datasets: [
        {
          id: 'ds1',
          characteristics: [
            {
              id: 'c1',
              specLimits: { usl: '50.2', lsl: null },
              measurements: [{ value: '1.5' }],
            },
          ],
        },
      ],
    };
    const p = validateProject(messy);
    expect(p.datasets[0].sourceType).toBe('json');
    expect(p.datasets[0].characteristics[0].specLimits.usl).toBeNull(); // 非 number → null
    expect(p.datasets[0].characteristics[0].measurements[0].value).toBe(1.5); // 可转数字
    expect(p.datasets[0].characteristics[0].measurements[0].excluded).toBe(false);
  });
});
