/**
 * chatScroll —— 微信式会话视窗的滚动契约（P7）。
 *
 * 用户原话：「调整 AI 助手的问答展示方式，类似于微信的方式，点开是默认展示最底部
 * 消息，历史消息需要上拉」。这句话是三条必须同时成立的规则：
 *
 *  1. 进入页面 / 从别的页面切回来：**无条件**贴底 —— 最新一条消息可见；
 *  2. 新消息到达：**仅当**用户本来就在底部附近才跟随贴底。若用户正在上翻读历史，
 *     强行贴底会把他拽回底部（微信不这么做，我们也不这么做）；
 *  3. 用户主动上拉：立刻退出「贴底」态，直到他自己再滚回底部附近。
 *
 * 阈值判断放在这里而不是组件里，是为了能在 jsdom 里用纯函数直接验证：
 * jsdom 没有布局引擎，scrollHeight / clientHeight 恒为 0，量不出真实滚动位置。
 */

/** 距底部多少像素以内仍视为「贴底」。 */
export const STICK_THRESHOLD_PX = 48;

/** 滚动容器的最小可测形状（不要求是真实 DOM 元素，便于用例构造）。 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * 判断容器是否已（接近）滚到底部。
 *
 * @param el 滚动容器（null 时按「贴底」处理：量不到就跟随，比停在原地更符合直觉）
 * @param threshold 容差（px）
 * @returns true = 贴底
 */
export function isNearBottom(el: ScrollMetrics | null, threshold = STICK_THRESHOLD_PX): boolean {
  if (el === null) {
    return true;
  }
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * 把容器滚到底部。
 *
 * 两级降级，避免在不支持 `scrollTo` 的环境（jsdom / 老浏览器）抛 TypeError：
 * 1. `el.scrollTo({ top: scrollHeight, behavior: 'auto' })`；
 * 2. 直接写 `el.scrollTop`。
 *
 * @param el 滚动容器（或 null）
 */
export function scrollToBottom(el: (ScrollMetrics & { scrollTo?: unknown }) | null): void {
  if (el === null) {
    return;
  }
  if (typeof el.scrollTo === 'function') {
    (el.scrollTo as (options: { top: number; behavior: 'auto' }) => void)({
      top: el.scrollHeight,
      behavior: 'auto',
    });
    return;
  }
  el.scrollTop = el.scrollHeight;
}