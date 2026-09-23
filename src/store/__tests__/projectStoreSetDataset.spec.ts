/**
 * projectStore.setDataset —— 「每次导入 = 一个新项目」回归测试（本轮 P0 修复）。
 *
 * 背景：导入路径此前复用同一个项目 id（全部硬编码为常量 'local'），
 * 因此第二次导入会**静默覆盖**第一个项目 —— 「项目库」永远只可能有 1 条记录，
 * 用户看到的就是「项目库不存在任何数据」（见记忆第二十一节）。
 *
 * 证伪立场：把 `setDataset` 里的 `generateId('proj')` 改回常量，本文件必须变红。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useProjectStore } from '@/store/projectStore';
import type { Dataset } from '@/data/schema';

/** 造一个最小可用数据集（1 特性 × 2 测量值）。 */
function makeDataset(id: string, name: string): Dataset {
  return {
    id,
    projectId: 'stale-project-id',
    name,
    sourceType: 'csv',
    importedAt: '2026-09-23T00:00:00.000Z',
    rawFileName: `${name}.csv`,
    characteristics: [
      {
        id: `${id}-c1`,
        datasetId: id,
        name: '外壳长度',
        specLimits: { usl: 10, lsl: 9, target: 9.5, unit: 'mm' },
        measurements: [9.8, 9.9].map((v, i) => ({
          id: `${id}-m${i}`,
          characteristicId: `${id}-c1`,
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
  };
}

describe('projectStore.setDataset —— 每次导入都新建项目', () => {
  beforeEach(() => {
    useProjectStore.setState({
      project: null,
      projectName: '未命名项目',
      dataset: null,
      selectedCharacteristicId: null,
      aiUsageLogs: [],
    });
  });

  it('连续两次导入 → 两个互不覆盖的项目', () => {
    useProjectStore.getState().setDataset(makeDataset('ds-a', 'A 批尺寸'));
    const first = useProjectStore.getState().project;
    useProjectStore.getState().setDataset(makeDataset('ds-b', 'B 批尺寸'));
    const second = useProjectStore.getState().project;

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
  });

  it('新项目名取数据集名（避免项目库里堆满「未命名项目」）', () => {
    useProjectStore.getState().setDataset(makeDataset('ds-a', '外壳长度.xlsx'));

    expect(useProjectStore.getState().project?.name).toBe('外壳长度.xlsx');
    expect(useProjectStore.getState().projectName).toBe('外壳长度.xlsx');
  });

  it('数据集归属到新项目：projectId 被改写，且选中首个特性', () => {
    useProjectStore.getState().setDataset(makeDataset('ds-a', '外壳长度.xlsx'));
    const project = useProjectStore.getState().project;

    expect(project?.datasets).toHaveLength(1);
    expect(project?.datasets[0].id).toBe('ds-a');
    expect(project?.datasets[0].projectId).toBe(project?.id);
    expect(useProjectStore.getState().selectedCharacteristicId).toBe('ds-a-c1');
  });

  it('两次导入的项目实体各自只带自己的数据集（不共享引用）', () => {
    useProjectStore.getState().setDataset(makeDataset('ds-a', 'A 批尺寸'));
    const first = useProjectStore.getState().project;
    useProjectStore.getState().setDataset(makeDataset('ds-b', 'B 批尺寸'));
    const second = useProjectStore.getState().project;

    expect(first?.datasets.map((d) => d.id)).toEqual(['ds-a']);
    expect(second?.datasets.map((d) => d.id)).toEqual(['ds-b']);
  });
});
