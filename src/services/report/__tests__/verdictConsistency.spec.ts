/**
 * 判定口径一致性回归（本轮 P2-D 的**防分叉**测试）。
 *
 * 风险场景：能力页「多特性 Cpk 汇总对比」与 Markdown 报告都要输出 Cpk 判定文案。
 * 此前报告内联了一份私有实现、页面另算一份，同一个 Cpk=1.4 完全可能一处「合格」
 * 一处「优秀」——**口径分叉比缺功能更危险**（用户拿着两份结论对不上）。
 *
 * 本测试对同一批 Cpk 值断言「报告判定列 == core 的唯一真源」。
 * 证伪立场：让 markdownReport 重新内联自己的判定逻辑、或只改 core 门槛不改报告，
 * 本文件立刻变红。
 */

import { describe, expect, it } from 'vitest';
import { capabilityVerdictText } from '@/core';
import type { CpKSummaryRow } from '@/data/exporter/reportModel';
import { buildCpkTable } from '../markdownReport';

/** 覆盖五档 + 门槛附近 + 真实复现值（外壳长度 3.6521）。 */
const SWEEP: (number | null)[] = [null, -1, 0.5, 0.99, 1.0, 1.2, 1.32, 1.33, 1.4, 1.669, 1.67, 3.6521];

function makeRow(characteristic: string, cpk: number | null): CpKSummaryRow {
  return {
    characteristic,
    n: 30,
    mean: 10,
    sigmaWithin: 0.01,
    sigmaOverall: 0.012,
    usl: 10.1,
    lsl: 9.9,
    ca: 0,
    cp: cpk,
    cpk,
    pp: cpk,
    ppk: cpk,
    sigmaLevelShort: null,
    sigmaLevelBench: null,
    ppmOverall: null,
  };
}

describe('buildCpkTable —— 判定列与 core 唯一真源一致', () => {
  for (const cpk of SWEEP) {
    it('Cpk=' + String(cpk) + ' 的判定列与 capabilityVerdictText 逐字一致', () => {
      const md = buildCpkTable([makeRow('特性X', cpk)]);
      expect(md).toContain(capabilityVerdictText(cpk));
    });
  }

  it('同一份表里多行各自判定（不会串档）', () => {
    const md = buildCpkTable([makeRow('甲', 1.8), makeRow('乙', 0.8), makeRow('丙', null)]);
    expect(md).toContain(capabilityVerdictText(1.8));
    expect(md).toContain(capabilityVerdictText(0.8));
    expect(md).toContain(capabilityVerdictText(null));
  });
});
