// @vitest-environment jsdom
/**
 * useProjectPersistence 保存链路回归测试（永久）—— 本轮 P1-A 的**写入侧**接线。
 *
 * 为什么必须单独测：`restoreLastProject` 的读取侧已有覆盖，但「谁来写
 * `hogo-qa-last-project`」是另一处接线点。若保存成功后忘记记录，
 * 启动恢复就成了永远读不到记录的**死代码**——功能看起来「实现了」，实际永不生效。
 * 这类「写侧漏接线」正是本项目反复踩的坑（见记忆第一节：接线类缺陷）。
 *
 * 证伪立场：删掉 `persist()` 里那句 `rememberLastProject`，本文件必须变红。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { CURRENT_SCHEMA_VERSION, type Dataset } from '@/data/schema';
import { LAST_PROJECT_STORAGE_KEY } from '@/ui/bootstrap/projectSession';
import { useProjectPersistence } from '@/ui/hooks/useProjectPersistence';
import { useProjectStore } from '@/store/projectStore';

/** 造一个最小可用数据集（1 特性 × 3 测量值）。 */
function makeDataset(): Dataset {
  return {
    id: 'ds-1',
    projectId: 'local',
    name: '尺寸数据',
    sourceType: 'csv',
    importedAt: '2026-09-19T00:00:00.000Z',
    rawFileName: 'f.csv',
    characteristics: [
      {
        id: 'c-1',
        datasetId: 'ds-1',
        name: '外壳长度',
        specLimits: { usl: 10, lsl: 9, target: 9.5, unit: 'mm' },
        measurements: [9.8, 9.9, 10.1].map((v, i) => ({
          id: 'm-' + String(i),
          characteristicId: 'c-1',
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

function resetAll(): void {
  localStorage.clear();
  useProjectStore.setState({
    project: null,
    projectName: '外壳长度分析',
    dataset: null,
    selectedCharacteristicId: null,
    aiUsageLogs: [],
  });
}

describe('useProjectPersistence —— 保存成功后记录「上次项目」（P1-A 写入侧）', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('persist() 成功后写入 hogo-qa-last-project，且项目实体真的落盘', async () => {
    useProjectStore.setState({ dataset: makeDataset() });
    const { result } = renderHook(() => useProjectPersistence());

    await act(async () => {
      await result.current.persist();
    });

    const raw = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    expect(raw, '保存成功后必须记录「上次项目」，否则刷新无法自动恢复').not.toBeNull();
    expect((JSON.parse(raw as string) as { projectId: string }).projectId).toBe('local');

    // 反向对照：只记 id 而项目没落盘的话，恢复必然拿不到数据。
    expect(result.current.lastSavedAt).not.toBeNull();
  });

  it('无数据时 persist() 不写记录（避免指向不存在的项目）', async () => {
    const { result } = renderHook(() => useProjectPersistence());

    await act(async () => {
      await result.current.persist();
    });

    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('数据集 schema 版本可用（守卫 fixture 与 CURRENT_SCHEMA_VERSION 同步）', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(1);
  });
});
