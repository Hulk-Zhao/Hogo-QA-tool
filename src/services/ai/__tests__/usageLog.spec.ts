/**
 * usageLog 测试（架构 §8.2 第 3 条；PRD P0-24）。
 */

import { describe, expect, it } from 'vitest';
import { buildUsageEntry, USAGE_FEATURE_LABEL, USAGE_SCOPE_LABEL } from '../usageLog';

describe('buildUsageEntry', () => {
  it('记录 feature / scope / model / ok / 时间', () => {
    const entry = buildUsageEntry('chartExplain', 'summary', 'gpt-4', true);
    expect(entry.feature).toBe('chartExplain');
    expect(entry.sentPayloadScope).toBe('summary');
    expect(entry.model).toBe('gpt-4');
    expect(entry.ok).toBe(true);
    expect(entry.id).toMatch(/^ailog/);
    expect(() => new Date(entry.requestedAt)).not.toThrow();
    expect(Number.isNaN(new Date(entry.requestedAt).getTime())).toBe(false);
  });

  it('raw 范围被如实记录', () => {
    const entry = buildUsageEntry('qa', 'raw', 'x', false);
    expect(entry.sentPayloadScope).toBe('raw');
    expect(entry.ok).toBe(false);
  });
});

describe('标签表', () => {
  it('功能与范围标签完备', () => {
    expect(USAGE_FEATURE_LABEL.chartExplain).toBeTruthy();
    expect(USAGE_SCOPE_LABEL.summary).toContain('摘要');
    expect(USAGE_SCOPE_LABEL.raw).toContain('明细');
  });
});
