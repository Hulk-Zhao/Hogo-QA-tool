/**
 * printLayout —— 打印 / PDF 下的「同步光栅快照」引擎（P4-A 重写）。
 *
 * ==================== 缺陷史与真实根因（务必保留） ====================
 * 用户第一次反馈：「打印为 PDF 图表效果不好，界面太小」。
 * P3 的修法是订阅 beforeprint / afterprint / matchMedia('print')，打印期间把图表
 * **重新挂载**成 700px 宽 + devicePixelRatio 3 的打印版面（`key={printing ? 'print' : 'screen'}`）。
 *
 * P3 的探针之所以全部 ok=true，是因为它们在 `Page.printToPDF` 之前先执行了
 * `Emulation.setEmulatedMedia({media:'print'})` 并 sleep(1500) —— 等于提前完成了
 * 打印态的重排与重绘。真实 Ctrl+P 没有这一段，所以那些 ok 是**假阳性**。
 *
 * 用户第二次反馈：「现在报表打印和 excel 导出都没有图片」（附打印预览截图，
 * 「控制图」卡片内一片空白）。改用真实路径复现（`.probe/p4-print-truth.mjs`，
 * 不预置 print 媒体、不 sleep），拿到的事件时间线：
 *
 *   3069ms beforeprint       `.print-chart canvas` = 3 块（还是屏幕那张 449×300）
 *   3097ms mq-change(true)   `.print-chart canvas` = 0 块  ← 旧图被卸载、新图还没画
 *   3204ms afterprint        `.print-chart canvas` = 0 块
 *
 * 结论：Chrome 取打印快照时 DOM 里**根本没有画布**。根因是「卸载 + 重挂载」
 * 这条路本身依赖异步：React 提交之后 zrender 还要重绘，组件上又挂着
 * `lazyUpdate`（把 setOption 推迟到下一帧）。异步必然慢过快照 → 纸上空白。
 *
 * ==================== P4 的对策 ====================
 * **完全不碰 React**，在打印事件回调里同步完成三件事：
 *   1. 对每张 `.print-chart` 里已渲染好的画布调用
 *      `echartsInstance.getRenderedCanvas({ pixelRatio, backgroundColor })`
 *      —— 同步 API，按当前 option 直接重画一张更高像素比的位图；
 *   2. 同一张卡片里的多块画布（控制图 = X 图 + R 图）纵向拼成一张白底画布；
 *   3. 把拼好的**画布元素本身**（不是 `<img>`！data URL 解码是异步的）插进
 *      `.print-chart`，并给宿主加 `.has-print-snapshot`。
 * 全程同步、无微任务、无 requestAnimationFrame，Chrome 取快照时必然已就位；
 * `afterprint` 原样移除，屏幕态完全不受影响。
 *
 * 顺带解决「界面太小」与「96 DPI 发虚」：位图按「逻辑宽 → 约 2200px」自动选
 * 1~6 倍像素比，打印时以 `width:100%` 铺满 A4 可打印区（见 `src/print.css`）。
 */

import { getInstanceByDom } from 'echarts';

/** 打印快照画布的类名（`src/print.css` 里靠它顶替原图表）。 */
export const PRINT_SNAPSHOT_CLASS = 'print-chart-snapshot';

/** 打了快照的 `.print-chart` 宿主类名（幂等标记 + CSS 挂钩）。 */
export const PRINT_SNAPSHOT_HOST_CLASS = 'has-print-snapshot';

/** 图表卡片内承载画布的容器（与 chartImageCollector 共用同一约定）。 */
export const PRINT_PLOT_SELECTOR = '.print-chart';

/** ECharts 在容器 DOM 上留下的实例标记属性。 */
export const ECHARTS_INSTANCE_ATTR = '_echarts_instance_';

/**
 * 目标光栅宽度（px）。A4 可打印宽 186mm；2200px / (186/25.4)in ≈ 300 DPI，
 * 与印刷要求的 200~300 DPI 对齐。
 */
export const PRINT_TARGET_RASTER_PX = 2200;

/** 像素比下限（已经足够宽的大画布不再放大，避免无谓的内存翻倍）。 */
export const PRINT_MIN_PIXEL_RATIO = 1;

/** 像素比上限（1 张 449px 宽的图 → 5 倍 ≈ 2245px；再高只会吃内存不涨清晰度）。 */
export const PRINT_MAX_PIXEL_RATIO = 6;

/** 打印快照的底色（zrender 画布是透明底，透明进 PDF/Excel 观感不可控）。 */
export const PRINT_SNAPSHOT_BACKGROUND = '#ffffff';

