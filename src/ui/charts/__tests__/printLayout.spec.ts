// @vitest-environment jsdom
/**
 * printLayout 测试（P4-A 重写）。
 *
 * 缺陷背景（用户第二次实测）：「报表打印和 excel 导出都没有图片」，打印预览里
 * 「控制图」卡片只剩标题、图形一片空白。
 *
 * 真实根因（`.probe/p4-print-truth.mjs`，不预置 print 媒体的真实路径）：
 * P3 的 `key={printing ? 'print' : 'screen'}` 会在 beforeprint 里**卸载**旧图表再
 * 挂载新的，而 zrender 的重绘是异步的 —— 实测 Chrome 取快照的那一刻
 * `.print-chart canvas` 数量是 **0**，所以纸上是空白。
 *
 * 证伪立场（每条都能被一句代码改红）：
 *  - 若把快照改回异步（`await` / `requestAnimationFrame` / `setTimeout`）→
 *    「同步就位」用例立刻变红（这是本轮的核心回归护栏）；
 *  - 若 `printPixelRatio` 返回 1 → 「DPI 契约」变红；
 *  - 若 `capturePrintSnapshots` 不按卡片分组、改成逐画布各出一张 →
 *    「控制图两块画布纵向拼成一张」变红；
 *  - 若没有幂等标记 → 「重复调用不会叠加」变红；
 *  - 若 `restorePrintSnapshots` 只删画布不摘宿主类 → 「恢复后宿主类被摘掉」变红；
 *  - 若拿不到 ECharts 实例时不退化 → 「无实例时直接搬像素」变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({ instances: new Map<Element, unknown>() }));

vi.mock('echarts', () => ({
  getInstanceByDom: (dom: Element) => hoisted.instances.get(dom),
}));

import {
  ECHARTS_INSTANCE_ATTR,
  PRINT_MAX_PIXEL_RATIO,
  PRINT_MIN_PIXEL_RATIO,
  PRINT_SNAPSHOT_BACKGROUND,
  PRINT_SNAPSHOT_CLASS,
  PRINT_SNAPSHOT_HOST_CLASS,
  PRINT_TARGET_RASTER_PX,
  __resetPrintLayoutForTest,
  capturePrintSnapshots,
  ensurePrintSnapshotBinding,
  isPrintingNow,
  printPixelRatio,
  restorePrintSnapshots,
  snapshotPlan,
  stackRasters,
} from '@/ui/charts/printLayout';

/** A4 可打印宽度（mm）：210mm - 左右各 12mm 边距。 */
const PRINTABLE_WIDTH_MM = 186;
const PRINTABLE_WIDTH_IN = PRINTABLE_WIDTH_MM / 25.4;

/** jsdom 的 canvas.getContext 默认返回 null；这里装一个够用的 2D 上下文。 */
const drawn: { w: number; h: number }[] = [];

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({
        fillStyle: '',
        fillRect: () => undefined,
        drawImage: (src: { width: number; height: number }) =>
          drawn.push({ w: src.width, h: src.height }),
      }) as unknown as CanvasRenderingContext2D,
  );
}

/** 造一个假的 ECharts 实例：`getRenderedCanvas` 返回指定尺寸的位图。 */
function fakeInstance(width: number, height: number, calls: unknown[]): unknown {
  return {
    getRenderedCanvas: (opts: unknown) => {
      calls.push(opts);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
  };
}

function buildPage(): void {
  document.body.innerHTML =
    '<div data-testid="report-charts">' +
    '<div class="print-chart" id="p1">' +
    `<div ${ECHARTS_INSTANCE_ATTR}="e1"><canvas id="c1" width="400" height="300"></canvas></div>` +
    `<div ${ECHARTS_INSTANCE_ATTR}="e2"><canvas id="c2" width="400" height="200"></canvas></div>` +
    '</div>' +
    '<div class="print-chart" id="p2">' +
    `<div ${ECHARTS_INSTANCE_ATTR}="e3"><canvas id="c3" width="400" height="320"></canvas></div>` +
    '</div>' +
    '<div class="print-chart" id="p3"></div>' +
    '</div>';
}

function host(id: string): Element {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error('missing #' + id);
  }
  return el;
}

