/**
 * reportModules 测试（P4-B：报表逐模块 AI 分析的输入）。
 *
 * 证伪立场：
 *  - 若控制限不再按「均值 ± 3σ_within」推导 → 「控制限可溯源」变红；
 *  - 若原始尺寸模块改成把逐条测量值塞进摘要 → 「不泄漏逐条明细」变红（数据主权）；
 *  - 若无数据的模块不再标记 unavailable → 「无数据模块被标记」变红
 *    （后果：会为无数据模块白烧一次 LLM 请求，还可能让模型编造不良类型）；
 *  - 若模块顺序变了 → 「固定 6 个模块 + 固定顺序」变红。
 */

import { describe, expect, it } from 'vitest';
import { analyzableModules, buildReportModules, controlLimits } from '../reportModules';
import type { ReportModel } from '@/data/exporter/reportModel';

function makeModel(overrides: Partial<ReportModel> = {}): ReportModel {
  return {
    projectName: '测试项目',
    generatedAt: '2026-09-19T08:00:00.000Z',
    cpkSummary: [
      {
        characteristic: '外壳长度',
        n: 60,
        mean: 50.05,
        sigmaWithin: 0.05,
        sigmaOverall: 0.07,
        usl: 50.2,
        lsl: 49.8,
        ca: 0.25,
        cp: 1.333,
        cpk: 1.1,
        pp: 0.952,
        ppk: 0.785,
        sigmaLevelShort: 3.3,
        sigmaLevelBench: 4.8,
        ppmOverall: 12345,
      },
      {
        characteristic: '转轴直径',
        n: 30,
        mean: 12.01,
        sigmaWithin: 0.01,
        sigmaOverall: 0.012,
        usl: 12.02,
        lsl: 11.98,
        ca: 0.5,
        cp: 0.667,
        cpk: 0.333,
        pp: 0.556,
        ppk: 0.278,
        sigmaLevelShort: 1.0,
        sigmaLevelBench: 2.5,
        ppmOverall: 456789,
      },
    ],
    defectStats: [
      { defectType: '毛刺', count: 30, ratio: 60, cumRatio: 60 },
      { defectType: '划伤', count: 12, ratio: 24, cumRatio: 84 },
      { defectType: '变形', count: 8, ratio: 16, cumRatio: 100 },
    ],
    rawDimensions: [
      { characteristic: '外壳长度', index: 1, value: 50.01, usl: 50.2, lsl: 49.8 },
      { characteristic: '外壳长度', index: 2, value: 50.09, usl: 50.2, lsl: 49.8 },
      { characteristic: '外壳长度', index: 3, value: 49.97, usl: 50.2, lsl: 49.8 },
      { characteristic: '转轴直径', index: 1, value: 12.03, usl: 12.02, lsl: 11.98 },
    ],
    rawDefects: [],
    warnings: [],
    ...overrides,
  };
}

