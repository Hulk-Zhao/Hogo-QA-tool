// @vitest-environment jsdom
/**
 * AI 审计记录持久化回归测试（永久）—— 本轮 P1-B「审计随会话蒸发」。
 *
 * 背景缺陷（用户可见）：`aiUsageLogs` 只活在 `projectStore` 内存切片里，
 * 刷新后设置页「AI 使用审计」表为空（实测 reload 后为 null），
 * PRD P0-24「每次请求可审计」在跨会话场景下不可验证。
 *
 * 证伪立场（破坏实现必须变红）：
 * - 若 `bootstrapAiUsageLogs` 去掉 hydrate 或订阅，第 4 组端到端用例变红；
 * - 若 `setProject` 回到「整份替换」语义，「打开项目不丢历史」变红；
 * - 若 sanitize 不逐条丢弃脏数据 / 不截断，第 1 组变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AI_USAGE_LOG_STORAGE_KEY,
  MAX_AI_USAGE_LOGS,
  hydrateAiUsageLogs,
  mergeAiUsageLogs,
  persistAiUsageLogs,
  sanitizeAiUsageLogs,
  useProjectStore,
  type AiUsageLogPersistence,
} from '@/store/projectStore';
import { CURRENT_SCHEMA_VERSION, type Project } from '@/data/schema';
import type { AiUsageEntry } from '@/services/ai/usageLog';

/** 构造一条合法审计记录。 */
function entry(id: string, at: string, over: Partial<AiUsageEntry> = {}): AiUsageEntry {
  return {
    id,
    feature: 'qa',
    sentPayloadScope: 'summary',
    model: 'qwen3.5:9b',
    requestedAt: at,
    ok: true,
    ...over,
  };
}

/** 构造一个最小项目实体（用于 setProject 合并语义验证）。 */
function makeProject(id: string, logs: Project['aiUsageLogs']): Project {
  return {
    id,
    name: '项目 ' + id,
    description: '',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    datasets: [],
    analysisConfigs: [],
    aiUsageLogs: logs,
  };
}

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

describe('sanitizeAiUsageLogs —— 逐条容错 + 截断', () => {
  it('非数组 → null（视为无历史）', () => {
    for (const dirty of [null, undefined, 'x', {}, 42]) {
      expect(sanitizeAiUsageLogs(dirty)).toBeNull();
    }
  });

  it('脏条目被逐条丢弃，合法条目保留（不整份丢弃）', () => {
    const out = sanitizeAiUsageLogs([
      entry('ok-1', '2026-09-19T01:00:00.000Z'),
      null,
      'nope',
      { id: 'bad-1' },
      entry('bad-2', '2026-09-19T02:00:00.000Z', { sentPayloadScope: 'summary2' as never }),
      entry('ok-2', '2026-09-19T03:00:00.000Z', { ok: false }),
    ]);
    expect(out?.map((l) => l.id)).toEqual(['ok-1', 'ok-2']);
    expect(out?.[1].ok).toBe(false);
  });

  it('projectId 保真（项目内审计记录还原后仍带归属）', () => {
    const out = sanitizeAiUsageLogs([
      { ...entry('ok-1', '2026-09-19T01:00:00.000Z'), projectId: 'proj-a' },
    ]);
    expect((out?.[0] as { projectId?: string }).projectId).toBe('proj-a');
  });

  it('超上限只保留最新 ' + String(MAX_AI_USAGE_LOGS) + ' 条', () => {
    const many = Array.from({ length: MAX_AI_USAGE_LOGS + 20 }, (_, i) =>
      entry('l' + String(i), new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()),
    );
    const out = sanitizeAiUsageLogs(many);
    expect(out?.length).toBe(MAX_AI_USAGE_LOGS);
    // 丢的是最旧的（时间升序末尾为最新）。
    expect(out?.[out.length - 1].id).toBe('l' + String(MAX_AI_USAGE_LOGS + 19));
  });
});

describe('mergeAiUsageLogs —— 只增不减 + 按时间排序 + 幂等', () => {
  it('按 id 去重（后到者覆盖同 id），并按时间升序排列', () => {
    const merged = mergeAiUsageLogs(
      [entry('a', '2026-09-19T03:00:00.000Z'), entry('b', '2026-09-19T01:00:00.000Z')],
      [entry('a', '2026-09-19T03:00:00.000Z', { ok: false }), entry('c', '2026-09-19T02:00:00.000Z')],
    );
    expect(merged.map((l) => l.id)).toEqual(['b', 'c', 'a']);
    expect(merged[2].ok).toBe(false);
  });

  it('幂等：同一批记录重复合并不增长、不丢', () => {
    const logs = [entry('a', '2026-09-19T01:00:00.000Z'), entry('b', '2026-09-19T02:00:00.000Z')];
    const once = mergeAiUsageLogs([], logs);
    const twice = mergeAiUsageLogs(once, logs);
    expect(twice).toEqual(once);
  });

  it('空历史合并非空 → 原样保留（不丢证据）', () => {
    const logs = [entry('a', '2026-09-19T01:00:00.000Z')];
    expect(mergeAiUsageLogs([], logs).map((l) => l.id)).toEqual(['a']);
    expect(mergeAiUsageLogs(logs, []).map((l) => l.id)).toEqual(['a']);
  });
});

