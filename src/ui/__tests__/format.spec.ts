/**
 * 数值格式化测试（架构文档 §8.2）。
 *
 * 覆盖要求（T03）：
 * - 4 位（均值/σ/指数）、2 位（西格玛水平/占比）、PPM 整数；
 * - null / undefined / NaN / Infinity 的语义：
 *   能力指数显示 'N/A'，一般单元格显示 '—'，**绝不用 0 或 999 冒充**。
 *
 * 注意：本文件不重复验证 core 公式（那是 T01 的职责），只验证展示边界。
 */

import { describe, expect, it } from 'vitest';
import {
  DECIMALS_INDEX,
  DECIMALS_RATIO,
  DECIMALS_SIGMA,
  DASH_TEXT,
  NA_TEXT,
  formatIndex,
  formatNumber,
  formatPpm,
  formatRatio,
  formatSigmaLevel,
  isRenderable,
} from '@/ui/format';

describe('精度常量', () => {
  it('指数 4 位、西格玛水平 2 位、占比 2 位', () => {
    expect(DECIMALS_INDEX).toBe(4);
    expect(DECIMALS_SIGMA).toBe(2);
    expect(DECIMALS_RATIO).toBe(2);
  });
});

describe('isRenderable', () => {
  it('有限数为 true，其余 false', () => {
    expect(isRenderable(0)).toBe(true);
    expect(isRenderable(-1.5)).toBe(true);
    expect(isRenderable(NaN)).toBe(false);
    expect(isRenderable(Infinity)).toBe(false);
    expect(isRenderable(-Infinity)).toBe(false);
    expect(isRenderable(null)).toBe(false);
    expect(isRenderable(undefined)).toBe(false);
  });
});

describe('formatIndex —— 能力指数（4 位）', () => {
  it('正常值保留 4 位小数', () => {
    expect(formatIndex(1.23456)).toBe('1.2346');
    expect(formatIndex(1.5)).toBe('1.5000');
  });

  it('null / undefined / NaN 显示 N/A（单侧规格场景）', () => {
    expect(formatIndex(null)).toBe(NA_TEXT);
    expect(formatIndex(undefined)).toBe(NA_TEXT);
    expect(formatIndex(NaN)).toBe(NA_TEXT);
  });

  it('0 是有效值，显示 0.0000 而非 N/A', () => {
    expect(formatIndex(0)).toBe('0.0000');
  });

  it('绝不用 999 冒充不可计算', () => {
    expect(formatIndex(null)).not.toContain('999');
  });
});

describe('formatSigmaLevel —— 西格玛水平（2 位）', () => {
  it('保留 2 位小数', () => {
    expect(formatSigmaLevel(4.006)).toBe('4.01');
    expect(formatSigmaLevel(4.004)).toBe('4.00');
    expect(formatSigmaLevel(3)).toBe('3.00');
  });

  it('不可计算显示 —', () => {
    expect(formatSigmaLevel(null)).toBe(DASH_TEXT);
    expect(formatSigmaLevel(NaN)).toBe(DASH_TEXT);
  });
});

describe('formatRatio —— 占比（2 位，带 %）', () => {
  it('保留 2 位并加百分号', () => {
    expect(formatRatio(81.5)).toBe('81.50%');
    expect(formatRatio(0)).toBe('0.00%');
    expect(formatRatio(100)).toBe('100.00%');
  });

  it('不可计算显示 —', () => {
    expect(formatRatio(null)).toBe(DASH_TEXT);
  });
});

describe('formatPpm —— PPM 整数', () => {
  it('四舍五入到整数', () => {
    expect(formatPpm(1234.6)).toBe('1235');
    expect(formatPpm(0.4)).toBe('0');
    expect(formatPpm(12345)).toBe('12345');
  });

  it('不可计算显示 —', () => {
    expect(formatPpm(null)).toBe(DASH_TEXT);
    expect(formatPpm(Infinity)).toBe(DASH_TEXT);
  });
});

describe('formatNumber —— 通用', () => {
  it('默认占位为 —', () => {
    expect(formatNumber(null, 4)).toBe(DASH_TEXT);
  });

  it('可指定占位文案', () => {
    expect(formatNumber(null, 4, NA_TEXT)).toBe(NA_TEXT);
  });

  it('按给定小数位格式化', () => {
    expect(formatNumber(2.5, 2)).toBe('2.50');
    expect(formatNumber(2.5, 0)).toBe('3');
  });
});
