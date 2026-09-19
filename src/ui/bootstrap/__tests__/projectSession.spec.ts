// @vitest-environment jsdom
/**
 * projectSession 回归测试（永久）—— 本轮 P1-A「刷新后项目数据不自恢复」。
 *
 * 背景缺陷（用户可见）：`bootstrapSettings()` 只恢复 AI 配置 / 偏好 / 诊断，
 * **不恢复上次打开的项目**。于是「导入 → 保存 → F5 刷新」后 `dataset` 为空，
 * 报表页显示「尚无可导出的数据」——数据在库里，但用户看到的是空。
 *
 * 证伪立场（破坏实现必须变红）：
 * - 若 `restoreLastProject` 不调用 `setProject`，第 3 组「真的恢复了数据集」变红；
 * - 若恢复路径不再检查 `project === null`，「用户手动载入优先」用例变红；
 * - 若目标项目缺失时不清记录，「已删除项目要自愈」用例变红。
 *
 * 全部用例使用注入的 `MemoryRepository`，不触碰 IndexedDB。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRepository } from '@/data/repositories/memoryRepository';
import type { ProjectRepository } from '@/data/repositories/types';
import { CURRENT_SCHEMA_VERSION, type Project } from '@/data/schema';
import { useProjectStore } from '@/store/projectStore';
import {
  LAST_PROJECT_STORAGE_KEY,
  bootstrapProjectSession,
  forgetLastProject,
  rememberLastProject,
  restoreLastProject,
  sanitizeLastProject,
} from '@/ui/bootstrap/projectSession';

/** 构造一个带真实测量值的项目（用于断言「数据确实回来了」）。 */
function makeProject(id: string, name: string, values: number[]): Project {
  return {
    id,
    name,
    description: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [
      {
        id: id + '_ds',
        projectId: id,
        name: '尺寸数据',
        sourceType: 'xlsx',
        importedAt: '2026-09-01T00:00:00.000Z',
        rawFileName: 'f.xlsx',
        characteristics: [
          {
            id: id + '_c1',
            datasetId: id + '_ds',
            name: '外壳长度',
            specLimits: { usl: 10, lsl: 9, target: 9.5, unit: 'mm' },
            measurements: values.map((v, i) => ({
              id: id + '_m' + String(i),
              characteristicId: id + '_c1',
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

/** 复位 store 与 localStorage（本文件共享模块级单例）。 */
function resetAll(): void {
  localStorage.clear();
  useProjectStore.setState({
    project: null,
    projectName: '未命名项目',
    dataset: null,
    selectedCharacteristicId: null,
    aiUsageLogs: [],
  });
}

describe('sanitizeLastProject —— 脏数据容错', () => {
  it('非对象 / projectId 缺失 → null（视为无记录，不抛）', () => {
    for (const dirty of [null, undefined, 'x', 42, [], {}, { projectId: '' }, { projectId: 7 }]) {
      expect(sanitizeLastProject(dirty)).toBeNull();
    }
  });

  it('合法记录保留 projectId；openedAt 缺失回落空串', () => {
    expect(sanitizeLastProject({ projectId: 'p1', openedAt: '2026-09-19T00:00:00.000Z' })).toEqual({
      projectId: 'p1',
      openedAt: '2026-09-19T00:00:00.000Z',
    });
    expect(sanitizeLastProject({ projectId: 'p1' })).toEqual({ projectId: 'p1', openedAt: '' });
  });
});

describe('rememberLastProject / forgetLastProject', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('记住后落在 hogo-qa-last-project（跨会话可读）', () => {
    rememberLastProject('proj-a');
    const raw = localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).projectId).toBe('proj-a');
  });

  it('forgetLastProject(id) 只清除匹配的 id（不误删别的恢复目标）', () => {
    rememberLastProject('proj-a');
    forgetLastProject('proj-b');
    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).not.toBeNull();

    forgetLastProject('proj-a');
    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('forgetLastProject() 无条件清除', () => {
    rememberLastProject('proj-a');
    forgetLastProject();
    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
  });
});

describe('restoreLastProject —— 启动自动恢复（P1-A 核心）', () => {
  let repo: MemoryRepository;

  beforeEach(() => {
    resetAll();
    repo = new MemoryRepository();
  });

  afterEach(resetAll);

  it('记录 + 库中存在 → 恢复项目、数据集与测量值（不是只恢复 id）', async () => {
    await repo.saveProject(makeProject('proj-a', '外壳长度分析', [9.8, 9.9, 10.1]));
    rememberLastProject('proj-a');
    expect(useProjectStore.getState().dataset).toBeNull();

    const restored = await restoreLastProject({ repository: repo });

    expect(restored).toBe(true);
    const state = useProjectStore.getState();
    expect(state.project?.id).toBe('proj-a');
    // 关键副作用：报表 / 控制图依赖的真实数据必须回来了（否则仍是空态）。
    expect(state.dataset?.characteristics[0]?.name).toBe('外壳长度');
    expect(state.dataset?.characteristics[0]?.measurements.map((m) => m.value)).toEqual([
      9.8, 9.9, 10.1,
    ]);
    expect(state.selectedCharacteristicId).toBe('proj-a_c1');
  });

  it('无记录 → 不做任何事（返回 false，不改 store）', async () => {
    await repo.saveProject(makeProject('proj-a', 'X', [1]));
    expect(await restoreLastProject({ repository: repo })).toBe(false);
    expect(useProjectStore.getState().project).toBeNull();
  });

  it('目标项目已不存在 → 返回 false、不抛错，并自愈清除记录（避免每次启动空跑）', async () => {
    rememberLastProject('proj-gone');
    expect(await restoreLastProject({ repository: repo })).toBe(false);
    expect(useProjectStore.getState().project).toBeNull();
    expect(localStorage.getItem(LAST_PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('用户已手动载入项目 → 自动恢复让位（绝不覆盖用户当前操作）', async () => {
    await repo.saveProject(makeProject('stale', '恢复目标', [1, 2]));
    rememberLastProject('stale');
    const manual = makeProject('manual', '用户手动打开', [3, 4]);
    useProjectStore.getState().setProject(manual);

    expect(await restoreLastProject({ repository: repo })).toBe(false);
    expect(useProjectStore.getState().project?.id).toBe('manual');
  });

  it('恢复进行中用户手动载入项目 → 自动恢复让位（异步竞态守卫）', async () => {
    const deferred: { resolve: (p: Project | null) => void } = { resolve: () => undefined };
    const pending = new Promise<Project | null>((resolve) => {
      deferred.resolve = resolve;
    });
    const slowRepo = {
      getProject: () => pending,
    } as unknown as ProjectRepository;
    rememberLastProject('stale');

    const restoring = restoreLastProject({ repository: slowRepo });
    // 恢复仍在等待仓库返回时，用户已经手动打开了项目。
    useProjectStore.getState().setProject(makeProject('manual', '用户手动打开', [3, 4]));
    deferred.resolve(makeProject('stale', '恢复目标', [1, 2]));

    // 若缺少「await 之后重新检查」的守卫，这里会被恢复结果覆盖成 stale → 变红。
    expect(await restoring).toBe(false);
    expect(useProjectStore.getState().project?.id).toBe('manual');
    expect(useProjectStore.getState().dataset?.characteristics[0]?.measurements.length).toBe(2);
  });

  it('仓库抛错（离线 / IndexedDB 不可用）→ 静默降级，不抛异常', async () => {
    rememberLastProject('proj-a');
    const broken = {
      getProject: () => {
        throw new Error('IndexedDB 不可用');
      },
    } as unknown as ProjectRepository;

    await expect(restoreLastProject({ repository: broken })).resolves.toBe(false);
    expect(useProjectStore.getState().project).toBeNull();
  });

  it('bootstrapProjectSession 只负责触发（异步、不抛）', () => {
    rememberLastProject('nonexistent');
    expect(() => bootstrapProjectSession({ repository: repo })).not.toThrow();
  });
});
