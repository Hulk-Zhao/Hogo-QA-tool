/**
 * reportAnalysis 测试（P4-B：AI 导出必须真的接入 LLM）。
 *
 * 证伪立场：
 *  - 若换成「不调用 LLM、本地拼一段文字」→ 「每个有数据的模块各调用一次」变红；
 *  - 若把全部模块塞进一次请求 → 调用次数断言（N 个模块 = N 次）变红；
 *  - 若不把「分析方向」放进消息 → 「方向进入 user 消息且顺序一致」变红；
 *  - 若鉴权失败后仍继续打满剩余模块 → 「提前中止」变红（白烧请求）；
 *  - 若不写审计 → 「usage 条数 = 请求次数」变红。
 */

import { describe, expect, it, vi } from 'vitest';
import { buildModuleMessages, runReportAnalysis, shouldAbortAnalysis } from '../reportAnalysis';
import type { AiResponse, ChatMessage } from '../types';
import type { ReportModel } from '@/data/exporter/reportModel';

function makeModel(overrides: Partial<ReportModel> = {}): ReportModel {
  return {
    projectName: '测试项目',
    generatedAt: '2026-09-19T08:00:00.000Z',
    cpkSummary: [
      {
        characteristic: '外壳长度',
        n: 60,
        mean: 50.05,
        sigmaWithin: 0.05,
        sigmaOverall: 0.07,
        usl: 50.2,
        lsl: 49.8,
        ca: 0.25,
        cp: 1.333,
        cpk: 1.1,
        pp: 0.952,
        ppk: 0.785,
        sigmaLevelShort: 3.3,
        sigmaLevelBench: 4.8,
        ppmOverall: 12345,
      },
    ],
    defectStats: [],
    rawDimensions: [],
    rawDefects: [],
    warnings: [],
    ...overrides,
  };
}

