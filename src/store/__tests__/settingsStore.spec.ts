/**
 * settingsStore 回归测试（永久）——`maxTokens` 字段的脏数据容错与持久化接线。
 *
 * 背景：本轮修复把「最大输出 tokens」从 aiClient 的硬编码 1024 提升为
 * settingsStore.AiConfig 的可持久化字段（默认 4096）。此处独立验证两件事：
 * 1. `sanitizeAiConfig` 对 maxTokens 的脏数据（缺失 / 字符串 / NaN / 0 /
 *    负数 / 非整数）一律回落默认，合法值（如 8192、超大值 100000、边界 1）保留
 *    —— **不设上限**（用户明确要求不要限制最大 TOKEN）；
 * 2. `hydrateAiConfig` / `persistAiConfig` 确实读写注入的持久层（而非
 *    只在内存改值）——针对本项目反复出现的「函数写好但从未接线」缺陷。
 *
 * 证伪立场：若把 `sanitizeMaxTokens` 改坏（例如直接 `return raw as number`
 * 或改回常量 1024），下列脏数据断言必须变红；若把 hydrate/persist 退化为
 * 空实现，往返断言必须变红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AI_CONFIG,
  MIN_MAX_TOKENS,
  hydrateAiConfig,
  persistAiConfig,
  sanitizeAiConfig,
  useSettingsStore,
  type AiConfig,
  type SettingsPersistence,
} from '@/store/settingsStore';

describe('DEFAULT_AI_CONFIG.maxTokens', () => {
  it('默认最大输出 tokens 为 4096（不再是被截断的 1024）', () => {
    expect(DEFAULT_AI_CONFIG.maxTokens).toBe(4096);
  });

  it('最小合法值常量为 1，且不设上限（无 MAX_MAX_TOKENS）', () => {
    expect(MIN_MAX_TOKENS).toBe(1);
  });
});

describe('sanitizeAiConfig：maxTokens 脏数据容错', () => {
  const BASE = { baseUrl: 'https://x/v1', apiKey: 'sk-1', model: 'm', allowRawData: false };

  it.each([
    ['字段缺失', undefined],
    ['字符串 "8192"', '8192'],
    ['字符串 "abc"', 'abc'],
    ['NaN', Number.NaN],
    ['0', 0],
    ['负数 -1', -1],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['非整数 1024.5', 1024.5],
    ['null', null],
    ['布尔 true', true],
  ])('脏数据（%s）→ 回落默认 4096，且不抛异常', (_label, dirty) => {
    expect(() => sanitizeAiConfig({ ...BASE, maxTokens: dirty })).not.toThrow();
    const result = sanitizeAiConfig({ ...BASE, maxTokens: dirty });
    expect(result?.maxTokens).toBe(DEFAULT_AI_CONFIG.maxTokens);
    // 其余合法字段不受影响。
    expect(result).toMatchObject({ baseUrl: 'https://x/v1', apiKey: 'sk-1', model: 'm' });
  });

  it.each([
    ['常规值 8192', 8192, 8192],
    ['下边界 1', 1, 1],
    ['32768（原上限，现已合法保留）', 32768, 32768],
    ['40000（原上限之上，证明不设上限）', 40000, 40000],
    ['超大值 100000', 100000, 100000],
  ])('合法值（%s）被保留', (_label, input, expected) => {
    const result = sanitizeAiConfig({ ...BASE, maxTokens: input });
    expect(result?.maxTokens).toBe(expected);
  });

  it('非对象输入仍返回 null（maxTokens 不影响原有契约）', () => {
    expect(sanitizeAiConfig(null)).toBeNull();
    expect(sanitizeAiConfig('abc')).toBeNull();
    expect(sanitizeAiConfig([])).toBeNull();
  });
});

describe('sanitizeAiConfig：disableThinking 容错', () => {
  const BASE = { baseUrl: 'https://x/v1', apiKey: 'sk-1', model: 'm', maxTokens: 4096, allowRawData: false };

  it('默认开启（true）——对不收敛的推理模型默认关闭思考', () => {
    expect(DEFAULT_AI_CONFIG.disableThinking).toBe(true);
  });

  it.each([
    ['字段缺失', undefined],
    ['字符串 "true"', 'true'],
    ['数字 1', 1],
    ['null', null],
  ])('脏数据（%s）→ 回落默认 true', (_label, dirty) => {
    const result = sanitizeAiConfig({ ...BASE, disableThinking: dirty });
    expect(result?.disableThinking).toBe(true);
  });

  it('显式 false 被保留（用户主动选择开启思考）', () => {
    const result = sanitizeAiConfig({ ...BASE, disableThinking: false });
    expect(result?.disableThinking).toBe(false);
  });
});

describe('hydrate / persist 接线（注入持久层）', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
  });

  it('persistAiConfig 把当前 maxTokens 写入注入的持久层', () => {
    const save = vi.fn();
    const persistence: SettingsPersistence = { load: () => null, save };
    useSettingsStore.getState().setAiConfig({ maxTokens: 12345 });

    persistAiConfig(persistence);

    // 副作用断言：持久层确实收到包含 maxTokens 的完整配置。
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0][0] as AiConfig;
    expect(saved.maxTokens).toBe(12345);
  });

  it('hydrateAiConfig 从注入的持久层读回 maxTokens', () => {
    const loaded: AiConfig = {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: '',
      model: 'qwen3.5:9b',
      maxTokens: 8192,
      disableThinking: true,
      allowRawData: false,
    };
    const persistence: SettingsPersistence = { load: () => loaded, save: vi.fn() };

    hydrateAiConfig(persistence);

    expect(useSettingsStore.getState().aiConfig).toEqual(loaded);
  });

  it('persistence 为 null 时安全 no-op（不抛异常）', () => {
    expect(() => hydrateAiConfig(null)).not.toThrow();
    expect(() => persistAiConfig(null)).not.toThrow();
  });
});
