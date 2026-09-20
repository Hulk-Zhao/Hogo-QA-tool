/**
 * aiClient 测试（架构 §7.1、§8.1）。
 *
 * 使用注入的假 fetch，验证：
 * - 请求 URL / 头 / body 正确；
 * - 成功提取 content；
 * - 错误归一化（auth / rateLimit / content / 网络）；
 * - 超时（3s 探测 / 30s 分析）；
 * - probeAi 三态（ai / UNREACHABLE / TIMEOUT），且「无 Base URL」不发请求
 *   （无 Key 的本地服务属合法配置，照常探测，见文末 D3/D4 回归）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ANALYSIS_TIMEOUT_MS,
  MAX_ANALYSIS_TIMEOUT_MS,
  MAX_RAW_BODY_SNIPPET_CHARS,
  MAX_SERVER_DETAIL_CHARS,
  MS_PER_OUTPUT_TOKEN,
  PROBE_TIMEOUT_MS,
  chatCompletionsUrl,
  chatCompletion,
  extractServerDetail,
  extractSseContent,
  modelsUrl,
  normalizeBaseUrl,
  isRetryableTransient,
  probeAi,
  readFailureMessage,
  resolveTimeoutMs,
} from '../aiClient';
import type { FetchLike, FetchLikeResponse } from '../types';
import { DEFAULT_MAX_TOKENS } from '../types';

/** 构造一个假响应。 */
function jsonResponse(body: unknown, status = 200): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * 构造「只有原始文本」的响应：`json()` 与真实 SSE 一样必然失败。
 *
 * 真实 fetch 里 SSE 响应调 `json()` 会抛错，用这个假响应能把「读文本再判格式」的
 * 新链路如实跑一遍。
 */
function textResponse(raw: string, status = 200): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(raw),
    text: async () => raw,
  };
}

const CONFIG = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', model: 'test-model' };

describe('URL 工具', () => {
  it('normalizeBaseUrl 去掉尾部斜杠', () => {
    expect(normalizeBaseUrl('https://a.com/v1/')).toBe('https://a.com/v1');
    expect(normalizeBaseUrl('  https://a.com/v1  ')).toBe('https://a.com/v1');
  });

  it('chatCompletionsUrl / modelsUrl 正确拼接', () => {
    expect(chatCompletionsUrl('https://a.com/v1')).toBe('https://a.com/v1/chat/completions');
    expect(modelsUrl('https://a.com/v1')).toBe('https://a.com/v1/models');
    expect(chatCompletionsUrl('https://a.com/v1/chat/completions')).toBe(
      'https://a.com/v1/chat/completions',
    );
  });
});