describe('store 动作：审计记录只增不减', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('appendAiUsageLog 追加到切片；无项目时也保留（不阻断 AI 请求）', () => {
    useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));
    expect(useProjectStore.getState().aiUsageLogs.map((l) => l.id)).toEqual(['a']);
    expect(useProjectStore.getState().project).toBeNull();
  });

  it('打开「审计为空」的项目不会抹掉设备已有审计（此前是整份替换 → 变红）', () => {
    useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));
    useProjectStore.getState().setProject(makeProject('proj-empty', []));
    expect(useProjectStore.getState().aiUsageLogs.map((l) => l.id)).toEqual(['a']);
  });

  it('打开带审计的项目 → 并入（并集，不重复）', () => {
    useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));
    useProjectStore
      .getState()
      .setProject(
        makeProject('proj-b', [
          { ...entry('a', '2026-09-19T01:00:00.000Z'), projectId: 'proj-b' },
          { ...entry('b', '2026-09-19T02:00:00.000Z'), projectId: 'proj-b' },
        ]),
      );
    expect(useProjectStore.getState().aiUsageLogs.map((l) => l.id)).toEqual(['a', 'b']);
  });
});

describe('hydrate / persist（注入持久层）', () => {
  beforeEach(resetAll);
  afterEach(resetAll);

  it('persistAiUsageLogs 写入注入的持久层', () => {
    const save = vi.fn();
    const persistence: AiUsageLogPersistence = { load: () => null, save };
    useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));

    persistAiUsageLogs(persistence);

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as AiUsageEntry[]).map((l) => l.id)).toEqual(['a']);
  });

  it('hydrateAiUsageLogs 与已有内存记录**合并**（不是覆盖）', () => {
    const persistence: AiUsageLogPersistence = {
      load: () => [entry('stored', '2026-09-19T01:00:00.000Z')],
      save: vi.fn(),
    };
    useProjectStore.getState().appendAiUsageLog(entry('live', '2026-09-19T02:00:00.000Z'));

    hydrateAiUsageLogs(persistence);

    expect(useProjectStore.getState().aiUsageLogs.map((l) => l.id)).toEqual(['stored', 'live']);
  });

  it('persistence 为 null 时安全 no-op', () => {
    expect(() => hydrateAiUsageLogs(null)).not.toThrow();
    expect(() => persistAiUsageLogs(null)).not.toThrow();
  });
});

describe('审计记录端到端持久化（bootstrapAiUsageLogs，真 localStorage）', () => {
  /** 取一套全新模块实例（模拟一次「冷启动」，内存归零）。 */
  async function coldStart(): Promise<{
    store: typeof import('@/store/projectStore');
    boot: typeof import('@/ui/bootstrap/projectSession');
  }> {
    const store = await import('@/store/projectStore');
    const boot = await import('@/ui/bootstrap/projectSession');
    return { store, boot };
  }

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('变更即落盘：appendAiUsageLog 后 localStorage 出现该记录', async () => {
    const s = await coldStart();
    s.boot.bootstrapAiUsageLogs();

    s.store.useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));

    const raw = localStorage.getItem(AI_USAGE_LOG_STORAGE_KEY);
    expect(raw, 'appendAiUsageLog 后必须已落盘').not.toBeNull();
    expect((JSON.parse(raw as string) as AiUsageEntry[]).map((l) => l.id)).toEqual(['a']);
  });

  it('写入 → 落盘 → 重开模块（内存归零）→ bootstrap 还原（刷新不再丢）', async () => {
    const s1 = await coldStart();
    s1.boot.bootstrapAiUsageLogs();
    s1.store.useProjectStore.getState().appendAiUsageLog(entry('a', '2026-09-19T01:00:00.000Z'));

    vi.resetModules();
    const s2 = await coldStart();
    // 反向对照：新实例内存确实是空的（证明还原来自持久层而非残留内存）。
    expect(s2.store.useProjectStore.getState().aiUsageLogs).toEqual([]);

    s2.boot.bootstrapAiUsageLogs();
    // 若 hydrate 未接线，此处仍为空 → 断言失败（即用户看到的「审计表变空」）。
    expect(s2.store.useProjectStore.getState().aiUsageLogs.map((l) => l.id)).toEqual(['a']);
  });

  it('启动读取脏数据（非数组 / 脏条目）→ 不抛错，回落空表', async () => {
    localStorage.setItem(AI_USAGE_LOG_STORAGE_KEY, JSON.stringify({ nope: true }));

    const s = await coldStart();
    s.boot.bootstrapAiUsageLogs();
    expect(s.store.useProjectStore.getState().aiUsageLogs).toEqual([]);
  });
});
