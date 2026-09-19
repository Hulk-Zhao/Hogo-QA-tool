// @vitest-environment jsdom
/**
 * settingsBootstrap 回归测试（永久）——AI 配置持久化**接线**验证。
 *
 * 背景：本轮缺陷根因是「代码写好但从未接线」——`hydrateAiConfig` /
 * `persistAiConfig` 全库零调用点。此处通过**真实 localStorage** 端到端
 * 断言，证明接线确实存在，而非仅内存里改了个值。
 *
 * 证伪立场（关键）：若 `bootstrapAiSettings` 退化为空实现（不落盘 / 不读取），
 * 下列断言必须失败：
 *   - 变更后 localStorage 无内容 → 落盘断言失败；
 *   - 重开模块后 hydrate 未还原 → 读取断言失败。
 *
 * 注：使用 `vi.resetModules()` + 动态 import 模拟「整页重载」——获得全新的
 * store / bootstrap 模块实例（内存归零），但共享同一份 jsdom localStorage。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from '@/store/settingsStore';

const STORAGE_KEY = 'hogo-qa-settings';

const DEFAULT_CONFIG: AiConfig = {
  baseUrl: '',
  apiKey: '',
  model: '',
  maxTokens: 4096,
  disableThinking: true,
  allowRawData: false,
};

const SAVED_CONFIG: AiConfig = {
  baseUrl: 'https://persist.example/v1',
  apiKey: 'sk-persist-secret',
  model: 'gpt-persist',
  maxTokens: 8192,
  disableThinking: false,
  allowRawData: true,
};

/** 取回一套全新的模块实例（模拟一次「冷启动」）。 */
async function coldStart(): Promise<{
  store: typeof import('@/store/settingsStore');
  boot: typeof import('@/ui/bootstrap/settingsBootstrap');
}> {
  const store = await import('@/store/settingsStore');
  const boot = await import('@/ui/bootstrap/settingsBootstrap');
  return { store, boot };
}

describe('AI 配置持久化接线（settingsBootstrap）', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('变更即落盘：setAiConfig 后 localStorage 出现该配置（而非只改内存）', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapAiSettings();

    store.useSettingsStore.getState().setAiConfig(SAVED_CONFIG);

    // 关键：数据必须真的经过持久层落到 localStorage。
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw, '配置变更后必须已写入 localStorage').not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual(SAVED_CONFIG);
  });

  it('写入 → 落盘 → 重开模块（内存归零）→ bootstrap 还原（端到端往返）', async () => {
    // —— 会话 1：写入配置 ——
    const s1 = await coldStart();
    s1.boot.bootstrapAiSettings();
    s1.store.useSettingsStore.getState().setAiConfig(SAVED_CONFIG);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    // —— 会话 2：全新模块实例（内存默认值），同一 localStorage ——
    vi.resetModules();
    const s2 = await coldStart();
    // 反向对照：新实例内存确实是默认值（证明还原来自持久层而非残留内存）。
    expect(s2.store.useSettingsStore.getState().aiConfig).toEqual(DEFAULT_CONFIG);

    s2.boot.bootstrapAiSettings();
    // 关键：若 hydrate 未接线，此处仍为默认值 → 断言失败。
    expect(s2.store.useSettingsStore.getState().aiConfig).toEqual(SAVED_CONFIG);
  });

  it('启动即读取：预置 localStorage → bootstrap 后 store 还原（hydrate 接线独立验证）', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVED_CONFIG));

    const { store, boot } = await coldStart();
    expect(store.useSettingsStore.getState().aiConfig).toEqual(DEFAULT_CONFIG);

    boot.bootstrapAiSettings();

    expect(store.useSettingsStore.getState().aiConfig).toEqual(SAVED_CONFIG);
  });

  it('幂等：重复 bootstrap 不抛错，且已有配置不被冲回默认', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(SAVED_CONFIG));

    const { store, boot } = await coldStart();
    boot.bootstrapAiSettings();
    boot.bootstrapAiSettings();

    expect(store.useSettingsStore.getState().aiConfig).toEqual(SAVED_CONFIG);
  });

  it('maxTokens 变更 → 落盘 → 重开模块 hydrate 还原（本轮新增字段端到端往返）', async () => {
    // —— 会话 1：把 maxTokens 改为 8192 并落盘 ——
    const s1 = await coldStart();
    s1.boot.bootstrapAiSettings();
    s1.store.useSettingsStore.getState().setAiConfig({ ...SAVED_CONFIG, maxTokens: 8192 });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw, 'maxTokens 变更后必须已落盘').not.toBeNull();
    // 副作用断言：落盘内容里确实带上了 maxTokens 的真实数值。
    expect((JSON.parse(raw as string) as AiConfig).maxTokens).toBe(8192);

    // —— 会话 2：全新模块实例，仅靠持久层还原 ——
    vi.resetModules();
    const s2 = await coldStart();
    expect(s2.store.useSettingsStore.getState().aiConfig.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);

    s2.boot.bootstrapAiSettings();
    expect(s2.store.useSettingsStore.getState().aiConfig.maxTokens).toBe(8192);
  });

  it('启动读取脏 maxTokens（字符串）→ bootstrap 后回落默认 4096（sanitize 已接入 load）', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...SAVED_CONFIG, maxTokens: 'oops' }),
    );

    const { store, boot } = await coldStart();
    boot.bootstrapAiSettings();

    // 若 load 未接 sanitize（例如直接把字符串塞进 store），此处会得到 'oops' → 断言失败。
    expect(store.useSettingsStore.getState().aiConfig.maxTokens).toBe(DEFAULT_CONFIG.maxTokens);
    expect(store.useSettingsStore.getState().aiConfig.baseUrl).toBe(SAVED_CONFIG.baseUrl);
  });
});
