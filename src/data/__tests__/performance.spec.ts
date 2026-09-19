/**
 * 性能冒烟测试（架构 §9：支持 ≤20 万测量值）。
 *
 * 使用较小规模（5 万）断言流程能在合理时间内完成，**不做硬性耗时断言**
 * 以免 CI 抖动（team-lead 明确要求）。
 */

import { describe, expect, it } from 'vitest';
import { MemoryRepository } from '../repositories/memoryRepository';
import { IdbRepository } from '../repositories/idbRepository';
import { MemoryFileStore, MemoryKeyValueStore } from '../storage/memoryAdapters';
import { buildModel } from '../importer/buildModel';
import type { Measurement, Project } from '../schema';
import { CURRENT_SCHEMA_VERSION } from '../schema';

const N = 50000;

function makeProject(id: string): Project {
  return {
    id,
    name: 'perf',
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

describe('性能冒烟：大数组写入/读回', () => {
  it(`MemoryRepository 写入并读回 ${N} 条测量值`, async () => {
    const repo = new MemoryRepository();
    const project = makeProject('perf_mem');
    project.datasets.push({
      id: 'ds',
      projectId: 'perf_mem',
      name: 'ds',
      sourceType: 'json',
      importedAt: '2026-01-01T00:00:00.000Z',
      rawFileName: 'perf.json',
      characteristics: [
        {
          id: 'c1',
          datasetId: 'ds',
          name: 'perf-char',
          specLimits: { usl: 1, lsl: 0, target: null, unit: '' },
          measurements: [],
          subgroups: [],
          nullCount: 0,
          outlierFlags: [],
          preprocessConfigRef: null,
          measurementBlobRef: 'perf_ref',
        },
      ],
      defectRecords: [],
    });
    await repo.saveProject(project);

    const data: Measurement[] = new Array(N);
    for (let i = 0; i < N; i += 1) {
      data[i] = {
        id: `m${i}`,
        characteristicId: 'c1',
        value: Math.sin(i) * 0.1 + 0.5,
        subgroupId: null,
        timestamp: null,
        batch: null,
        excluded: false,
        excludeReason: null,
      };
    }
    const t0 = Date.now();
    await repo.writeMeasurements('perf_ref', data);
    const back = await repo.readMeasurements('perf_ref');
    const elapsed = Date.now() - t0;
    expect(back.length).toBe(N);
    expect(back[N - 1].value).toBeCloseTo(data[N - 1].value, 12);
    // 宽松上限：仅防病态退化，不作为性能门槛。
    expect(elapsed).toBeLessThan(30000);
  });

  it(`IdbRepository(OPFS) 写入并读回 ${N} 条测量值`, async () => {
    const repo = new IdbRepository({
      keyValue: new MemoryKeyValueStore(),
      fileStore: new MemoryFileStore(),
    });
    const data: Measurement[] = new Array(N);
    for (let i = 0; i < N; i += 1) {
      data[i] = {
        id: `m${i}`,
        characteristicId: 'c1',
        value: i * 0.001,
        subgroupId: null,
        timestamp: null,
        batch: null,
        excluded: false,
        excludeReason: null,
      };
    }
    const t0 = Date.now();
    await repo.writeMeasurements('perf_ref', data);
    const back = await repo.readMeasurements('perf_ref');
    const elapsed = Date.now() - t0;
    expect(back.length).toBe(N);
    expect(elapsed).toBeLessThan(30000);
  });
});

describe('性能冒烟：大表 buildModel', () => {
  it(`${N} 行长表构造模型`, () => {
    const rows: (string | number | null)[][] = [];
    for (let i = 0; i < N; i += 1) {
      rows.push(['外壳长度', 50 + Math.sin(i) * 0.02, 50.2, 49.8]);
    }
    const sheet = {
      sheetName: 'csv',
      header: ['物料名称', '测量值', 'USL', 'LSL'],
      rows,
      firstDataRowNumber: 2,
    };
    const t0 = Date.now();
    const built = buildModel({
      projectId: 'p',
      datasetName: 'perf',
      sourceType: 'csv',
      rawFileName: 'perf.csv',
      dimension: { sheet, mapping: { material: 0, value: 1, usl: 2, lsl: 3 } },
      defect: null,
    });
    const elapsed = Date.now() - t0;
    expect(built.totalMeasurements).toBe(N);
    expect(built.dataset.characteristics.length).toBe(1);
    expect(elapsed).toBeLessThan(30000);
  });
});