/** 一次光栅的计划（纯函数产物，便于单测 DPI 契约）。 */
export interface SnapshotPlan {
  /** 像素比 */
  pixelRatio: number;
  /** 光栅宽度（px） */
  widthPx: number;
  /** 光栅高度（px） */
  heightPx: number;
}

/**
 * 按逻辑宽度选像素比：让光栅宽度尽量接近 `PRINT_TARGET_RASTER_PX`。
 *
 * @param cssWidth 画布的 CSS 宽度（px）
 * @returns 像素比（闭区间 [PRINT_MIN_PIXEL_RATIO, PRINT_MAX_PIXEL_RATIO]）
 */
export function printPixelRatio(cssWidth: number): number {
  if (!Number.isFinite(cssWidth) || cssWidth <= 0) {
    return PRINT_MIN_PIXEL_RATIO;
  }
  const ideal = PRINT_TARGET_RASTER_PX / cssWidth;
  return Math.min(PRINT_MAX_PIXEL_RATIO, Math.max(PRINT_MIN_PIXEL_RATIO, Math.round(ideal)));
}

/**
 * 生成一次光栅计划（纯函数）。
 *
 * @param cssWidth 逻辑宽度（px）
 * @param cssHeight 逻辑高度（px）
 * @returns 计划；逻辑尺寸非法时退化为 0 尺寸（调用方应跳过该画布）
 */
export function snapshotPlan(cssWidth: number, cssHeight: number): SnapshotPlan {
  const ratio = printPixelRatio(cssWidth);
  if (!Number.isFinite(cssWidth) || cssWidth <= 0 || !Number.isFinite(cssHeight) || cssHeight <= 0) {
    return { pixelRatio: PRINT_MIN_PIXEL_RATIO, widthPx: 0, heightPx: 0 };
  }
  return {
    pixelRatio: ratio,
    widthPx: Math.max(1, Math.round(cssWidth * ratio)),
    heightPx: Math.max(1, Math.round(cssHeight * ratio)),
  };
}

/** 当前是否处于打印媒体（jsdom / 老浏览器无 matchMedia 时恒为 false）。 */
export function isPrintingNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('print').matches;
  } catch {
    return false;
  }
}

/** 取画布所属的 ECharts 实例（拿不到时返回 undefined，调用方退化处理）。 */
function instanceOf(canvas: HTMLCanvasElement) {
  const host = canvas.closest(`[${ECHARTS_INSTANCE_ATTR}]`);
  if (!host) {
    return undefined;
  }
  try {
    return getInstanceByDom(host as HTMLElement);
  } catch {
    return undefined;
  }
}

/**
 * 把一块画布光栅成高分辨率位图（同步）。
 *
 * 优先走 ECharts 的 `getRenderedCanvas`（按当前 option 重画，清晰）；
 * 实例拿不到时退化为「直接搬像素」——分辨率低，但**绝不返回空白**。
 *
 * @param canvas 页面上的画布
 * @param host 用于创建元素的 document
 * @returns 位图；无法光栅时 null
 */
function rasterize(
  canvas: HTMLCanvasElement,
  host: Document,
): HTMLCanvasElement | null {
  const rect = typeof canvas.getBoundingClientRect === 'function'
    ? canvas.getBoundingClientRect()
    : ({ width: canvas.width, height: canvas.height } as DOMRect);
  const cssWidth = rect.width > 0 ? rect.width : canvas.width;
  const cssHeight = rect.height > 0 ? rect.height : canvas.height;
  const plan = snapshotPlan(cssWidth, cssHeight);
  if (plan.widthPx <= 0 || plan.heightPx <= 0) {
    return null;
  }

  const instance = instanceOf(canvas);
  if (instance && typeof instance.getRenderedCanvas === 'function') {
    try {
      const rendered = instance.getRenderedCanvas({
        pixelRatio: plan.pixelRatio,
        backgroundColor: PRINT_SNAPSHOT_BACKGROUND,
      });
      if (rendered && rendered.width > 0 && rendered.height > 0) {
        return rendered;
      }
    } catch {
      // 退化到下面的直接搬运
    }
  }

  if (canvas.width <= 0 || canvas.height <= 0) {
    return null;
  }
  const out = host.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = PRINT_SNAPSHOT_BACKGROUND;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(canvas, 0, 0);
  return out;
}