describe('chatCompletion', () => {
  it('成功：提取 choices[0].message.content', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ model: 'test-model', choices: [{ message: { content: '诊断结论' } }] }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('诊断结论');
    expect(resp.model).toBe('test-model');
  });

  it('请求体含 model / messages / stream=false，头和 URL 正确', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as FetchLike;
    await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], { temperature: 0.1, maxTokens: 64 }, fetchImpl);
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe('https://api.example.com/v1/chat/completions');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('Bearer sk-test');
    const body = JSON.parse(call[1].body);
    expect(body.model).toBe('test-model');
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(64);
  });

  it('401 → auth 错误码', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ error: 'bad key' }, 401));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('auth');
  });

  it('429 → rateLimit', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({}, 429));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.errorCode).toBe('rateLimit');
  });

  it('400 → content', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({}, 400));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.errorCode).toBe('content');
  });

  it('网络异常 → network，且不抛出', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('boom');
    });
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('network');
  });

  it('超时（AbortError）→ timeout', async () => {
    const fetchImpl: FetchLike = vi.fn(
      async (_url, init) =>
        new Promise<FetchLikeResponse>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { timeoutMs: 20 },
      fetchImpl,
    );
    expect(resp.errorCode).toBe('timeout');
  });

  it('内容为空 → content 错误码', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] }));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
  });
  it('★ 200 但返回 SSE（text/event-stream）→ 自动拼接 delta.content，不再误报「无法解析」', async () => {
    const sse = [
      'data: {"model":"deepseek-chat","choices":[{"delta":{"content":"过程"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"受控。"}}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token d in JSON');
      },
      text: async () => sse,
    }));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('过程受控。');
    expect(resp.model).toBe('deepseek-chat');
  });

  it('SSE 兜底兼容伪流式（choices[0].message.content）与 keep-alive 垃圾行', async () => {
    const sse = [
      ': keep-alive',
      'data: {"choices":[{"message":{"content":"完整"}, "finish_reason":"stop"}]}',
      'data: not-json',
      '',
      'data: [DONE]',
    ].join('\n');
    const fetchImpl: FetchLike = vi.fn(async () => textResponse(sse));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('完整');
    expect(resp.finishReason).toBe('stop');
  });

  it('★ 200 但既非 JSON 也非 SSE → 错误信息带服务端原文片段（可自助排查）', async () => {
    const raw = '<html>\n  <body>  502 Bad Gateway upstream refused  </body>\n</html>';
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
      text: async () => raw,
    }));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('无法解析');
    expect(resp.errorMessage).toContain('502 Bad Gateway');
    expect(resp.serverDetail).toContain('502 Bad Gateway');
    expect(resp.serverDetail).not.toContain('\n');
  });

  it('原文过长的非 JSON 响应 → 片段截断到 MAX_RAW_BODY_SNIPPET_CHARS，不把整页塞进 UI', async () => {
    const raw = 'x'.repeat(5000);
    const fetchImpl: FetchLike = vi.fn(async () => textResponse(raw));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect((resp.serverDetail ?? '').length).toBeLessThanOrEqual(MAX_RAW_BODY_SNIPPET_CHARS + 1);
  });

  it('200 且是合法 JSON 但缺少 choices → 文案点明「不是 OpenAI 兼容响应」（非泛化空内容）', async () => {
    const raw = '{"detail":"upstream error"}';
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => JSON.parse(raw),
      text: async () => raw,
    }));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('choices');
    expect(resp.errorMessage).toContain('upstream error');
  });

  it('200 但响应体为空 → 「返回内容为空」，且不带 serverDetail', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => textResponse(''));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorMessage).toContain('为空');
    expect(resp.serverDetail).toBeUndefined();
  });

  it('extractSseContent：只有 [DONE] / 空 delta 时不产出正文（空壳不会伪装成结论）', async () => {
    expect(extractSseContent('data: [DONE]\n').content).toBe('');
    expect(extractSseContent('data: {"choices":[{"delta":{}}]}\n').content).toBe('');

    const fetchImpl: FetchLike = vi.fn(async () =>
      textResponse('data: {"choices":[{"delta":{}}]}\n'),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('为空');
  });

  it('超时常量：分析 30s / 探测 3s', () => {
    expect(ANALYSIS_TIMEOUT_MS).toBe(30_000);
    expect(PROBE_TIMEOUT_MS).toBe(3_000);
  });
});

describe('probeAi', () => {
  it('无 Base URL → NO_BASE_URL，且不发起任何网络请求（数据主权 G3）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as FetchLike &
      ReturnType<typeof vi.fn>;
    const result = await probeAi({ ...CONFIG, baseUrl: '' }, {}, fetchImpl);
    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('NO_BASE_URL');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it('GET /models 成功 → AI 模式', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({ data: [] }, 200));
    const result = await probeAi(CONFIG, {}, fetchImpl);
    expect(result.mode).toBe('ai');
  });

  it('/models 404 但最小 chat 成功 → AI 模式（退化路径）', async () => {
    const fetchImpl: FetchLike = vi.fn(async (url: string) => {
      if (url.endsWith('/models')) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] }, 200);
    });
    const result = await probeAi(CONFIG, {}, fetchImpl);
    expect(result.mode).toBe('ai');
  });

  it('/models 与 chat 均失败 → offline UNREACHABLE 且保留配置', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse({}, 500));
    const result = await probeAi(CONFIG, {}, fetchImpl);
    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('UNREACHABLE');
    expect(result.keepConfig).toBe(true);
  });

  it('网络异常 → offline UNREACHABLE', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('no net');
    });
    const result = await probeAi(CONFIG, {}, fetchImpl);
    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('UNREACHABLE');
  });

  it('探测超时 → offline TIMEOUT', async () => {
    const fetchImpl: FetchLike = vi.fn(
      async (_url, init) =>
        new Promise<FetchLikeResponse>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }),
    );
    const result = await probeAi(CONFIG, { timeoutMs: 20 }, fetchImpl);
    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('TIMEOUT');
  });
});

// ---------------------------------------------------------------------------
// 本轮修复回归（D1 / D1b / D3 / D4）
//
// 证伪立场：下列断言全部针对**真实副作用**（注入假 fetch 后断言请求体 /
// 请求次数 / URL），而非仅断言函数返回值。本项目已多次出现「函数写好了
// 但从未接线」的缺陷，只测函数会漏掉整整一类问题。
// ---------------------------------------------------------------------------

