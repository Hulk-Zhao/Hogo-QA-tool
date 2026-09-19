/**
 * payloadBuilder 测试（架构 §8.2；T05 验收要点 4）。
 *
 * 核心验证：白名单复制 → 默认 scope=summary；仅显式允许 + 传入 rawData 才 scope=raw。
 * 「不误发明细」是数据主权的技术保障，本测试为 QA 独立验证基線。
 */

import { describe, expect, it } from 'vitest';
import {
  buildMessages,
  buildPayload,
  pickKnownSummaryFields,
  summaryWhitelist,
} from '../payloadBuilder';

/** 一个「含明细」的摘要（模拟误传，验证白名单会剔除它）。 */
const summaryWithLeak = {
  characteristicName: '外壳长度',
  chartType: 'xbar-r',
  centerLine: 50.05,
  ucl: 50.2,
  lcl: 49.9,
  sigma: 0.05,
  violations: [{ ruleId: 'W1', message: '1点超3σ', windowStart: 3 }],
  capability: { cp: 1.5, cpk: 1.3, pp: 1.4, ppk: 1.2 },
  // 以下字段不在白名单，绝不应被携带：
  measurements: [50.1, 50.2, 49.8],
  secretInternalField: 'should-not-leak',
};

describe('pickKnownSummaryFields', () => {
  it('只复制白名单字段，未知字段（含 measurements）被剔除', () => {
    const safe = pickKnownSummaryFields(summaryWithLeak);
    expect(safe.characteristicName).toBe('外壳长度');
    expect(safe.centerLine).toBe(50.05);
    expect(Object.prototype.hasOwnProperty.call(safe, 'measurements')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(safe, 'secretInternalField')).toBe(false);
  });

  it('NaN / Infinity 数字被归一化为 null', () => {
    const safe = pickKnownSummaryFields({ mean: Number.NaN, n: 50, ucl: Number.POSITIVE_INFINITY });
    expect(safe.mean).toBeNull();
    expect(safe.ucl).toBeNull();
    expect(safe.n).toBe(50);
  });
});

describe('buildPayload', () => {
  it('默认（allowRawData=false）→ scope=summary，sentFields 不含 __raw', () => {
    const payload = buildPayload('chartExplain', summaryWithLeak, false);
    expect(payload.scope).toBe('summary');
    expect(payload.sentFields).not.toContain('__raw.measurements');
    expect(payload.sentFields).toContain('characteristicName');
  });

  it('allowRawData=true 但未传 rawData → 仍为 summary', () => {
    const payload = buildPayload('chartExplain', summaryWithLeak, true, undefined);
    expect(payload.scope).toBe('summary');
    expect(payload.sentFields).not.toContain('__raw.measurements');
  });

  it('allowRawData=true 且传 rawData → scope=raw，且 sentFields 含 __raw.measurements', () => {
    const payload = buildPayload('chartExplain', summaryWithLeak, true, {
      measurements: [50.1, 50.2],
    });
    expect(payload.scope).toBe('raw');
    expect(payload.sentFields).toContain('__raw.measurements');
  });

  it('默认摘要载荷的 user 消息不包含原始明细值', () => {
    const payload = buildPayload('capExplain', summaryWithLeak, false);
    const userMessage = payload.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(userMessage).not.toContain('50.1');
    expect(userMessage).not.toContain('secretInternalField');
    expect(userMessage).toContain('外壳长度');
  });

  it('messages 结构：首条为 system，第二条为 user', () => {
    const payload = buildPayload('qa', { projectName: 'P1' }, false, undefined, '哪个特性最差？');
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[1].role).toBe('user');
    expect(payload.messages[1].content).toContain('哪个特性最差？');
  });

  it('qa 功能的 system prompt 声明「仅基于统计摘要」', () => {
    const messages = buildMessages('qa', { projectName: 'P1' });
    expect(messages[0].content).toContain('仅基于');
  });
});

describe('summaryWhitelist', () => {
  it('白名单不含 measurements / rawData 等明细字段', () => {
    const wl = summaryWhitelist();
    expect(wl).not.toContain('measurements');
    expect(wl).not.toContain('rawData');
    expect(wl).not.toContain('__raw');
  });
});