/**
 * 把同一张卡片里的多块位图纵向拼成一张白底画布（同步）。
 *
 * 用「新建画布 + drawImage 拷贝」而不是直接把 ECharts 返回的画布插进 DOM：
 * zrender 的画布可能来自它自己的画布池，交给它继续复用会有被改写的风险。
 *
 * @param parts 位图（至少 1 块）
 * @param host 用于创建元素的 document
 * @returns 拼接后的画布；失败时 null
 */
export function stackRasters(
  parts: HTMLCanvasElement[],
  host: Document,
): HTMLCanvasElement | null {
  if (parts.length === 0) {
    return null;
  }
  const width = Math.max(...parts.map((p) => p.width));
  const height = parts.reduce((sum, p) => sum + p.height, 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  const out = host.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = PRINT_SNAPSHOT_BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (const part of parts) {
    ctx.drawImage(part, 0, y);
    y += part.height;
  }
  return out;
}

/**
 * 同步采集并挂上打印快照。幂等：已经打过快照的卡片直接跳过。
 *
 * @param doc 文档（默认当前 document）
 * @returns 打上快照的图表张数
 */
export function capturePrintSnapshots(doc?: Document): number {
  const d = doc ?? (typeof document === 'undefined' ? null : document);
  if (!d) {
    return 0;
  }
  let count = 0;
  for (const plot of Array.from(d.querySelectorAll(PRINT_PLOT_SELECTOR))) {
    if (plot.classList.contains(PRINT_SNAPSHOT_HOST_CLASS)) {
      continue;
    }
    const canvases = Array.from(plot.querySelectorAll('canvas')).filter(
      (cv) => !cv.classList.contains(PRINT_SNAPSHOT_CLASS),
    );
    if (canvases.length === 0) {
      continue;
    }
    const parts: HTMLCanvasElement[] = [];
    for (const cv of canvases) {
      const raster = rasterize(cv, d);
      if (raster) {
        parts.push(raster);
      }
    }
    const stacked = stackRasters(parts, d);
    if (!stacked) {
      continue;
    }
    stacked.classList.add(PRINT_SNAPSHOT_CLASS);
    plot.appendChild(stacked);
    plot.classList.add(PRINT_SNAPSHOT_HOST_CLASS);
    count += 1;
  }
  return count;
}

/**
 * 撤掉所有打印快照，恢复屏幕态。
 *
 * @param doc 文档（默认当前 document）
 */
export function restorePrintSnapshots(doc?: Document): void {
  const d = doc ?? (typeof document === 'undefined' ? null : document);
  if (!d) {
    return;
  }
  for (const plot of Array.from(d.querySelectorAll(`.${PRINT_SNAPSHOT_HOST_CLASS}`))) {
    plot.classList.remove(PRINT_SNAPSHOT_HOST_CLASS);
    for (const el of Array.from(plot.querySelectorAll(`canvas.${PRINT_SNAPSHOT_CLASS}`))) {
      el.remove();
    }
  }
}

let bound = false;
/** 仅供用例复位模块级绑定状态。 */
let boundWindow: Window | null = null;

/**
 * 绑定打印事件（只绑一次）。必须在应用挂载时调用一次
 * （见 `src/ui/layout/AppShell.tsx`）。
 *
 * 为什么不放在 hook 里：快照引擎不依赖 React 渲染，挂在模块级单例上最稳，
 * 也不会因为「某个图表组件恰好没挂载」而漏掉别的图表。
 *
 * @param target 目标 window（默认当前 window；用例可注入）
 * @returns 是否完成了绑定（已绑定过 / 无 window 时 false）
 */
export function ensurePrintSnapshotBinding(target?: Window): boolean {
  const win = target ?? (typeof window === 'undefined' ? null : (window as Window));
  if (!win || (bound && boundWindow === win)) {
    return false;
  }
  bound = true;
  boundWindow = win;

  const enter = (): void => {
    capturePrintSnapshots();
  };
  const leave = (): void => {
    restorePrintSnapshots();
  };

  // 页面一开始就处于打印媒体（少见但要正确）：直接先打一次快照。
  if (isPrintingNow()) {
    enter();
  }
  win.addEventListener('beforeprint', enter);
  win.addEventListener('afterprint', leave);
  if (typeof win.matchMedia === 'function') {
    try {
      const mq = win.matchMedia('print');
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', (e: MediaQueryListEvent) => {
          if (e.matches) {
            enter();
          } else {
            leave();
          }
        });
      }
    } catch {
      // matchMedia 不可用：beforeprint / afterprint 仍是兜底
    }
  }
  return true;
}

/** 仅测试用：把模块状态复位（用例之间必须归零，否则绑定会串场）。 */
export function __resetPrintLayoutForTest(): void {
  bound = false;
  boundWindow = null;
}
