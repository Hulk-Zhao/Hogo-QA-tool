// @vitest-environment jsdom
/**
 * chartImageCollector 测试（P3-D）。
 *
 * 证伪立场：
 *  - 若把 CHART_ROOT_SELECTOR 写错 → 「按顺序采集两张卡片」变红；
 *  - 若不按卡片分组、直接扁平遍历 canvas → 控制图那组只会有 1 块画布（用例断言 2 块）；
 *  - 若丢掉 decodePngDataUrl 的校验 → 「非 PNG 一律丢弃」变红；
 *  - 若 canvas 取不到时抛错 → 「优雅降级」变红（导出不能因为图片失败而整体失败）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  collectChartImages,
  flattenCanvasesToPng,
  type CanvasLike,
} from '@/services/report/chartImageCollector';

/** 造一张最小 PNG（签名 + IHDR + IEND，CRC 置 0 即可——解码器不校验 CRC）。 */
function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(45);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes.set([8, 6, 0, 0, 0], 24);
  bytes.set([0x49, 0x45, 0x4e, 0x44], 33);
  return bytes;
}

function dataUrl(width: number, height: number): string {
  return `data:image/png;base64,${Buffer.from(pngBytes(width, height)).toString('base64')}`;
}

/** 造一个含图表卡片的报表 DOM。 */
function makeDoc(html: string): Document {
  const doc = document.implementation.createHTMLDocument('t');
  doc.body.innerHTML = html;
  return doc;
}

const TWO_CHART_CARDS = `
<div data-testid="report-charts">
  <h6 class="MuiTypography-root">图表</h6>
  <div class="MuiPaper-root">
    <p class="MuiTypography-subtitle1">控制图（外壳长度）</p>
    <div class="print-chart">
      <div class="echarts-for-react"><canvas width="1200" height="300"></canvas></div>
      <div class="echarts-for-react"><canvas width="1200" height="200"></canvas></div>
    </div>
  </div>
  <div class="MuiPaper-root">
    <p class="MuiTypography-subtitle1">能力图（直方图 + USL/LSL）</p>
    <div class="print-chart"><div><canvas width="1200" height="400"></canvas></div></div>
  </div>
</div>
`;

describe('collectChartImages', () => {
  it('按卡片顺序采集，且把同卡片的多块画布成组交给 toPng（控制图 = 2 块）', () => {
    const groups: number[] = [];
    const images = collectChartImages({
      doc: makeDoc(TWO_CHART_CARDS),
      toPng: (canvases: CanvasLike[]) => {
        groups.push(canvases.length);
        const height = canvases.reduce((sum, c) => sum + c.height, 0);
        return dataUrl(Math.max(...canvases.map((c) => c.width)), height);
      },
    });

    expect(groups).toEqual([2, 1]);
    expect(images.map((i) => i.name)).toEqual(['控制图（外壳长度）', '能力图（直方图 + USL/LSL）']);
    expect(images.map((i) => i.heightPx)).toEqual([500, 400]);
    expect(images[0].widthPx).toBe(1200);
    expect(images[0].png.length).toBeGreaterThan(8);
  });

  it('页面没有图表区 → 返回空数组（顶栏一键日报的常态）', () => {
    expect(collectChartImages({ doc: makeDoc('<div>没有图</div>'), toPng: () => dataUrl(1, 1) })).toEqual([]);
  });

  it('toPng 返回 null 或非 PNG → 该卡片被跳过，其余仍然采集', () => {
    const images = collectChartImages({
      doc: makeDoc(TWO_CHART_CARDS),
      toPng: (canvases) =>
        canvases.length === 2 ? null : 'data:image/gif;base64,R0lGOD',
    });
    expect(images).toEqual([]);

    const partial = collectChartImages({
      doc: makeDoc(TWO_CHART_CARDS),
      toPng: (canvases) => (canvases.length === 2 ? dataUrl(10, 10) : null),
    });
    expect(partial.map((i) => i.name)).toEqual(['控制图（外壳长度）']);
  });

  it('卡片里没有 canvas（例如柏拉图空态）→ 不产生图片', () => {
    const images = collectChartImages({
      doc: makeDoc(`
        <div data-testid="report-charts">
          <div class="MuiPaper-root">
            <p class="MuiTypography-subtitle1">柏拉图（80% 分界线）</p>
            <div class="MuiAlert-root">当前数据集无不良记录，无法生成柏拉图。</div>
          </div>
        </div>
      `),
      toPng: () => dataUrl(10, 10),
    });
    expect(images).toEqual([]);
  });

  it('flattenCanvasesToPng 在无 2D 上下文的环境优雅返回 null（不抛错）', () => {
    const fake = { width: 10, height: 10 };
    expect(flattenCanvasesToPng([])).toBeNull();
    expect(flattenCanvasesToPng([fake])).toBeNull();
  });

  it('flattenCanvasesToPng 真的把多块画布按高度拼成一张白底 PNG', () => {
    const drawn: { y: number; h: number }[] = [];
    const created: HTMLCanvasElement[] = [];
    const origCreate = document.createElement.bind(document);
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag) as HTMLCanvasElement;
      if (tag === 'canvas') {
        created.push(el);
        Object.defineProperty(el, 'getContext', {
          value: () => ({
            fillStyle: '',
            fillRect: () => undefined,
            drawImage: (src: { height: number }) => drawn.push({ y: drawn.length, h: src.height }),
          }),
        });
        Object.defineProperty(el, 'toDataURL', { value: () => 'data:image/png;base64,AA' });
      }
      return el;
    });
    try {
      const out = flattenCanvasesToPng([
        { width: 800, height: 300 },
        { width: 800, height: 200 },
      ]);
      expect(out).toBe('data:image/png;base64,AA');
      expect(created[0].width).toBe(800);
      expect(created[0].height).toBe(500);
      expect(drawn.map((d) => d.h)).toEqual([300, 200]);
    } finally {
      spy.mockRestore();
    }
  });
});