/** 取假 fetch 的第 n 次调用。 */
function callOf(mockFetch: ReturnType<typeof vi.fn>, n = 0): [string, { body?: string; headers: Record<string, string> }] {
  return mockFetch.mock.calls[n] as [string, { body?: string; headers: Record<string, string> }];
}

describe('D1：max_tokens 默认值（推理模型不被 1024 截断）', () => {
  it('DEFAULT_MAX_TOKENS 常量为 4096', () => {
    expect(DEFAULT_MAX_TOKENS).toBe(4096);
  });

  it('不传 options → 请求体 max_tokens === DEFAULT_MAX_TOKENS（断言请求体实际内容）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    const [, init] = callOf(fetchImpl as unknown as ReturnType<typeof vi.fn>);
    const body = JSON.parse(init.body as string);
    // 关键：必须是请求体里真实的 max_tokens，而非本地变量。
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(body.max_tokens).toBe(4096);
  });

  it('传入 options.maxTokens 时覆盖默认值', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], { maxTokens: 8192 }, fetchImpl);

    const [, init] = callOf(fetchImpl as unknown as ReturnType<typeof vi.fn>);
    expect(JSON.parse(init.body as string).max_tokens).toBe(8192);
  });
});

describe('D1b：finish_reason 与推理字段解析（区分三种空正文情形）', () => {
  it("finish_reason='length' + reasoning 非空 + content 空 → ok:false / 'content' / 文案含「最大输出 tokens」与实际数值", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({
        model: 'qwen3.5:9b',
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning: '让我先逐步分析这批测量值……' },
          },
        ],
      }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('最大输出 tokens');
    // 断言文案里带出**实际使用的数值**，避免只有一句无信息量的报错。
    expect(resp.errorMessage).toContain(String(DEFAULT_MAX_TOKENS));
    // 推理内容必须透出（不能像修复前那样被丢弃）。
    expect(resp.reasoning).toBe('让我先逐步分析这批测量值……');
    expect(resp.finishReason).toBe('length');
  });

  it("finish_reason='length' + reasoning 空 + content 空 → 文案提示截断", async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '' } }],
      }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('截断');
    expect(resp.errorMessage).toContain(String(DEFAULT_MAX_TOKENS));
  });

  it('content 空且 finish_reason 非 length → 通用空内容文案（对照组）', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '' } }] }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect(resp.errorMessage).toContain('为空');
  });

  it('content 非空 → ok:true，且 finishReason / reasoning 正确透出', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({
        model: 'qwen3.5:9b',
        choices: [
          { finish_reason: 'stop', message: { content: '结论：过程受控。', reasoning: '先算 Xbar/R……' } },
        ],
      }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('结论：过程受控。');
    expect(resp.finishReason).toBe('stop');
    expect(resp.reasoning).toBe('先算 Xbar/R……');
    expect(resp.model).toBe('qwen3.5:9b');
  });

  it.each(['reasoning', 'reasoning_content', 'thinking'])(
    '推理字段三种命名都能识别：message.%s',
    async (field) => {
      const fetchImpl: FetchLike = vi.fn(async () =>
        jsonResponse({
          choices: [
            {
              finish_reason: 'length',
              message: { content: '', [field]: '思考内容-abc' },
            },
          ],
        }),
      );
      const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
      expect(resp.reasoning).toBe('思考内容-abc');
      expect(resp.ok).toBe(false);
    },
  );
});