function snapshots(id: string): HTMLCanvasElement[] {
  return Array.from(host(id).querySelectorAll('canvas.' + PRINT_SNAPSHOT_CLASS)) as HTMLCanvasElement[];
}

function stubMatchMedia(matches: boolean): { fire: (next: boolean) => void } {
  const handlers: ((e: { matches: boolean }) => void)[] = [];
  const mq = {
    matches,
    media: 'print',
    addEventListener: (_: string, h: (e: { matches: boolean }) => void) => {
      handlers.push(h);
    },
    removeEventListener: () => undefined,
  };
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => mq,
  });
  return {
    fire: (next: boolean) => {
      mq.matches = next;
      for (const h of handlers.slice()) {
        h({ matches: next });
      }
    },
  };
}

beforeEach(() => {
  drawn.length = 0;
  hoisted.instances.clear();
  stubCanvas();
  __resetPrintLayoutForTest();
  stubMatchMedia(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetPrintLayoutForTest();
  document.body.innerHTML = '';
});

describe('打印光栅的 DPI 契约（纯函数）', () => {
  it('接口宽度 400 / 449 / 1169 换算到 186mm 可打印宽都 ≥ 250 DPI', () => {
    for (const width of [400, 449, 700, 1169]) {
      const plan = snapshotPlan(width, 300);
      const dpi = plan.widthPx / PRINTABLE_WIDTH_IN;
      expect(dpi, `cssWidth=${width} → ${plan.widthPx}px`).toBeGreaterThanOrEqual(250);
      expect(plan.pixelRatio).toBe(printPixelRatio(width));
    }
  });

  it('像素比被夹在 [1, 6]，且目标宽度就是 PRINT_TARGET_RASTER_PX', () => {
    expect(PRINT_MIN_PIXEL_RATIO).toBe(1);
    // 又宽又大时不再放大：1169 * 2 ≈ 2338，接近 2200 的目标值
    expect(printPixelRatio(1169)).toBe(2);
    expect(printPixelRatio(449)).toBe(5);
    expect(printPixelRatio(20)).toBe(PRINT_MAX_PIXEL_RATIO);
    expect(printPixelRatio(100000)).toBe(PRINT_MIN_PIXEL_RATIO);
    expect(PRINT_TARGET_RASTER_PX).toBeGreaterThan(2000);
  });

  it('非法尺寸不会造出 NaN / 0 像素的光栅', () => {
    expect(printPixelRatio(0)).toBe(PRINT_MIN_PIXEL_RATIO);
    expect(printPixelRatio(-3)).toBe(PRINT_MIN_PIXEL_RATIO);
    expect(printPixelRatio(Number.NaN)).toBe(PRINT_MIN_PIXEL_RATIO);
    expect(snapshotPlan(0, 100)).toEqual({ pixelRatio: 1, widthPx: 0, heightPx: 0 });
    expect(snapshotPlan(100, Number.NaN).heightPx).toBe(0);
  });
});

describe('capturePrintSnapshots', () => {
  it('按卡片分组：控制图那两块的位图纵向拼成一张（不是各出一张）', () => {
    buildPage();
    const calls: unknown[] = [];
    hoisted.instances.set(host('p1').children[0], fakeInstance(2400, 1800, calls));
    hoisted.instances.set(host('p1').children[1], fakeInstance(2400, 1200, calls));
    hoisted.instances.set(host('p2').children[0], fakeInstance(2400, 1920, calls));

    const count = capturePrintSnapshots(document);

    expect(count).toBe(2);
    const p1 = snapshots('p1');
    expect(p1).toHaveLength(1);
    expect(p1[0].width).toBe(2400);
    expect(p1[0].height).toBe(3000);
    expect(host('p1').classList.contains(PRINT_SNAPSHOT_HOST_CLASS)).toBe(true);
    // 空卡片（柏拉图空态那种）不产生快照
    expect(host('p3').classList.contains(PRINT_SNAPSHOT_HOST_CLASS)).toBe(false);
    expect(snapshots('p3')).toHaveLength(0);
  });

  it('用 ECharts 的 getRenderedCanvas 按计划像素比 + 白底光栅化', () => {
    buildPage();
    const calls: { pixelRatio?: number; backgroundColor?: string }[] = [];
    hoisted.instances.set(host('p2').children[0], fakeInstance(2400, 1920, calls));

    capturePrintSnapshots(document);

    expect(calls).toHaveLength(1);
    expect(calls[0].backgroundColor).toBe(PRINT_SNAPSHOT_BACKGROUND);
    expect(calls[0].pixelRatio).toBe(printPixelRatio(400));
  });

  it('拿不到 ECharts 实例时退化：直接搬原画布像素，绝不产出空白', () => {
    buildPage();
    const count = capturePrintSnapshots(document);
    // p1（2 块画布）与 p2（1 块画布）各出一张；p3 没有画布不参与。
    expect(count).toBe(2);
    const p2 = snapshots('p2');
    expect(p2).toHaveLength(1);
    expect(p2[0].width).toBe(400);
    expect(p2[0].height).toBe(320);
    // 先铺白底再贴图（白底 + 原图 = 2 次绘制）
    expect(drawn.length).toBeGreaterThanOrEqual(2);
  });

  it('幂等：打印事件被重复派发也不会叠加出第二张快照', () => {
    buildPage();
    expect(capturePrintSnapshots(document)).toBe(2);
    expect(capturePrintSnapshots(document)).toBe(0);
    expect(snapshots('p1')).toHaveLength(1);
    expect(snapshots('p2')).toHaveLength(1);
  });

  it('restorePrintSnapshots 可独立调用：摘掉快照并清掉宿主类', () => {
    buildPage();
    capturePrintSnapshots(document);
    expect(snapshots('p1')).toHaveLength(1);
    restorePrintSnapshots(document);
    expect(snapshots('p1')).toHaveLength(0);
    expect(host('p1').classList.contains(PRINT_SNAPSHOT_HOST_CLASS)).toBe(false);
  });

  it('stackRasters 对空数组返回 null（不抛错）', () => {
    expect(stackRasters([], document)).toBeNull();
  });
});

describe('ensurePrintSnapshotBinding', () => {
  it('★ 核心护栏：beforeprint 返回时快照必须已经同步在 DOM 里（禁止异步）', () => {
    buildPage();
    expect(ensurePrintSnapshotBinding(window)).toBe(true);

    window.dispatchEvent(new Event('beforeprint'));
    // 注意：这里没有任何 await / act / 微任务让出 —— 断言必须立刻成立。
    expect(snapshots('p1')).toHaveLength(1);
    expect(snapshots('p2')).toHaveLength(1);

    window.dispatchEvent(new Event('afterprint'));
    expect(snapshots('p1')).toHaveLength(0);
    expect(host('p1').classList.contains(PRINT_SNAPSHOT_HOST_CLASS)).toBe(false);
  });

  it("matchMedia('print') 的 change 同样同步驱动（真实 Chrome 会派发这条）", () => {
    buildPage();
    const media = stubMatchMedia(false);
    __resetPrintLayoutForTest();
    ensurePrintSnapshotBinding(window);

    media.fire(true);
    expect(snapshots('p2')).toHaveLength(1);
    media.fire(false);
    expect(snapshots('p2')).toHaveLength(0);
  });

  it('重复调用只绑定一次（不会把监听器叠加成 N 份）', () => {
    buildPage();
    expect(ensurePrintSnapshotBinding(window)).toBe(true);
    expect(ensurePrintSnapshotBinding(window)).toBe(false);
  });

  it('已经有快照时 afterprint 恢复干净，再 beforeprint 仍能重新打上', () => {
    buildPage();
    ensurePrintSnapshotBinding(window);
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('afterprint'));
    window.dispatchEvent(new Event('beforeprint'));
    expect(snapshots('p1')).toHaveLength(1);
  });
});

describe('isPrintingNow', () => {
  it('无 matchMedia 时恒为 false（jsdom / 老浏览器）', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    expect(isPrintingNow()).toBe(false);
  });

  it('matchMedia 抛错时不把打印流程带崩', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('boom');
      },
    });
    expect(isPrintingNow()).toBe(false);
  });
});
