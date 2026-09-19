/**
 * printPagination —— 打印分页护栏（P4-A 二次验证新增）。
 *
 * 为什么用「读源码」而不是组件断言：这条缺陷只存在于 Chrome 的**打印分页**里
 * （jsdom 没有分页引擎），任何组件级断言都抓不到它。可自动化的最小护栏就是
 * 把「报表页图表区不得使用 break-before: page」这条约束锁死。
 *
 * 证伪立场（改一句源码就变红）：
 *  - 给 ReportPage 的图表 Stack 加回 className="print-page-break" → 变红；
 *  - 删掉 .print-chart / 图表卡片子元素的 break-inside: avoid → 变红
 *    （图会被拆到两页，且没有强制分页兜底）。
 *
 * 实证（.probe/p4-one.mjs，每个场景都是全新页面上的**第一次**打印）：
 *   as-is（Stack 带 print-page-break）→ 5 页，第 2 页墨迹 0.0001（全空白）
 *   去掉 break-before                 → 4 页，无空白页
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

function read(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), 'utf8');
}

const REPORT_PAGE = read('../pages/ReportPage.tsx');
const PRINT_CSS = read('../../print.css');

describe('打印分页护栏', () => {
  it('★ 报表页图表区不得使用 print-page-break（否则第一次打印会多一张全空白页）', () => {
    expect(REPORT_PAGE).not.toContain('className="print-page-break"');
    expect(REPORT_PAGE).toContain('data-testid="report-charts"');
    // 只在 JSX 属性上禁止（注释里出现这个词是在讲这条坑，属于正常文档）
  });

  it('图表区仍然有分页兜底：卡片与 .print-chart 都 break-inside: avoid', () => {
    const chartRule = PRINT_CSS.slice(PRINT_CSS.indexOf('.print-chart,'));
    expect(chartRule.split('break-inside: avoid').length - 1).toBeGreaterThanOrEqual(1);
    const stackRule = PRINT_CSS.slice(PRINT_CSS.indexOf("[data-testid='report-charts'] > *"));
    expect(stackRule.slice(0, 200)).toContain('break-inside: avoid');
  });
});
