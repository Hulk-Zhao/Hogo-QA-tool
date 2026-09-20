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

/**
 * P8：把「够 LLM 用」的数据面送出去 + 公共数据契约。
 *
 * 缺陷背景（用户报障 + 截图）：AI 回复「这份统计摘要里…未给出控制图点子序列，
 * warnings 全为空，因此不能编造第几子组触发某判异规则」。
 * 修复分两半，两半都必须被锁住：
 *  ① 数据面：analysisContext 装配的字段（points / violations / chartCatalogue…）必须活着穿过白名单；
 *  ② 提示词：system prompt 必须写明「数据已算好、直接用」并**禁止**拿「数据未提供」当回答。
 */
describe('buildPayload —— P8 数据面与数据契约', () => {
  const context = {
    projectName: '质量日报',
    datasetName: '外壳长度数据',
    measurementCount: 60,
    characteristicCount: 1,
    selectedCharacteristic: '外壳长度',
    subgroupConfig: { mode: 'fixed', capacity: 5, sigmaMode: 'R', subgroupSeriesLimit: 60 },
    ruleSet: { enabled: ['W1', 'N1'], labels: { W1: '1 点超出 ±3σ' } },
    characteristics: [
      {
        characteristicName: '外壳长度',
        n: 60,
        cpk: 1.42,
        controlChart: {
          chartType: 'Xbar-R',
          subgroupCount: 12,
          ucl: 50.2,
          lcl: 49.9,
          points: [{ i: 1, mean: 50.01, range: 0.04 }],
          violations: [{ ruleId: 'W1', subgroupIndices: [7], message: '第 7 点超出上限' }],
          outOfLimit: [{ subgroupIndex: 7, limit: 'UCL', value: 50.6 }],
        },
      },
    ],
    chartCatalogue: [{ id: 'chart:control:外壳长度', kind: 'control', title: '外壳长度 · 控制图' }],
    caveats: ['数据口径：均值与 σ 均为未排除测量值的统计结果'],
    // 白名单外的字段必须继续被剥掉
    measurements: [{ characteristicName: '外壳长度', values: [50.1, 50.2] }],
  };

  it('子组序列 / 判异明细 / 图表目录 / 规则清单都活着穿过白名单（否则模型看不到）', () => {
    const payload = buildPayload('qa', context, false, undefined, '第几子组异常？');
    const body = payload.messages[1].content;

    expect(payload.scope).toBe('summary');
    for (const key of ['subgroupConfig', 'ruleSet', 'chartCatalogue', 'caveats', 'characteristics']) {
      expect(payload.sentFields).toContain(key);
    }
    // 真正的关键：请求体里能搜到子组均值序列与判异明细（用户要的就是「第几子组」）
    expect(body).toContain('"subgroupCount": 12');
    expect(body).toContain('"subgroupIndices"');
    expect(body).toContain('"points"');
    expect(body).toContain('chart:control:外壳长度');
    // 逐条原始值仍然不发
    expect(body).not.toContain('measurements');
  });

  it('system prompt 带公共数据契约：禁止「摘要未提供 / 数据不足 / 无法判断」，并要求落到具体对象', () => {
    const prompt = buildMessages('qa', {})[0].content;
    expect(prompt).toMatch(/禁[止止][^。]{0,20}摘要未提供/);
    expect(prompt).toContain('严禁臆造');
    expect(prompt).toContain('subgroupIndices');
    expect(prompt).toContain('chartCatalogue');
    expect(prompt).toContain('[[chart:');
  });

  it('白名单导出里含 P8 新字段（设置页/审计可核对发送面）', () => {
    const whitelist = summaryWhitelist();
    for (const key of ['chartCatalogue', 'ruleSet', 'subgroupConfig', 'caveats', 'datasetName', 'selectedCharacteristic']) {
      expect(whitelist).toContain(key);
    }
  });
});