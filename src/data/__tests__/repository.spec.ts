/**
 * repository 测试：MemoryRepository 全 CRUD + IdbRepository（内存适配器注入）
 * + OPFS 降级内联。
 *
 * 关键：所有测试通过依赖注入使用内存适配器，绝不触碰浏览器 API
 * （team-lead T02 硬要求）。
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { MemoryRepository } from '../repositories/memoryRepository';
import { IdbRepository } from '../repositories/idbRepository';
import { MemoryFileStore, MemoryKeyValueStore } from '../storage/memoryAdapters';
import { createRepository, memoryDeps } from '../repositories';
import type { Measurement, Project } from '../schema';
import { CURRENT_SCHEMA_VERSION } from '../schema';

/** 构造一个最小可用项目。 */
function makeProject(id = 'proj_1', name = '测试项目'): Project {
  return {
    id,
    name,
    description: 'desc',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [
      {
        id: 'ds_1',
        projectId: id,
        name: 'ds',
        sourceType: 'xlsx',
        importedAt: '2026-01-01T00:00:00.000Z',
        rawFileName: 'f.xlsx',
        characteristics: [
          {
            id: 'char_1',
            datasetId: 'ds_1',
            name: '外壳长度',
            specLimits: { usl: 50.2, lsl: 49.8, target: null, unit: '' },
            measurements: [],
            subgroups: [],
            nullCount: 0,
            outlierFlags: [],
            preprocessConfigRef: null,
            measurementBlobRef: 'meas_char_1.json',
          },
        ],
        defectRecords: [{ id: 'def_1', datasetId: 'ds_1', defectType: '划伤', count: 320, category: null }],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

function makeMeasurements(charId: string, values: number[]): Measurement[] {
  return values.map((v, i) => ({
    id: `${charId}_m${i}`,
    characteristicId: charId,
    value: v,
    subgroupId: null,
    timestamp: null,
    batch: null,
    excluded: false,
    excludeReason: null,
  }));
}

describe('MemoryRepository：全 CRUD', () => {
  let repo: MemoryRepository;
  beforeEach(() => {
    repo = new MemoryRepository();
  });

  it('saveProject → getProject → listProjects', async () => {
    await repo.saveProject(makeProject());
    const got = await repo.getProject('proj_1');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('测试项目');

    const list = await repo.listProjects();
    expect(list.length).toBe(1);
    expect(list[0].datasetCount).toBe(1);
    expect(list[0].characteristicCount).toBe(1);
  });

  it('未命中返回 null', async () => {
    expect(await repo.getProject('nope')).toBeNull();
  });

  it('saveProject 非法 id 抛 STORAGE_UNAVAILABLE', async () => {
    const bad = makeProject('');
    await expect(repo.saveProject(bad)).rejects.toThrowError(/project.id/);
  });

  it('deleteProject 级联删除测量值', async () => {
    await repo.saveProject(makeProject());
    await repo.writeMeasurements('meas_char_1.json', makeMeasurements('char_1', [1, 2, 3]));
    expect((await repo.readMeasurements('meas_char_1.json')).length).toBe(3);
    await repo.deleteProject('proj_1');
    expect(await repo.getProject('proj_1')).toBeNull();
    expect((await repo.readMeasurements('meas_char_1.json')).length).toBe(0);
  });

  it('duplicateProject 生成新 id 与深拷贝数据', async () => {
    await repo.saveProject(makeProject());
    await repo.writeMeasurements('meas_char_1.json', makeMeasurements('char_1', [1, 2, 3]));
    const copy = await repo.duplicateProject('proj_1', '副本');
    expect(copy.id).not.toBe('proj_1');
    expect(copy.name).toBe('副本');
    // 原子性：改副本不影响原项目
    copy.datasets[0].characteristics[0].name = 'X';
    const orig = await repo.getProject('proj_1');
    expect(orig!.datasets[0].characteristics[0].name).toBe('外壳长度');
  });

  it('duplicateProject 不存在 → 抛错', async () => {
    await expect(repo.duplicateProject('nope', 'x')).rejects.toThrowError(/不存在/);
  });

  it('测量值读写删', async () => {
    const ms = makeMeasurements('char_1', [1.1, 2.2, 3.3]);
    await repo.writeMeasurements('ref1', ms);
    const back = await repo.readMeasurements('ref1');
    expect(back.map((m) => m.value)).toEqual([1.1, 2.2, 3.3]);
    await repo.deleteMeasurements('ref1');
    expect(await repo.readMeasurements('ref1')).toEqual([]);
  });

  it('writeMeasurements 空 ref 抛错', async () => {
    await expect(repo.writeMeasurements('', [])).rejects.toThrowError(/ref/);
  });
});

describe('IdbRepository（内存适配器注入）', () => {
  let kv: MemoryKeyValueStore;
  let fs: MemoryFileStore;
  let repo: IdbRepository;

  beforeEach(() => {
    kv = new MemoryKeyValueStore();
    fs = new MemoryFileStore();
    repo = new IdbRepository({ keyValue: kv, fileStore: fs });
  });

  it('saveProject / getProject / listProjects', async () => {
    await repo.saveProject(makeProject());
    const got = await repo.getProject('proj_1');
    expect(got!.name).toBe('测试项目');
    const list = await repo.listProjects();
    expect(list.length).toBe(1);
  });

  it('大数组写入 OPFS（FileStore）而非内联', async () => {
    await repo.writeMeasurements('meas_char_1.json', makeMeasurements('char_1', [1, 2, 3, 4]));
    // OPFS 中应存在文件
    expect(await fs.exists('meas_char_1.json')).toBe(true);
    const back = await repo.readMeasurements('meas_char_1.json');
    expect(back.map((m) => m.value)).toEqual([1, 2, 3, 4]);
    // IndexedDB 中不应有内联记录
    expect(await kv.get('measurements', 'meas_char_1.json')).toBeNull();
  });

  it('OPFS 写入失败 → 降级内联 IndexedDB', async () => {
    const failingFs = new MemoryFileStore();
    failingFs.writeText = async () => {
      throw new Error('OPFS 不可写');
    };
    const r = new IdbRepository({ keyValue: kv, fileStore: failingFs });
    await r.writeMeasurements('ref_inline', makeMeasurements('char_1', [9, 8, 7]));
    // 内联记录存在
    const rec = await kv.get<{ values: number[] }>('measurements', 'ref_inline');
    expect(rec).not.toBeNull();
    expect(rec!.values).toEqual([9, 8, 7]);
    expect((await r.readMeasurements('ref_inline')).map((m) => m.value)).toEqual([9, 8, 7]);
  });

  it('无 FileStore → 全部内联且可读回', async () => {
    const r = new IdbRepository({ keyValue: kv });
    await r.writeMeasurements('ref2', makeMeasurements('char_1', [5, 6]));
    const rec = await kv.get<{ values: number[] }>('measurements', 'ref2');
    expect(rec!.values).toEqual([5, 6]);
  });

  it('deleteProject 清理大数组', async () => {
    await repo.saveProject(makeProject());
    await repo.writeMeasurements('meas_char_1.json', makeMeasurements('char_1', [1, 2]));
    await repo.deleteProject('proj_1');
    expect(await repo.getProject('proj_1')).toBeNull();
    expect(await fs.exists('meas_char_1.json')).toBe(false);
  });

  it('duplicateProject 迁移测量值到新 ref', async () => {
    await repo.saveProject(makeProject());
    await repo.writeMeasurements('meas_char_1.json', makeMeasurements('char_1', [1, 2, 3]));
    const copy = await repo.duplicateProject('proj_1', '副本');
    const newRef = copy.datasets[0].characteristics[0].measurementBlobRef!;
    expect(newRef).not.toBe('meas_char_1.json');
    const values = await repo.readMeasurements(newRef);
    expect(values.map((m) => m.value)).toEqual([1, 2, 3]);
  });
});

describe('createRepository 能力探测', () => {
  it('注入内存依赖 → 非降级，返回 IdbRepository 行为可用', async () => {
    const handle = createRepository(memoryDeps());
    expect(handle.degraded).toBe(false);
    await handle.repository.saveProject(makeProject());
    expect((await handle.repository.listProjects()).length).toBe(1);
  });

  it('无键值存储能力 → 降级为 MemoryRepository', async () => {
    const handle = createRepository({
      probe: () => ({ hasKeyValue: false, hasFileStore: false }),
      createKeyValue: () => new MemoryKeyValueStore(),
      createFileStore: () => null,
    });
    expect(handle.degraded).toBe(true);
    await handle.repository.saveProject(makeProject());
    expect((await handle.repository.getProject('proj_1'))!.name).toBe('测试项目');
  });
});