describe("D3/D4：probeAi 无 Key 可探测 + fallback 判定（'content' 视为可达）", () => {
  it('apiKey 为空但 baseUrl 非空 → 不返回 NO_KEY，且确实发起请求（无 Authorization 头）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }, 200)) as unknown as FetchLike &
      ReturnType<typeof vi.fn>;
    const result = await probeAi(
      { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' },
      {},
      fetchImpl,
    );

    // 修复前此处返回 NO_KEY（假离线）；修复后必须真的去探测。
    expect(result.reason).not.toBe('NO_KEY');
    expect(result.mode).toBe('ai');
    const url = (
      fetchImpl as unknown as ReturnType<typeof vi.fn>
    ).mock.calls[0][0] as string;
    expect(url).toBe('http://127.0.0.1:11434/v1/models');
    expect(callOf(fetchImpl as unknown as ReturnType<typeof vi.fn>)[1].headers.Authorization).toBeUndefined();
  });

  it('baseUrl 为空 → NO_BASE_URL 且不发起任何网络请求', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as FetchLike &
      ReturnType<typeof vi.fn>;
    const result = await probeAi({ baseUrl: '   ', apiKey: 'sk-x', model: 'm' }, {}, fetchImpl);

    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('NO_BASE_URL');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("/models 404 → 退化 chat；chat 返回 'content'（正文空但有思考）→ 判定可用（mode 'ai'）", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/models')) {
        return jsonResponse({}, 404);
      }
      // 推理模型在极小 max_tokens 内只产出思考、正文为空。
      return jsonResponse({
        choices: [{ finish_reason: 'length', message: { content: '', reasoning: 'think' } }],
      });
    }) as unknown as FetchLike & ReturnType<typeof vi.fn>;

    const result = await probeAi(
      { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'qwen3.5:9b' },
      {},
      fetchImpl,
    );

    expect(result.mode).toBe('ai');
    // 副作用断言：确实发生了两次请求，第二次打到 /chat/completions。
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    expect(mock.mock.calls.length).toBe(2);
    expect(mock.mock.calls[1][0] as string).toContain('/chat/completions');
  });

  it("负向对照：/models 404 且 chat 真失败（401 auth）→ 仍 offline UNREACHABLE（防止「一律可用」假绿灯）", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/models')) {
        return jsonResponse({}, 404);
      }
      return jsonResponse({ error: 'bad key' }, 401);
    }) as unknown as FetchLike;

    const result = await probeAi(
      { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'sk-bad', model: 'qwen3.5:9b' },
      {},
      fetchImpl,
    );

    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('UNREACHABLE');
    expect(result.keepConfig).toBe(true);
  });
});

describe('reasoning_effort：条件发送 + 4xx 去掉重试一次（disableThinking 兜底）', () => {
  it('传入 reasoningEffort → 请求体带 reasoning_effort（且 max_tokens 并存）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'none' },
      fetchImpl,
    );
    const body = JSON.parse(
      callOf(fetchImpl as unknown as ReturnType<typeof vi.fn>)[1].body as string,
    );
    expect(body.reasoning_effort).toBe('none');
    expect(body.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it('未传 reasoningEffort → 请求体不含该字段（普通模型零影响）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    const body = JSON.parse(
      callOf(fetchImpl as unknown as ReturnType<typeof vi.fn>)[1].body as string,
    );
    expect('reasoning_effort' in body).toBe(false);
  });

  it('首个响应 4xx（服务端不认该字段）→ 去掉 reasoning_effort 重发一次，第二次成功', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return jsonResponse({ error: 'unknown field: reasoning_effort' }, 400);
      }
      return jsonResponse({ choices: [{ message: { content: '最终正文' } }] });
    }) as unknown as FetchLike & ReturnType<typeof vi.fn>;

    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'none' },
      fetchImpl,
    );

    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('最终正文');
    const mock = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    // 副作用断言：恰好两次请求，第一次带字段、第二次不带。
    expect(mock.mock.calls.length).toBe(2);
    expect(JSON.parse(mock.mock.calls[0][1].body as string).reasoning_effort).toBe('none');
    expect('reasoning_effort' in JSON.parse(mock.mock.calls[1][1].body as string)).toBe(false);
  });

  it('两次都 4xx → 只重试一次（不无限循环），返回归一化错误', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 400)) as unknown as FetchLike &
      ReturnType<typeof vi.fn>;
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { reasoningEffort: 'none' },
      fetchImpl,
    );

    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('content');
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

/**
 * 用户报障回归：UI 只说「请求内容被服务端拒绝，请检查模型名与参数。（HTTP 400）」——
 * 看不到服务端到底说了什么，无法自助排查。
 *
 * 实测复现（本机 Ollama v0.32.7 + 空模型名）：
 *   请求体 {"model":"", ...} → 400 {"error":{"message":"model is required"}}
 * 而旧实现把响应体读出来后**只用于判断要不要拼「（HTTP 400）」**，原文被丢弃。
 *
 * 证伪立场（每一条都写明「改回错的必然变红」）：
 * - 删掉 errorMessage 里的 serverDetail 拼接 → 「400 含服务端原文」变红；
 * - 删掉 serverDetail 字段 → 前三条变红；
 * - 删掉空白折叠或截断 → 「非 JSON 错误体」变红；
 * - 删掉空模型名前置拦截 → 「空模型名本地拦截」变红（会真的发请求）；
 * - 删掉 probeAi 的模型名校验 → 「NOT_CONFIGURED」变红（会误报 AI 模式可用）。
 */
