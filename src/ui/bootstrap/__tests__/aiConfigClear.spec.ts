// @vitest-environment jsdom
/**
 * 「清除已保存的 AI 配置」回归测试（永久）—— 本轮 P1-D。
 *
 * 风险出处：`file://` 形态下 localStorage 是唯一可用后端，API Key 只能以
 * **明文**存放（设置页已有提示）。此前没有一键擦除入口，用户想把密钥从本机
 * 抹掉只能手改字段（JSON 键仍在）。本组用例锁住「真的删掉整个键」这一语义。
 *
 * 证伪立场（破坏实现必须变红）：
 * - 若 `clearSavedAiConfig` 只做 `save(DEFAULT)` 而不删除键 → 第 1 条变红；
 * - 若内部顺序写反（先清后复位）→ 订阅会把键**复活**，第 2 条变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'hogo-qa-settings';

const SAVED_CONFIG = {
  baseUrl: 'https://persist.example/v1',
  apiKey: 'sk-plain-secret',
  model: 'gpt-persist',
  maxTokens: 8192,
  disableThinking: false,
  allowRawData: true,
};

/** 取一套全新模块实例（模拟一次「冷启动」）。 */
async function coldStart(): Promise<{
  store: typeof import('@/store/settingsStore');
  boot: typeof import('@/ui/bootstrap/settingsBootstrap');
}> {
  const store = await import('@/store/settingsStore');
  const boot = await import('@/ui/bootstrap/settingsBootstrap');
  return { store, boot };
}

describe('清除已保存的 AI 配置', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  afterEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it('clearSavedAiConfig 删除整个 localStorage 键（密钥不留痕）并复位内存配置', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapAiSettings();
    store.useSettingsStore.getState().setAiConfig(SAVED_CONFIG);
    expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    const ok = boot.clearSavedAiConfig();

    expect(ok).toBe(true);
    // 关键：键被删除，而不是「字段写空但 JSON 仍在」。
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(store.useSettingsStore.getState().aiConfig.apiKey).toBe('');
    expect(store.useSettingsStore.getState().aiConfig.baseUrl).toBe('');
    expect(store.useSettingsStore.getState().mode).toBe('offline');
  });

  it('顺序正确：清除后订阅不会把配置「复活」（先复位再删键）', async () => {
    const { store, boot } = await coldStart();
    boot.bootstrapAiSettings();
    store.useSettingsStore.getState().setAiConfig(SAVED_CONFIG);

    boot.clearSavedAiConfig();
    // 清完再触发一次无关变更，键仍不应带着旧密钥出现。
    store.useSettingsStore.getState().setAiConfig({ maxTokens: 2048 });

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect((JSON.parse(raw as string) as { apiKey: string }).apiKey).toBe('');
    expect(raw).not.toContain('sk-plain-secret');
  });

  it('重复清除是安全幂等的（键始终不存在）', async () => {
    const { boot } = await coldStart();
    boot.bootstrapAiSettings();

    expect(boot.clearSavedAiConfig()).toBe(true);
    expect(boot.clearSavedAiConfig()).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});
