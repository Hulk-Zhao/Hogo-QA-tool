/**
 * chartImageCollector —— 从报表页当前渲染出来的图表里取 PNG（导出 Excel 用）。
 *
 * 用户需求：2026-09-19「给导出 excel也添加图片」。
 *
 * 做法：直接读页面上**已经渲染好**的 ECharts 画布，而不是偷偷再渲染一遍——
 * 这样「导出 Excel 里的图」与「屏幕上看到的图」天然一致（同一份数据、同一份
 * option），也避免隐藏容器 0 尺寸导致空图这一老问题。
 *
 * 细节：
 *  - zrender 的画布是**透明底**，直接 toDataURL 会得到透明 PNG；Excel 里虽然
 *    也能显示，但深色主题/叠放时观感不可控。这里统一「先铺白底再贴图」。
 *  - 一张卡片可能有多块画布（控制图 = X 图 + R 图两块）；多块时**纵向拼成一张**，
 *    避免 Excel 里散成两张对不上标题的图。
 *  - 画布取不到（jsdom、被浏览器限制）时返回 null，导出侧退化为「不带图片」，
 *    绝不因为图片失败而让整个导出失败。
 */

import { decodePngDataUrl, type ChartImage } from '@/data/exporter/excelImages';

/** 报表页图表区容器。 */
export const CHART_ROOT_SELECTOR = '[data-testid="report-charts"]';

/** 一张图表卡片里承载画布的容器。 */
export const CHART_PLOT_SELECTOR = '.print-chart';

/** 参与拼图的最小画布接口（便于用例注入假画布）。 */
export interface CanvasLike {
  width: number;
  height: number;
}

/** 把一张卡片里的若干画布转成 PNG data URL。 */
export type CanvasToPng = (canvases: CanvasLike[]) => string | null;

/**
 * 把多块画布纵向拼成一张白底 PNG。
 *
 * @param canvases 画布（至少 1 块）
 * @returns PNG data URL；环境不支持时 null
 */
export function flattenCanvasesToPng(canvases: CanvasLike[]): string | null {
  if (canvases.length === 0) {
    return null;
  }
  if (typeof document === 'undefined') {
    return null;
  }
  const sources = canvases as unknown as HTMLCanvasElement[];
  const width = Math.max(...sources.map((c) => c.width));
  const height = sources.reduce((sum, c) => sum + c.height, 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  try {
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    if (!ctx) {
      // 单块画布时仍有救：直接取它自己的 data URL。
      return sources.length === 1 ? sources[0].toDataURL('image/png') : null;
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    let y = 0;
    for (const src of sources) {
      ctx.drawImage(src, 0, y);
      y += src.height;
    }
    return out.toDataURL('image/png');
  } catch {
    return null;
  }
}

/** 卡片标题（用于图片名与替换文字）。 */
function cardTitle(card: Element, fallback: string): string {
  const el = card.querySelector(
    'h1, h2, h3, h4, h5, h6, .MuiTypography-subtitle1, .MuiTypography-subtitle2',
  );
  const text = el?.textContent?.trim();
  return text && text.length > 0 ? text : fallback;
}

/**
 * 采集当前报表页上的图表图片。
 *
 * @param options.doc 文档（默认当前 document）
 * @param options.toPng 画布转 PNG（默认白底拼接实现，便于用例注入）
 * @returns 图表列表（按页面顺序）；页面上没有图表时为空数组
 */
export function collectChartImages(options?: {
  doc?: Document;
  toPng?: CanvasToPng;
}): ChartImage[] {
  const doc = options?.doc ?? (typeof document === 'undefined' ? null : document);
  if (!doc) {
    return [];
  }
  const toPng = options?.toPng ?? flattenCanvasesToPng;
  const host = doc.querySelector(CHART_ROOT_SELECTOR);
  if (!host) {
    return [];
  }

  const images: ChartImage[] = [];
  const cards = Array.from(host.children);
  cards.forEach((card, cardIndex) => {
    const title = cardTitle(card, `图表 ${cardIndex + 1}`);
    const plots = Array.from(card.querySelectorAll(CHART_PLOT_SELECTOR));
    for (const plot of plots) {
      const canvases = Array.from(plot.querySelectorAll('canvas')) as unknown as CanvasLike[];
      if (canvases.length === 0) {
        continue;
      }
      const dataUrl = toPng(canvases);
      if (!dataUrl) {
        continue;
      }
      const decoded = decodePngDataUrl(dataUrl);
      if (!decoded) {
        continue;
      }
      images.push({ ...decoded, name: title });
    }
  });
  return images;
}
