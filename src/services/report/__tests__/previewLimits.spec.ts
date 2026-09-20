/**
 * previewLimits 测试（P6-B）。
 *
 * 证伪立场：
 *  - 若把 `PRINT_PREVIEW_LIMIT` 改成其它值而**不同步**改 print.css 的
 *    `nth-child(n + N)`：第 1 组变红（CSS 与常量必须成对）；
 *  - 若有人为了「省事」把打印行数上限规则挪出 `@media print`：第 1 组变红
 *    （那会连屏幕预览一起截断）；
 *  - 若把长表在打印态重新变成不可拆分（回到整块推页）→ 第 2 组变红，
 *    这正是「第 3 页尾部空 8.5cm」的成因。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRINT_PREVIEW_LIMIT, RAW_PREVIEW_LIMIT } from '../previewLimits';

const CSS_PATH = path.join(process.cwd(), 'src', 'print.css');
const CSS_RAW = readFileSync(CSS_PATH, 'utf8');
/** 去掉注释再解析：注释里出现的 `{` `}` 会骗过朴素的括号计数。 */
const CSS = CSS_RAW.replace(/\/\*[\s\S]*?\*\//g, '');

/** 返回 index 处所处的块头链（从外到内）。 */
function openBlockHeaders(css: string, index: number): string[] {
  const stack: string[] = [];
  let header = '';
  for (let i = 0; i < index && i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      stack.push(header.trim());
      header = '';
    } else if (ch === '}') {
      stack.pop();
      header = '';
    } else if (ch === ';') {
      header = '';
    } else {
      header += ch;
    }
  }
  return stack;
}

/**
 * 取 selectorIndex 处那条规则的声明列表（按 `;` 切成「一条一声明」）。
 *
 * 为什么不能直接 `toContain('break-inside: auto !important')`：
 * `page-break-inside: auto !important` 里**包含**这个子串，用子串断言会让
 * 「把 break-inside 改成 avoid」的变异活下来（实测被 M49 抓到过）。
 */
function declarationsOf(css: string, selectorIndex: number): string[] {
  const open = css.indexOf('{', selectorIndex);
  const close = css.indexOf('}', open);
  return css
    .slice(open + 1, close)
    .split(';')
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter((d) => d.length > 0);
}

describe('previewLimits —— 屏幕 / 打印两套行数上限', () => {
  it('★ 打印上限与 print.css 的 nth-child 上限成对（改一个不改另一个必红）', () => {
    expect(PRINT_PREVIEW_LIMIT).toBeGreaterThan(0);
    expect(PRINT_PREVIEW_LIMIT).toBeLessThan(RAW_PREVIEW_LIMIT);

    const selector = `.print-table-split tbody tr:nth-child(n + ${PRINT_PREVIEW_LIMIT + 1})`;
    const at = CSS.indexOf(selector);
    expect(at, `print.css 里必须有 ${selector}`).toBeGreaterThan(-1);

    // 必须只作用于打印态：挪出 @media print 会连屏幕预览一起截断。
    const chain = openBlockHeaders(CSS, at);
    expect(chain.some((h) => h.startsWith('@media print'))).toBe(true);
    // 且必须真的隐藏（只写选择器不写声明是空转）。
    expect(declarationsOf(CSS, at)).toContain('display: none !important');
  });

  it('★ 预览长表在打印态可跨页（第 3 页尾部空 8.5cm 的成因就是「整块推页」）', () => {
    const at = CSS.indexOf('.print-table-split,');
    expect(at).toBeGreaterThan(-1);
    const chain = openBlockHeaders(CSS, at);
    expect(chain.some((h) => h.startsWith('@media print'))).toBe(true);

    const groupDecls = declarationsOf(CSS, at);
    expect(groupDecls).toContain('break-inside: auto !important');
    expect(groupDecls).toContain('page-break-inside: auto !important');

    // 限高与滚动必须一起去掉，否则表格仍是一个 320px 的原子块。
    const scrollAt = CSS.indexOf('.print-table-split .MuiTableContainer-root {');
    expect(scrollAt).toBeGreaterThan(-1);
    const scrollDecls = declarationsOf(CSS, scrollAt);
    expect(scrollDecls).toContain('max-height: none !important');
    expect(scrollDecls).toContain('overflow: visible !important');
  });
});