const AI_CONFIG = { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' };

function okResponse(content: string): AiResponse {
  return { ok: true, content, errorCode: null, errorMessage: null, model: 'qwen3.5:9b' };
}

function errResponse(code: AiResponse['errorCode'], message: string): AiResponse {
  return { ok: false, content: '', errorCode: code, errorMessage: message, model: 'qwen3.5:9b' };
}

describe('shouldAbortAnalysis', () => {
  it('鉴权/网络/超时/限流/未知 → 中止；content → 继续（单模块失败不连坐）', () => {
    expect(shouldAbortAnalysis('auth')).toBe(true);
    expect(shouldAbortAnalysis('network')).toBe(true);
    expect(shouldAbortAnalysis('timeout')).toBe(true);
    expect(shouldAbortAnalysis('rateLimit')).toBe(true);
    expect(shouldAbortAnalysis('aborted')).toBe(true);
    expect(shouldAbortAnalysis('unknown')).toBe(true);
    expect(shouldAbortAnalysis('content')).toBe(false);
    expect(shouldAbortAnalysis(null)).toBe(false);
  });
});

describe('buildModuleMessages', () => {
  it('★ 一个模块一份消息，且只下发「本模块适用」的方向（否则模型只能回「无法判断」的废话）', () => {
    const messages = buildModuleMessages(
      {
        id: 'cpk',
        title: 'CPK 汇总',
        summary: { module: 'CPK汇总', characteristicCount: 1 },
        unavailable: null,
        applicableFocus: ['capability', 'improvement'],
        dataScope: '只有 n 与特性数（测试用）。',
      },
      ['stability', 'capability', 'improvement'],
      '测试项目',
    );
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    // system 是本功能专属提示词，不是别的功能的
    expect(messages[0].content).toContain('逐模块');
    expect(messages[0].content).toContain('严禁臆造');
    const user = messages[1].content;
    expect(user).toContain('测试项目');
    expect(user).toContain('CPK 汇总');
    expect(user).toContain('characteristicCount');
    // 本模块 applicableFocus 不含 stability → 即便用户勾了，也不能出现在 prompt 里
    expect(user).not.toContain('过程稳定性');
    expect(user).toContain('过程能力达标');
    expect(user).toContain('改善建议');
    expect(user.indexOf('过程能力达标')).toBeLessThan(user.indexOf('改善建议'));
  });

  it('方向指令按固定清单顺序下发（与用户勾选顺序无关）', () => {
    const messages = buildModuleMessages(
      {
        id: 'cpk',
        title: 'CPK 汇总',
        summary: { module: 'CPK汇总' },
        unavailable: null,
        applicableFocus: ['capability', 'improvement'],
        dataScope: '测试用。',
      },
      ['improvement', 'capability'],
      '测试项目',
    );
    const user = messages[1].content;
    expect(user.indexOf('过程能力达标')).toBeLessThan(user.indexOf('改善建议'));
  });

  it('★ user 消息注入本模块数据口径 + 禁止「摘要未提供」占位（噪音根源修复）', () => {
    const messages = buildModuleMessages(
      {
        id: 'defect',
        title: '不良统计',
        summary: { module: '不良统计', defectTypeCount: 1 },
        unavailable: null,
        applicableFocus: ['defectPareto'],
        dataScope: '本模块是**计数（不良）**数据：没有均值与 σ。',
      },
      ['defectPareto'],
      '测试项目',
    );
    const user = messages[1].content;
    expect(user).toContain('本模块的数据口径：本模块是**计数（不良）**数据：没有均值与 σ。');
    expect(user).toContain('只输出上面列出的分析方向');
    expect(user).toContain('也不要用「摘要未提供」占位');
  });
});

describe('runReportAnalysis', () => {
  it('每个有数据的模块各调用一次 LLM，串行且顺序固定', async () => {
    const calls: { titleish: string; messages: ChatMessage[] }[] = [];
    const chat = vi.fn(async (_config, messages: ChatMessage[]) => {
      calls.push({ titleish: String(messages[1].content), messages });
      return okResponse('### 分析\n- 结论');
    });

    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['stability', 'capability'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });

    // 有数据的是 cpk / controlChart / capabilityChart（defect、pareto、rawDimensions 无数据）
    expect(chat).toHaveBeenCalledTimes(3);
    expect(result.requestCount).toBe(3);
    expect(result.abortedBy).toBeNull();
    expect(result.analyses.map((a) => a.moduleId)).toEqual([
      'cpk',
      'defect',
      'controlChart',
      'pareto',
      'capabilityChart',
      'rawDimensions',
    ]);
    // 结果顺序 = 报表模块顺序，不是调用顺序
    expect(calls[0].titleish).toContain('CPK 汇总');
    expect(calls[1].titleish).toContain('控制图');
    expect(calls[2].titleish).toContain('能力图');
    // 无数据模块不调用，但结果里显式列出原因
    const defect = result.analyses.find((a) => a.moduleId === 'defect')!;
    expect(defect.ok).toBe(false);
    expect(defect.skipReason).toContain('未导入不良记录');
    expect(defect.sentFields).toEqual([]);
  });

  it('成功模块带正文/模型/发送字段清单；审计条数 = 请求次数', async () => {
    const chat = vi.fn(async () => okResponse('### 分析\n- 外壳长度 Cpk=1.1 低于 1.33'));
    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      maxTokens: 4096,
      disableThinking: true,
      chat: chat as never,
    });
    const cpk = result.analyses.find((a) => a.moduleId === 'cpk')!;
    expect(cpk.ok).toBe(true);
    expect(cpk.markdown).toContain('Cpk=1.1');
    expect(cpk.model).toBe('qwen3.5:9b');
    expect(cpk.sentFields).toContain('moduleTitle');
    expect(cpk.sentFields).toContain('characteristics');
    expect(result.usage).toHaveLength(result.requestCount);
    expect(result.usage.every((u) => u.feature === 'moduleAnalysis')).toBe(true);
    expect(result.usage.every((u) => u.sentPayloadScope === 'summary')).toBe(true);
  });

  it('★ 模块分析正文里的图表引用标记会被剥离（导出路径不渲染图表，标记不能跟着 Word/Excel出门）', async () => {
    const chat = vi.fn(async () => okResponse('### 分析\n- 外壳长度第 7 子组均值越 UCL\n\n[[chart:control:外壳长度]]\n\n建议停线复测。'));
    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      maxTokens: 4096,
      disableThinking: true,
      chat: chat as never,
    });
    const cpk = result.analyses.find((a) => a.moduleId === 'cpk')!;
    expect(cpk.ok).toBe(true);
    expect(cpk.markdown).toContain('第 7 子组均值越 UCL');
    expect(cpk.markdown).not.toContain('[[chart:');
    expect(cpk.markdown).not.toContain('chart:control:');
  });

  it('请求选项按设置页透传（maxTokens / disableThinking / signal）', async () => {
    const seen: unknown[] = [];
    const chat = vi.fn(async (_c, _m, options: unknown) => {
      seen.push(options);
      return okResponse('正文');
    });
    const controller = new AbortController();
    await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      maxTokens: 8192,
      disableThinking: true,
      signal: controller.signal,
      chat: chat as never,
    });
    expect(seen[0]).toMatchObject({
      maxTokens: 8192,
      reasoningEffort: 'none',
      signal: controller.signal,
    });
  });

  it('鉴权失败 → 立即中止，不再为剩余模块发请求', async () => {
    const chat = vi.fn(async () => errResponse('auth', 'API Key 无效（401）'));
    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.requestCount).toBe(1);
    expect(result.abortedBy).toContain('401');
    // 只有「本可分析」的模块才应显示「前序模块失败」；
    // 本来就无数据的模块仍然显示自己的无数据原因（信息不能被覆盖掉）。
    const analyzableRest = result.analyses.filter((a) => a.moduleId === 'capabilityChart');
    expect(analyzableRest.every((a) => a.skipReason?.includes('前序模块失败'))).toBe(true);
    // 控制图模块在本次方向下**本就不适用**，因此不参与「前序失败」，理由也不该被覆盖
    expect(result.analyses.find((a) => a.moduleId === 'controlChart')!.skipReason).toContain(
      '不适用于本模块',
    );
    expect(result.analyses.find((a) => a.moduleId === 'defect')!.skipReason).toContain('未导入不良记录');
  });

  it('content 类失败（如模型名写错）不中止：后续模块仍会尝试', async () => {
    let n = 0;
    const chat = vi.fn(async () => {
      n += 1;
      return n === 1 ? errResponse('content', 'model not found') : okResponse('正文');
    });
    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });
    // 只分析「本次方向适用」的模块：CPK 汇总 + 能力图（控制图不适用 capability）
    expect(chat).toHaveBeenCalledTimes(2);
    expect(result.abortedBy).toBeNull();
    expect(result.analyses.find((a) => a.moduleId === 'cpk')!.errorMessage).toContain('model not found');
    expect(result.analyses.find((a) => a.moduleId === 'capabilityChart')!.ok).toBe(true);
  });

  it('模型返回空正文 → 记为失败，并给出「调大 max_tokens」的可操作提示', async () => {
    const chat = vi.fn(async () => okResponse('   '));
    const result = await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });
    const cpk = result.analyses.find((a) => a.moduleId === 'cpk')!;
    expect(cpk.ok).toBe(false);
    expect(cpk.errorMessage).toContain('最大输出 tokens');
    // 空正文不是「提前中止」的理由（换模块可能就正常）
    expect(result.abortedBy).toBeNull();
  });

  it('进度回调按模块触发，且总数 = 有数据的模块数', async () => {
    const chat = vi.fn(async () => okResponse('正文'));
    const progress: { done: number; total: number; title: string }[] = [];
    await runReportAnalysis({
      model: makeModel(),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      onProgress: (info) => progress.push(info),
      chat: chat as never,
    });
    expect(progress.filter((p) => p.title !== '完成').map((p) => p.title)).toEqual([
      'CPK 汇总',
      '能力图（直方图 + USL/LSL）',
    ]);
    expect(progress[0].total).toBe(2);
  });

  it('★ 方向不适用于某模块时：不发请求，但在结果里显式说明原因（消除「摘要未提供」噪音的根源）', async () => {
    const chat = vi.fn(async () => okResponse('正文'));
    const result = await runReportAnalysis({
      model: makeModel({
        defectStats: [{ defectType: '划伤', count: 12, ratio: 60, cumRatio: 60 }],
        rawDefects: [{ defectType: '划伤', count: 12, category: '外观' }],
      }),
      focusIds: ['defectPareto'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });
    // 只勾「不良优先级」时，只有不良统计 / 柏拉图适用；其余模块一次请求都不发
    expect(chat).toHaveBeenCalledTimes(2);
    const control = result.analyses.find((a) => a.moduleId === 'controlChart')!;
    expect(control.ok).toBe(false);
    expect(control.skipReason).toContain('不适用于本模块');
    expect(control.sentFields).toEqual([]);
  });

  it('全部模块无数据 → 一次请求都不发（不白烧 LLM 调用）', async () => {
    const chat = vi.fn(async () => okResponse('正文'));
    const result = await runReportAnalysis({
      model: makeModel({ cpkSummary: [] }),
      focusIds: ['capability'],
      aiConfig: AI_CONFIG,
      chat: chat as never,
    });
    expect(chat).not.toHaveBeenCalled();
    expect(result.requestCount).toBe(0);
    expect(result.analyses).toHaveLength(6);
    expect(result.analyses.every((a) => !a.ok)).toBe(true);
  });
});