describe('HTTP 非 2xx：服务端原文必须透出 + 空模型名必须前置拦截', () => {
  /** 本机 Ollama v0.32.7 对空模型名的真实响应体（HTTP 实测）。 */
  const OLLAMA_400_BODY =
    '{"error":{"message":"model is required","type":"invalid_request_error","param":null,"code":null}}';

  it('400 → errorMessage 含服务端原文，serverDetail 保留原句（旧实现丢弃原文）', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => jsonResponse(JSON.parse(OLLAMA_400_BODY), 400));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(false);
    expect(resp.serverDetail).toBe('model is required');
    expect(resp.errorMessage).toContain('model is required');
    expect(resp.errorMessage).toContain('400');
    expect(resp.httpStatus).toBe(400);
  });

  it('非 JSON 错误体（HTML / 纯文本）→ 折叠为单行并截断，不把整页塞进 UI', async () => {
    const raw = '<html>\n  <body>   502 Bad Gateway  </body>\n</html>' + 'x'.repeat(400);
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => raw,
    }));
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.serverDetail).toBeTruthy();
    expect(resp.serverDetail).not.toContain('\n');
    expect((resp.serverDetail ?? '').length).toBeLessThanOrEqual(MAX_SERVER_DETAIL_CHARS + 1);
    expect((resp.serverDetail ?? '').startsWith('<html>')).toBe(true);
  });

  it('extractServerDetail：兼容 {error:"文本"} / {message} / 空串', () => {
    expect(extractServerDetail('{"error":"bad key"}')).toBe('bad key');
    expect(extractServerDetail('{"message":"上下文超限"}')).toBe('上下文超限');
    expect(extractServerDetail('   ')).toBe('');
    expect(extractServerDetail('')).toBe('');
  });

  it('200 成功 → 不带 serverDetail（UI 不会误渲染「服务端原文」行）', async () => {
    const fetchImpl: FetchLike = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);

    expect(resp.ok).toBe(true);
    expect(resp.serverDetail).toBeUndefined();
  });

  it('空模型名 → 本地拦截：一个请求都不发，且文案点明是「模型名」的问题', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({}, 200),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    const resp = await chatCompletion(
      { ...CONFIG, model: '' },
      [{ role: 'user', content: 'hi' }],
      {},
      fetchImpl,
    );

    expect(resp.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resp.errorMessage).toContain('模型名');
    expect(resp.errorMessage).toContain('400');
    expect(resp.httpStatus).toBeUndefined();
  });

  it('probeAi：Base URL 可达但模型名为空 → NOT_CONFIGURED（不发请求、不误报 AI 模式）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'qwen3.5:9b' }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    const result = await probeAi({ ...CONFIG, model: '   ' }, {}, fetchImpl);

    expect(result.mode).toBe('offline');
    expect(result.reason).toBe('NOT_CONFIGURED');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.message).toContain('模型名');
  });

  it('probeAi：模型名非空时行为不变（仍按 /models 判定 AI 模式）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ id: 'qwen3.5:9b' }] }),
    ) as unknown as FetchLike & ReturnType<typeof vi.fn>;
    const result = await probeAi(CONFIG, {}, fetchImpl);

    expect(result.mode).toBe('ai');
    expect(fetchImpl).toHaveBeenCalled();
  });
});
describe('P9 —— 断流归因与自动重试', () => {
  /** 正文一读就断的响应（模拟连接在返回正文前被切断）。 */
  function cutResponse(): FetchLikeResponse {
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => {
        throw new Error('连接被切断');
      },
    };
  }

  it('resolveTimeoutMs：显式传值优先；否则按输出规模自适应并封顶', () => {
    expect(resolveTimeoutMs({ timeoutMs: 1234 })).toBe(1234);
    expect(resolveTimeoutMs({ maxTokens: 512 })).toBe(
      ANALYSIS_TIMEOUT_MS + 512 * MS_PER_OUTPUT_TOKEN,
    );
    expect(resolveTimeoutMs({ maxTokens: 100_000 })).toBe(MAX_ANALYSIS_TIMEOUT_MS);
    // 默认 4096 tokens 的预算已经超过封顶值：默认配置拿到的就是上限。
    expect(resolveTimeoutMs({})).toBe(MAX_ANALYSIS_TIMEOUT_MS);
  });

  it('readFailureMessage：0 字节 / 传到一半 / 超时 三种归因分开说（不再是一句「响应流中断」）', () => {
    expect(readFailureMessage({ bytes: 0, timedOut: false })).toContain('未收到任何数据');
    expect(readFailureMessage({ bytes: 1234, timedOut: false })).toContain('已收到 1234 字节');
    expect(readFailureMessage({ bytes: 0, timedOut: true })).toContain('等待响应正文超时');
  });

  it('★ 读正文被切断 → 自动重试一次；重试成功就照常返回（用户那次却要手点三次）', async () => {
    let calls = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return cutResponse();
      }
      return jsonResponse({ choices: [{ message: { content: '第二次成功了' } }] });
    });
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('第二次成功了');
    expect(calls).toBe(2);
  });

  it('★ 两次都被切断 → 文案必须说清「已自动重试 1 次」与「未收到任何数据」', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => cutResponse());
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(resp.errorCode).toBe('network');
    expect(resp.errorMessage).toContain('已自动重试 1 次');
    expect(resp.errorMessage).toContain('未收到任何数据');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('★ 正文传到一半被截断 → 文案带上已收字节数（VPN / 代理的典型症状）', async () => {
    /** 第一块给 3 字节，第二块直接抛错 —— 模拟长响应被网关截断。 */
    function halfResponse(): FetchLikeResponse {
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => '',
        body: {
          getReader: () => {
            let round = 0;
            return {
              read: async () => {
                round += 1;
                if (round === 1) {
                  return { done: false, value: new Uint8Array([123, 34, 97]) };
                }
                throw new Error('网络断了');
              },
            };
          },
        },
      };
    }
    const fetchImpl: FetchLike = vi.fn(async () => halfResponse());
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], {}, fetchImpl);
    expect(resp.errorCode).toBe('network');
    expect(resp.errorMessage).toContain('传到一半被切断');
    expect(resp.errorMessage).toContain('已收到 3 字节');
  });

  it('★ 超时导致正文读失败 → 归 timeout，且**不**重试（重试只会让用户多等一倍）', async () => {
    const fetchImpl: FetchLike = vi.fn(
      async (_url, init) =>
        ({
          ok: true,
          status: 200,
          json: async () => ({}),
          text: () =>
            new Promise<string>((_resolve, reject) => {
              const fail = (): void => {
                const err = new Error('aborted');
                err.name = 'AbortError';
                reject(err);
              };
              if (init?.signal?.aborted === true) {
                fail();
                return;
              }
              init?.signal?.addEventListener('abort', fail);
            }),
        }) as FetchLikeResponse,
    );
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { timeoutMs: 20 },
      fetchImpl,
    );
    expect(resp.errorCode).toBe('timeout');
    expect(resp.errorMessage).toContain('等待响应正文超时');
    expect(resp.errorMessage).not.toContain('已自动重试');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('用户主动取消（AbortError 且非超时）→ 不重试，仍报 aborted', async () => {
    const controller = new AbortController();
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      controller.abort();
      return new Promise<FetchLikeResponse>((_resolve, reject) => {
        const fail = (): void => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        };
        if (init?.signal?.aborted === true) {
          fail();
          return;
        }
        init?.signal?.addEventListener('abort', fail);
      });
    });
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { signal: controller.signal },
      fetchImpl,
    );
    expect(resp.errorCode).toBe('aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('isRetryableTransient：只认瞬时链路故障，不含超时 / 取消 / 4xx / 正常响应', () => {
    expect(isRetryableTransient({ kind: 'read-failed', status: 200, bytes: 0, timedOut: false })).toBe(true);
    expect(isRetryableTransient({ kind: 'read-failed', status: 200, bytes: 12, timedOut: false })).toBe(true);
    expect(isRetryableTransient({ kind: 'read-failed', status: 200, bytes: 0, timedOut: true })).toBe(false);
    expect(isRetryableTransient({ kind: 'thrown', error: new TypeError('failed'), timedOut: false })).toBe(true);
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(isRetryableTransient({ kind: 'thrown', error: abortErr, timedOut: false })).toBe(false);
    expect(isRetryableTransient({ kind: 'thrown', error: new Error('t'), timedOut: true })).toBe(false);
    expect(isRetryableTransient({ kind: 'http', status: 429, serverDetail: '' })).toBe(false);
    expect(isRetryableTransient({ kind: 'body', status: 200, body: '{}' })).toBe(false);
  });
});