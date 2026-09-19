// @vitest-environment jsdom
/**
 * 全面诊断结果持久化回归测试（永久）—— 第五轮 P0 修复 #12。
 *
 * 用户原话：「诊断结果持久化（**不要 useState**）」。
 *
 * 本文件按「接线类缺陷」方法论验证三件事：
 * 1. store 动作语义（写入 / 清除）；
 * 2. 注入式 hydrate / persist 真的读写了持久层；
 * 3. 端到端：写入 → 落盘 → **重开模块**（内存归零）→ bootstrap 还原；
 *    且 `clearFullDiagnosis` 会落盘「已清空」，刷新后旧报告不复活。
 *
 * 证伪立场：
 * - 若 `bootstrapDiagnosis` 去掉订阅或 hydrate → 第 3 组变红；
 * - 若清除时不落盘（只改内存）→ 「清除后重开不复活」用例变红；
 * - 若把结果放回组件 state（本文件的替代路径）→ 用例 3.1 的跨模块断言无法通过。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIAGNOSIS_STORAGE_KEY,
  hydrateDiagnosis,
  persistDiagnosis,
  useDiagnosisStore,
  type DiagnosisPersistence,
} from '@/store/diagnosisStore';
import {
  buildFullDiagnosisRecord,
  type FullDiagnosisRecord,
} from '@/services/ai/diagnosisReport';

function makeRecord(overrides: Partial<FullDiagnosisRecord> = {}): FullDiagnosisRecord {
  return {
    ...buildFullDiagnosisRecord('## 一、总体结论\n过程整体受控。', {
      model: 'deepseek-chat',
      scope: 'summary',
      sentFields: ['projectName'],
      projectName: '质量日报',
      characteristicCount: 3,
    }),
    ...overrides,
  };
}

describe('diagnosisStore 动作', () => {
  beforeEach(() => {
    useDiagnosisStore.getState().clearFullDiagnosis();
  });

  it('setFullDiagnosis 写入结果，clearFullDiagnosis 清空', () => {
    const rec = makeRecord();
    useDiagnosisStore.getState().setFullDiagnosis(rec);
    expect(useDiagnosisStore.getState().fullDiagnosis?.content).toContain('过程整体受控');

    useDiagnosisStore.getState().clearFullDiagnosis();
    expect(useDiagnosisStore.getState().fullDiagnosis).toBeNull();
  });
});

describe('诊断持久化注入接口', () => {
  beforeEach(() => {
    useDiagnosisStore.getState().clearFullDiagnosis();
  });

  it('persistDiagnosis 把当前结果写入注入的持久层', () => {
    const save = vi.fn();
    const persistence: DiagnosisPersistence = { load: () => null, save };
    const rec = makeRecord({ content: '# 已保存报告' });
    useDiagnosisStore.getState().setFullDiagnosis(rec);

    persistDiagnosis(persistence);

    expect(save).toHaveBeenCalledTimes(1);
    expect((save.mock.calls[0][0] as FullDiagnosisRecord).content).toBe('# 已保存报告');
  });

  it('清除后 persistDiagnosis 写入 null（把「已清空」这一事实也落盘）', () => {
    const save = vi.fn();
    const persistence: DiagnosisPersistence = { load: () => null, save };
    useDiagnosisStore.getState().setFullDiagnosis(makeRecord());

    useDiagnosisStore.getState().clearFullDiagnosis();
    persistDiagnosis(persistence);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toBeNull();
  });

  it('hydrateDiagnosis 从注入的持久层读回结果', () => {
    const persistence: DiagnosisPersistence = {
      load: () => makeRecord({ content: '# 上次的报告' }),
      save: () => undefined,
    };

    hydrateDiagnosis(persistence);

    expect(useDiagnosisStore.getState().fullDiagnosis?.content).toBe('# 上次的报告');
  });

  it('hydrateDiagnosis 遇到 null（持久层无记录）时保持原状，不抛异常', () => {
    const persistence: DiagnosisPersistence = { load: () => null, save: () => undefined };
    expect(() => hydrateDiagnosis(persistence)).not.toThrow();
    expect(useDiagnosisStore.getState().fullDiagnosis).toBeNull();
  });
});

describe('诊断结果端到端持久化（bootstrapDiagnosis）', () => {
  beforeEach(() => {
    localStorage.clear();
    useDiagnosisStore.getState().clearFullDiagnosis();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  async function coldStart(): Promise<{
    store: typeof import('@/store/diagnosisStore');
    boot: typeof import('@/ui/bootstrap/settingsBootstrap');
  }> {
    const store = await import('@/store/diagnosisStore');
    const boot = await import('@/ui/bootstrap/settingsBootstrap');
    return { store, boot };
  }

  it('写入即落盘：setFullDiagnosis 后 localStorage 出现报告（而非只改内存）', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapDiagnosis();

    store.useDiagnosisStore.getState().setFullDiagnosis(makeRecord({ content: '# 落盘验证' }));

    const raw = localStorage.getItem(DIAGNOSIS_STORAGE_KEY);
    expect(raw, '诊断结果必须已落盘').not.toBeNull();
    expect((JSON.parse(raw as string) as FullDiagnosisRecord).content).toBe('# 落盘验证');
  });

  it('写入 → 落盘 → 重开模块（内存归零）→ bootstrap 还原（刷新不丢）', async () => {
    // —— 会话 1 ——
    const s1 = await coldStart();
    s1.boot.bootstrapDiagnosis();
    s1.store.useDiagnosisStore.getState().setFullDiagnosis(
      makeRecord({ content: '# 刷新前生成的报告', model: 'qwen3-max' }),
    );
    expect(localStorage.getItem(DIAGNOSIS_STORAGE_KEY)).not.toBeNull();

    // —— 会话 2：全新模块实例，内存为 null ——
    vi.resetModules();
    const s2 = await coldStart();
    expect(s2.store.useDiagnosisStore.getState().fullDiagnosis).toBeNull();

    s2.boot.bootstrapDiagnosis();
    // 关键：若 hydrate 未接线，此处仍为 null → 断言失败（即用户看到的「刷新就没了」）。
    expect(s2.store.useDiagnosisStore.getState().fullDiagnosis?.content).toBe('# 刷新前生成的报告');
    expect(s2.store.useDiagnosisStore.getState().fullDiagnosis?.model).toBe('qwen3-max');
  });

  it('清除 → 落盘「已清空」→ 重开模块后旧报告不复活', async () => {
    const s1 = await coldStart();
    s1.boot.bootstrapDiagnosis();
    s1.store.useDiagnosisStore.getState().setFullDiagnosis(makeRecord({ content: '# 将被清除' }));
    s1.store.useDiagnosisStore.getState().clearFullDiagnosis();

    vi.resetModules();
    const s2 = await coldStart();
    s2.boot.bootstrapDiagnosis();

    expect(s2.store.useDiagnosisStore.getState().fullDiagnosis).toBeNull();
  });

  it('持久化内容损坏（正文缺失）→ bootstrap 视为无记录而非白屏', async () => {
    localStorage.setItem(DIAGNOSIS_STORAGE_KEY, JSON.stringify({ id: 'x', model: 'm' }));

    const { store, boot } = await coldStart();
    expect(() => boot.bootstrapDiagnosis()).not.toThrow();
    expect(store.useDiagnosisStore.getState().fullDiagnosis).toBeNull();
  });

  it('幂等：重复 bootstrap 不抛错，且已有结果不被冲掉', async () => {
    const s1 = await coldStart();
    s1.boot.bootstrapDiagnosis();
    s1.store.useDiagnosisStore.getState().setFullDiagnosis(makeRecord({ content: '# 幂等验证' }));

    vi.resetModules();
    const s2 = await coldStart();
    s2.boot.bootstrapDiagnosis();
    s2.boot.bootstrapDiagnosis();

    expect(s2.store.useDiagnosisStore.getState().fullDiagnosis?.content).toBe('# 幂等验证');
  });
});