// @vitest-environment jsdom
/**
 * AI 配置脏数据容错回归测试（永久）。
 *
 * 出处：`JsonStore.load` 的容错契约（`src/data/storage/adapters.ts`）：
 * 键缺失 / 非法 JSON / 结构非法一律返回 null 或回落默认，**不得抛异常**
 * —— 否则损坏的 localStorage 内容会在启动 hydrate 时导致白屏。
 *
 * 覆盖点：真正的持久层实现 `LocalStorageJsonStore`（读取真实 localStorage）
 * 与纯函数 `sanitizeAiConfig` 的组合行为，逐类脏数据独立断言。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { LocalStorageJsonStore } from '@/data/storage/browserAdapters';
import { DEFAULT_AI_CONFIG, sanitizeAiConfig, type AiConfig } from '@/store/settingsStore';

const STORAGE_KEY = 'hogo-qa-settings';

/** 每次读盘都新建实例，避免相互影响。 */
function newStore(): LocalStorageJsonStore<AiConfig> {
  return new LocalStorageJsonStore<AiConfig>(STORAGE_KEY, sanitizeAiConfig);
}

/**
 * 构造原始 localStorage 内容并 load。
 *
 * @param rawValue 写入键的原始字符串
 * @returns load 结果
 */
function loadRaw(rawValue: string): AiConfig | null {
  localStorage.setItem(STORAGE_KEY, rawValue);
  return newStore().load();
}

describe('LocalStorageJsonStore + sanitizeAiConfig 脏数据容错', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('键缺失 → 返回 null（不等于默认值，调用方自行回落）', () => {
    expect(newStore().load()).toBeNull();
  });

  it('非法 JSON → 返回 null 且不抛异常', () => {
    expect(() => loadRaw('{ not valid json')).not.toThrow();
    expect(loadRaw('{ not valid json')).toBeNull();
  });

  it.each([
    ['字符串字面量', '"abc"'],
    ['数字', '123'],
    ['布尔', 'true'],
    ['null', 'null'],
    ['数组', '[]'],
  ])('非对象（%s）→ 返回 null 且不抛异常', (_label, rawValue) => {
    expect(() => loadRaw(rawValue)).not.toThrow();
    expect(loadRaw(rawValue)).toBeNull();
  });

  it('空对象 {} → 全字段回落默认', () => {
    expect(loadRaw('{}')).toEqual(DEFAULT_AI_CONFIG);
  });

  it('缺字段 → 缺失字段回落默认，已填合法字段保留', () => {
    const result = loadRaw(JSON.stringify({ model: 'gpt-4o' }));
    expect(result).toEqual({ ...DEFAULT_AI_CONFIG, model: 'gpt-4o' });
  });

  it('类型不符 → 逐字段回落默认（baseUrl=123 / apiKey=null / allowRawData="yes"）', () => {
    const result = loadRaw(
      JSON.stringify({ baseUrl: 123, apiKey: null, model: 'm', allowRawData: 'yes' }),
    );
    expect(result).toEqual({
      baseUrl: '',
      apiKey: '',
      model: 'm',
      maxTokens: DEFAULT_AI_CONFIG.maxTokens,
      disableThinking: DEFAULT_AI_CONFIG.disableThinking,
      allowRawData: false,
    });
  });

  it('嵌套/额外字段不污染结果（只产出合法 AiConfig）', () => {
    const result = loadRaw(
      JSON.stringify({ baseUrl: 'https://x/v1', __proto__hack: { evil: true }, extra: 1 }),
    );
    expect(result).toEqual({ ...DEFAULT_AI_CONFIG, baseUrl: 'https://x/v1' });
  });

  it('完整合法配置 → 原样还原', () => {
    const valid: AiConfig = {
      baseUrl: 'https://ok/v1',
      apiKey: 'sk-ok',
      model: 'gpt-ok',
      maxTokens: 8192,
      disableThinking: false,
      allowRawData: true,
    };
    expect(loadRaw(JSON.stringify(valid))).toEqual(valid);
  });
});

describe('sanitizeAiConfig 纯函数（非对象输入必须返回 null）', () => {
  const NON_OBJECTS: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['字符串', 'abc'],
    ['数组', []],
    ['数字', 7],
  ];

  it.each(NON_OBJECTS)('%s → null', (_label, input) => {
    expect(() => sanitizeAiConfig(input)).not.toThrow();
    expect(sanitizeAiConfig(input)).toBeNull();
  });

  it('合法对象 → 归一化结果', () => {
    expect(sanitizeAiConfig({ baseUrl: 'u', apiKey: 'k', model: 'm', allowRawData: true })).toEqual({
      baseUrl: 'u',
      apiKey: 'k',
      model: 'm',
      maxTokens: DEFAULT_AI_CONFIG.maxTokens,
      disableThinking: DEFAULT_AI_CONFIG.disableThinking,
      allowRawData: true,
    });
  });
});
