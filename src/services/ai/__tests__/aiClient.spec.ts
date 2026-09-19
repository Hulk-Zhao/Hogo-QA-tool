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
  MAX_SERVER_DETAIL_CHARS,
  PROBE_TIMEOUT_MS,
  chatCompletionsUrl,
  chatCompletion,
  extractServerDetail,
  modelsUrl,
  normalizeBaseUrl,
  probeAi,
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