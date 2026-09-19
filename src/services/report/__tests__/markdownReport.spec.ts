/**
 * markdownReport 测试（P1-01；T05 验收要点 5）。
 *
 * 验证：Markdown 结构、CPK 表、不良表、结论/建议、null → 「—」。
 */

import { describe, expect, it } from 'vitest';
import {
  buildCpkTable,
  buildConclusions,
  buildDefectTable,
  buildMarkdownReport,
  buildSuggestions,
  fmtIndex,
} from '../markdownReport';
import type { ReportModel } from '../../../data/exporter/reportModel';

function makeModel(overrides: Partial<ReportModel> = {}): ReportModel {
  return {
    projectName: '测试项目',
    generatedAt: '2026-09-18T10:00:00.000Z',
    cpkSummary: [
      {
        characteristic: '外壳长度',
        n: 50,
        mean: 50.05,
        sigmaWithin: 0.05,
        sigmaOverall: 0.06,
        usl: 50.3,
        lsl: 49.7,
        ca: 0.1,
        cp: 2.0,
        cpk: 1.8,
        pp: 1.7,
        ppk: 1.5,
        sigmaLevelShort: 5.4,
        sigmaLevelBench: 6.9,
        ppmOverall: 100,
      },
      {
        characteristic: '转轴直径',
        n: 50,
        mean: 10.02,
        sigmaWithin: 0.1,
        sigmaOverall: 0.12,
        usl: 10.2,
        lsl: 9.8,
        ca: 0.2,
        cp: 1.0,
        cpk: 0.8,
        pp: 0.9,
        ppk: 0.7,
        sigmaLevelShort: 2.4,
        sigmaLevelBench: 3.9,
        ppmOverall: 5000,
      },
    ],
    defectStats: [
      { defectType: '划伤', count: 320, ratio: 38.19, cumRatio: 38.19 },
      { defectType: '尺寸超差', count: 215, ratio: 25.66, cumRatio: 63.85 },
      { defectType: '毛边', count: 148, ratio: 17.66, cumRatio: 81.51 },
    ],
    rawDimensions: [],
    rawDefects: [],
    warnings: [],
    ...overrides,
  };
}

describe('fmtIndex', () => {
  it('null → 「—」', () => {
    expect(fmtIndex(null)).toBe('—');
  });
  it('数字保留 3 位去尾零', () => {
    expect(fmtIndex(1.8)).toBe('1.8');
    expect(fmtIndex(1.2345)).toBe('1.234');
  });
});

describe('buildCpkTable', () => {
  it('含表头与数据行', () => {
    const md = buildCpkTable(makeModel().cpkSummary);
    expect(md).toContain('| 特性 |');
    expect(md).toContain('外壳长度');
    expect(md).toContain('转轴直径');
  });

  it('空数据 → 提示文案', () => {
    expect(buildCpkTable([])).toContain('CPK 汇总为空');
  });

  it('Cpk 判定列正确（1.8 优秀 / 0.8 不合格）', () => {
    const md = buildCpkTable(makeModel().cpkSummary);
    expect(md).toContain('优秀');
    expect(md).toContain('不合格');
  });
});

describe('buildDefectTable', () => {
  it('含表头与不良类型', () => {
    const md = buildDefectTable(makeModel().defectStats);
    expect(md).toContain('| 不良类型 |');
    expect(md).toContain('划伤');
  });
  it('空数据 → 提示文案', () => {
    expect(buildDefectTable([])).toContain('无不良记录');
  });
});

describe('buildConclusions / buildSuggestions', () => {
  it('结论指出最低能力特性', () => {
    const c = buildConclusions(makeModel());
    expect(c).toContain('转轴直径');
  });
  it('建议 ≤ 3 条且含优先级', () => {
    const s = buildSuggestions(makeModel());
    const lines = s.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeLessThanOrEqual(3);
    expect(s).toContain('【高】');
  });
});

describe('buildMarkdownReport', () => {
  it('含标题与五个小节', () => {
    const md = buildMarkdownReport(makeModel(), '本次为试产数据');
    expect(md).toContain('# 质量分析报告 —— 测试项目');
    expect(md).toContain('## 一、摘要');
    expect(md).toContain('## 二、能力指数汇总');
    expect(md).toContain('## 三、不良统计');
    expect(md).toContain('## 四、结论');
    expect(md).toContain('## 五、建议');
    expect(md).toContain('本次为试产数据');
  });

  it('warnings 以提示形式展示', () => {
    const md = buildMarkdownReport(makeModel({ warnings: ['数据集不含不良记录'] }));
    expect(md).toContain('数据集不含不良记录');
  });
});