describe('controlLimits', () => {
  it('中心线 = 均值，UCL/LCL = 均值 ± 3σ_within（可手算核对）', () => {
    expect(controlLimits(50.05, 0.05)).toEqual({ centerLine: 50.05, ucl: 50.2, lcl: 49.9 });
  });

  it('σ 非正 / 非有限 → null（不产出 NaN 控制限让模型胡说）', () => {
    expect(controlLimits(10, 0)).toBeNull();
    expect(controlLimits(10, -1)).toBeNull();
    expect(controlLimits(Number.NaN, 1)).toBeNull();
    expect(controlLimits(10, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('buildReportModules', () => {
  it('固定 6 个模块且顺序稳定', () => {
    const modules = buildReportModules(makeModel());
    expect(modules.map((m) => m.id)).toEqual([
      'cpk',
      'defect',
      'controlChart',
      'pareto',
      'capabilityChart',
      'rawDimensions',
    ]);
    expect(modules.map((m) => m.title)).toEqual([
      'CPK 汇总',
      '不良统计',
      '控制图',
      '柏拉图（80% 分界线）',
      '能力图（直方图 + USL/LSL）',
      '原始尺寸',
    ]);
  });

  it('CPK 模块逐字段抄自模型（不改数字、不四舍五入到失真）', () => {
    const cpk = buildReportModules(makeModel()).find((m) => m.id === 'cpk')!;
    const rows = cpk.summary.characteristics as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      characteristicName: '外壳长度',
      n: 60,
      mean: 50.05,
      sigmaWithin: 0.05,
      cpk: 1.1,
      ppk: 0.785,
      ppmOverall: 12345,
    });
    expect(cpk.unavailable).toBeNull();
  });

  it('控制图模块的控制限可溯源，且补充信息优先于推导值', () => {
    const plain = buildReportModules(makeModel()).find((m) => m.id === 'controlChart')!;
    const first = (plain.summary.characteristics as Record<string, unknown>[])[0];
    expect(first).toMatchObject({ centerLine: 50.05, ucl: 50.2, lcl: 49.9, controlChartAvailable: true });

    const enriched = buildReportModules(makeModel(), {
      controlChart: {
        characteristicName: '外壳长度',
        centerLine: 50.05,
        ucl: 50.15,
        lcl: 49.95,
        violations: [{ rule: '第 9 点超出 UCL', pointIndex: 8 }],
      },
    }).find((m) => m.id === 'controlChart')!;
    expect(enriched.summary.violationCount).toBe(1);
    // ★ 判异点必须挂到特性名下 + 子组号从 1 起（面向人）。
    // 依据：用户实测截图里模型写「第 22 点落 A 区…摘要未指明归属特性」。
    expect(enriched.summary.focusedCharacteristic).toMatchObject({
      ucl: 50.15,
      characteristicName: '外壳长度',
      violationCount: 1,
      violations: [
        { rule: '第 9 点超出 UCL', subgroupIndex: 9, characteristicName: '外壳长度' },
      ],
    });
  });

  it('未提供判异结果时明确禁止模型声称「某点超限」', () => {
    const plain = buildReportModules(makeModel()).find((m) => m.id === 'controlChart')!;
    expect(plain.summary.violationCount).toBeNull();
    expect(String(plain.summary.violationsNote)).toContain('禁止');
  });

  it('柏拉图模块只把累计占比 <= 80% 的类型放进 withinCutLine', () => {
    const pareto = buildReportModules(makeModel()).find((m) => m.id === 'pareto')!;
    expect(pareto.summary.withinCutLine).toEqual([
      { defectType: '毛刺', count: 30, cumRatioPercent: 60 },
    ]);
    expect(pareto.summary.cutLinePercent).toBe(80);
  });

  it('★ 原始尺寸模块补上均值与整体 σ（用户原话「对摘要未提供均值进行优化」），仍不含逐条测量值', () => {
    const raw = buildReportModules(makeModel()).find((m) => m.id === 'rawDimensions')!;
    expect(raw.summary.totalCount).toBe(4);
    const rows = raw.summary.characteristics as Record<string, unknown>[];
    expect(rows).toEqual([
      {
        characteristicName: '外壳长度',
        count: 3,
        mean: 50.0233,
        sigmaOverall: 0.0611,
        min: 49.97,
        max: 50.09,
        span: 0.12,
        usl: 50.2,
        lsl: 49.8,
      },
      {
        characteristicName: '转轴直径',
        count: 1,
        mean: 12.03,
        sigmaOverall: null,
        min: 12.03,
        max: 12.03,
        span: 0,
        usl: 12.02,
        lsl: 11.98,
      },
    ]);
    // 只有 1 条时 σ 无定义 → null（不能拿 0 冒充）
    expect(rows[1].sigmaOverall).toBeNull();
  });

  it('capabilityChart 模块补上双口径 σ 与推导控制限；CPK 模块带上判定门槛', () => {
    const modules = buildReportModules(makeModel());
    const cap = modules.find((m) => m.id === 'capabilityChart')!;
    const row = (cap.summary.characteristics as Record<string, unknown>[])[0];
    expect(row).toMatchObject({
      characteristicName: '外壳长度',
      sigmaWithin: 0.05,
      sigmaOverall: 0.07,
      centerLine: 50.05,
      ucl: 50.2,
      lcl: 49.9,
      specCenter: 50,
    });
    expect(cap.summary.capabilityBenchmark).toEqual({
      acceptable: 1.33,
      excellent: 1.67,
      note: 'Cpk / Ppk：≥ 1.33 为合格，≥ 1.67 为优秀（本工具口径）',
    });
    const cpk = modules.find((m) => m.id === 'cpk')!;
    expect((cpk.summary.characteristics as Record<string, unknown>[])[0]).toMatchObject({
      specCenter: 50,
      meanShiftFromSpecCenter: 0.05,
    });
  });

  it('★ 每个模块都声明「适用方向」与「数据口径」——不适用方向不发给模型', () => {
    const modules = buildReportModules(makeModel());
    for (const m of modules) {
      expect(m.applicableFocus.length).toBeGreaterThan(0);
      expect(m.dataScope.length).toBeGreaterThan(10);
    }
    const defect = modules.find((m) => m.id === 'defect')!;
    // 计数数据不该被问「过程稳定性/过程能力」
    expect(defect.applicableFocus).not.toContain('stability');
    expect(defect.applicableFocus).not.toContain('capability');
    expect(defect.dataScope).toContain('没有');
    const control = modules.find((m) => m.id === 'controlChart')!;
    // 原始尺寸没有控制限与子组编号 → 不能声明稳定性，否则 prompt 会引出「无法判断」的废话
    const raw = modules.find((m) => m.id === 'rawDimensions')!;
    expect(raw.applicableFocus).not.toContain('stability');
    expect(raw.dataScope).toContain('控制限');
    expect(control.applicableFocus).toContain('stability');
    expect(control.applicableFocus).not.toContain('defectPareto');
  });

  it('★ 数据主权：全部模块摘要里不含 values / measurements / points 数组', () => {
    const serialized = JSON.stringify(buildReportModules(makeModel()));
    expect(serialized).not.toMatch(/"(values|measurements|points)":\[/);
    // 逐条明细的字段与「非极值」的中间值一律不得出现：
    // 50.01 是外壳长度三条里的中间值（既不是 min 49.97 也不是 max 50.09），
    // 它只要出现就说明原始明细泄漏了。
    expect(serialized).not.toContain('"index"');
    expect(serialized).not.toContain('50.01');
  });

  it('空数据集：6 个模块全部标记 unavailable，且没有可分析模块', () => {
    const empty = makeModel({ cpkSummary: [], defectStats: [], rawDimensions: [] });
    const modules = buildReportModules(empty);
    expect(modules).toHaveLength(6);
    expect(modules.every((m) => m.unavailable !== null)).toBe(true);
    expect(analyzableModules(modules)).toEqual([]);
  });

  it('只有部分数据时，只有有数据的模块可分析', () => {
    const partial = makeModel({ defectStats: [], rawDimensions: [] });
    const ids = analyzableModules(buildReportModules(partial)).map((m) => m.id);
    expect(ids).toEqual(['cpk', 'controlChart', 'capabilityChart']);
  });
});
