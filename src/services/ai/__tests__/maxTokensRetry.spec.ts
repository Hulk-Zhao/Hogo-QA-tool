/**
 * chatCompletion 的 max_tokens 自愈重试（本轮 P3-A）。
 *
 * 缺陷背景（用户实测截图）：设置页的「最大输出 tokens」按需求**刻意不设上限**，
 * 用户填了个大值后 DeepSeek 直接 400：
 *   Invalid max_tokens value, the valid range of max_tokens is [1, 393216]
 * 而用户看到的只有一句「请求内容被服务端拒绝，请检查模型名与参数」——
 * 既不知道错在哪个参数，也不知道该填多少，只能靠猜。
 *
 * 修复：读**服务端自己声明的区间**收敛后重试；仍失败才报错，并写明「已自动收敛」。
 *
 * 证伪立场：
 * - 去掉 parseMaxTokensRange / clampMaxTokens 的接线 → 第 3、4、5 组变红；
 * - clampMaxTokens 少了上限或下限（Math.min / Math.max 少一个）→ 第 2、3 组变红；
 * - 去掉「最多 3 次」的循环上限 → 第 5 组会无限请求（测试超时/调用次数断言失败）。
 */

import { describe, expect, it, vi } from 'vitest';
import { chatCompletion, clampMaxTokens, parseMaxTokensRange } from '../aiClient';
import type { FetchLike, FetchLikeResponse } from '../types';

const CONFIG = { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-chat' };
/** DeepSeek 实测原文（用户截图里的那一句）。 */
const RANGE_ERROR = 'Invalid max_tokens value, the valid range of max_tokens is [1, 393216]';

function jsonResponse(body: unknown, status = 200): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * 造一个「按区间拒绝 max_tokens」的假服务端。
 *
 * @param max 该服务端允许的最大 max_tokens
 * @param alwaysReject 是否无视参数永远拒绝（用于验证「重试有上限」）
 * @returns fetch 与收到的请求体列表
 */
function guardedFetch(max: number, alwaysReject = false): { fetch: FetchLike; bodies: Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push(body);
    const tokens = Number(body.max_tokens);
    if (alwaysReject || tokens > max || tokens < 1) {
      return jsonResponse({ error: { message: RANGE_ERROR } }, 400);
    }
    return jsonResponse({ model: 'deepseek-chat', choices: [{ message: { content: '正文' } }] });
  });
  return { fetch: fetchImpl as unknown as FetchLike, bodies };
}

describe('parseMaxTokensRange —— 读服务端声明的区间', () => {
  it('解析 DeepSeek 原文', () => {
    expect(parseMaxTokensRange(RANGE_ERROR)).toEqual({ min: 1, max: 393216 });
  });

  it('容忍空格与大小写差异', () => {
    expect(parseMaxTokensRange('invalid MAX_TOKENS value, valid range is [ 2 , 100 ]')).toEqual({
      min: 2,
      max: 100,
    });
  });

  it('与 max_tokens 无关的错误不误判', () => {
    expect(parseMaxTokensRange('model is required')).toBeNull();
    expect(parseMaxTokensRange('max_tokens is required')).toBeNull();
    expect(parseMaxTokensRange('')).toBeNull();
  });

  it('错误里带方括号区间但说的不是 max_tokens → 绝不能拿来改 max_tokens', () => {
    // 别的参数（温度/上下文长度/批大小）也常见「[min, max]」写法；
    // 只看方括号就动手，会把用户唯一正确的设置改坏，比不修更糟。
    expect(parseMaxTokensRange('temperature must be within [0, 2]')).toBeNull();
    expect(parseMaxTokensRange('top_p range is [0.1, 1]')).toBeNull();
    expect(parseMaxTokensRange('context length must be in [512, 128000]')).toBeNull();
  });

  it('区间本身不合理时返回 null（不产生更坏的行为）', () => {
    expect(parseMaxTokensRange('max_tokens range [0, 100]')).toBeNull();
    expect(parseMaxTokensRange('max_tokens range [100, 1]')).toBeNull();
  });
});

describe('clampMaxTokens —— 收敛到区间内', () => {
  it('超上限收到上限、低于下限抬到下限', () => {
    expect(clampMaxTokens(1000000, { min: 1, max: 393216 })).toBe(393216);
    expect(clampMaxTokens(0, { min: 1, max: 393216 })).toBe(1);
  });

  it('区间内原样保留（不为 1 时也是原值）', () => {
    expect(clampMaxTokens(4096, { min: 1, max: 393216 })).toBe(4096);
    expect(clampMaxTokens(393216, { min: 1, max: 393216 })).toBe(393216);
    expect(clampMaxTokens(1, { min: 1, max: 393216 })).toBe(1);
  });
});

describe('chatCompletion —— max_tokens 自愈重试', () => {
  it('超上限：自动收敛后成功，且第二次请求带的是收敛值', async () => {
    const { fetch: fetchImpl, bodies } = guardedFetch(393216);
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1000000 },
      fetchImpl,
    );

    expect(resp.ok).toBe(true);
    expect(resp.content).toBe('正文');
    expect(bodies.length).toBe(2);
    expect(bodies[0].max_tokens).toBe(1000000);
    expect(bodies[1].max_tokens).toBe(393216);
  });

  it('区间内：不多发一次请求（不做无谓重试）', async () => {
    const { fetch: fetchImpl, bodies } = guardedFetch(393216);
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], { maxTokens: 8192 }, fetchImpl);
    expect(resp.ok).toBe(true);
    expect(bodies.length).toBe(1);
    expect(bodies[0].max_tokens).toBe(8192);
  });

  it('收敛后仍被拒：最多再试有限次，并把「已自动收敛」写进错误信息', async () => {
    const { fetch: fetchImpl, bodies } = guardedFetch(393216, true);
    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1000000 },
      fetchImpl,
    );

    expect(resp.ok).toBe(false);
    // 首次 + 收敛后重试 = 2 次；绝不允许无限重试
    expect(bodies.length).toBe(2);
    expect(bodies[1].max_tokens).toBe(393216);
    expect(resp.errorMessage).toContain('自动收敛');
    expect(resp.errorMessage).toContain('393216');
    expect(resp.serverDetail).toContain('393216');
  });

  it('与「摘掉 reasoning_effort」共存时总请求数仍有上限', async () => {
    const body: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      const parsed = JSON.parse(String(init.body)) as Record<string, unknown>;
      body.push(parsed);
      return jsonResponse({ error: { message: RANGE_ERROR } }, 400);
    }) as unknown as FetchLike;

    const resp = await chatCompletion(
      CONFIG,
      [{ role: 'user', content: 'hi' }],
      { maxTokens: 1000000, reasoningEffort: 'none' },
      fetchImpl,
    );

    expect(resp.ok).toBe(false);
    expect(body.length).toBeLessThanOrEqual(3);
    // 收敛发生在摘 reasoning_effort 之前（更具体、更可操作的那个先修）
    expect(body[1].max_tokens).toBe(393216);
    expect(body[1].reasoning_effort).toBe('none');
  });

  it('与 max_tokens 无关的 400：不发无谓重试', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'model is required' } }, 400),
    ) as unknown as FetchLike;
    const resp = await chatCompletion(CONFIG, [{ role: 'user', content: 'hi' }], { maxTokens: 1000000 }, fetchImpl);
    expect(resp.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(resp.errorMessage).not.toContain('自动收敛');
  });
});
