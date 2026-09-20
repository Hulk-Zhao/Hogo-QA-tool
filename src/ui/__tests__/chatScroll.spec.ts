/**
 * chatScroll —— 微信式滚动契约的纯函数部分（P7）。
 *
 * 为什么单独测这一段：jsdom 没有布局引擎，scrollHeight / clientHeight 恒为 0，
 * 组件用例里量不出真实滚动位置。把「贴底」阈值判断抽成纯函数后，
 * 「多少像素以内算贴底」这条规则就可以被确定性验证（不依赖任何浏览器）。
 */

import { describe, expect, it, vi } from 'vitest';
import { STICK_THRESHOLD_PX, isNearBottom, scrollToBottom } from '@/ui/chatScroll';

/** 构造一个可测的容器形状：内容 1000px、视口 400px → 最大 scrollTop = 600。 */
function metrics(scrollTop: number): { scrollTop: number; scrollHeight: number; clientHeight: number } {
  return { scrollTop, scrollHeight: 1000, clientHeight: 400 };
}

describe('isNearBottom —— 「贴底」判定', () => {
  it('正好在底部 / 距底等于阈值 → 贴底', () => {
    expect(isNearBottom(metrics(600))).toBe(true);
    expect(isNearBottom(metrics(600 - STICK_THRESHOLD_PX))).toBe(true);
  });

  it('距底超过阈值 1px → 不再贴底（上拉一点点就该停止跟随）', () => {
    expect(isNearBottom(metrics(600 - STICK_THRESHOLD_PX - 1))).toBe(false);
  });

  it('滚到顶部（正在读历史）→ 不贴底', () => {
    expect(isNearBottom(metrics(0))).toBe(false);
  });

  it('拿不到容器（null）→ 按贴底处理，而不是停在原地', () => {
    expect(isNearBottom(null)).toBe(true);
  });

  it('容差可覆盖（阈值是参数而不是写死的常数）', () => {
    expect(isNearBottom(metrics(500), 0)).toBe(false);
    expect(isNearBottom(metrics(600), 0)).toBe(true);
  });
});

describe('scrollToBottom —— 贴底动作', () => {
  it('有 scrollTo 时用它（且 behavior 是 auto：微信式直接跳，不做平滑动画）', () => {
    const scrollTo = vi.fn();
    scrollToBottom({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400, scrollTo });
    expect(scrollTo).toHaveBeenCalledWith({ top: 1000, behavior: 'auto' });
  });

  it('没有 scrollTo（jsdom / 老浏览器）→ 退化为直接写 scrollTop，不抛 TypeError', () => {
    const el = { scrollTop: 0, scrollHeight: 1000, clientHeight: 400 };
    expect(() => scrollToBottom(el)).not.toThrow();
    expect(el.scrollTop).toBe(1000);
  });

  it('容器为 null 时不抛错', () => {
    expect(() => scrollToBottom(null)).not.toThrow();
  });
});