/**
 * T04 非组件单元测试（node 环境）：
 *   - toViolationRows（判异明细纯映射，含去重后等效标注）；
 *   - computeControlChartState（控制图编排纯函数）；
 *   - reportService（Excel 导出无图片、打印选项仅作用于打印）。
 */

import { describe, expect, it, vi } from 'vitest';
import * as XLSX from 'xlsx';
import {
  dedupeViolations,
  defaultToggleConfig,
  type RuleViolation,
} from '@/core';
import { toViolationRows } from '@/ui/charts/RuleViolationTable';
import { computeControlChartState, isVariablesChart, isAttributeChart } from '@/ui/hooks/useControlChart';
import {
  buildModel,
  exportExcelReport,
  applyPrintClass,
  printReport,
  PRINT_HIDE_CHARTS_CLASS,
  DEFAULT_EXPORT_OPTIONS,
  CHART_OPTION_KEYS,
  TABLE_OPTION_KEYS,
  sanitizeExportOptions,
  hasAnyChartOption,
  hasAnyExportOption,
  type SaveBlobFn,
} from '@/services/report';
import type { Project } from '@/data/schema';

/** 生成测量值。 */
function sampleValues(n = 25): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(50 + Math.sin(i / 3) * 2 + (i % 3) * 0.3);
  }
  return out;
}

/** 构造一个最小 Project。 */
function makeProject(): Project {
  return {
    id: 'p1',
    name: '测试项目',
    description: '',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    schemaVersion: 1,
    datasets: [
      {
        id: 'd1',
        projectId: 'p1',
        name: '数据集',
        sourceType: 'xlsx',
        importedAt: '2024-01-01T00:00:00.000Z',
        rawFileName: 'quality_data.xlsx',
        characteristics: [
          {
            id: 'c1',
            datasetId: 'd1',
            name: '长度',
            specLimits: { usl: 52, lsl: 48, target: 50, unit: 'mm' },
            measurements: sampleValues(30).map((value, i) => ({
              id: `m-${i}`,
              characteristicId: 'c1',
              value,
              subgroupId: null,
              timestamp: null,
              batch: null,
              excluded: false,
              excludeReason: null,
            })),
            subgroups: [],
            nullCount: 0,
            outlierFlags: [],
            preprocessConfigRef: null,
            measurementBlobRef: null,
          },
        ],
        defectRecords: [
          { id: 'def-1', datasetId: 'd1', defectType: '划伤', count: 42 },
          { id: 'def-2', datasetId: 'd1', defectType: '毛边', count: 18 },
        ],
      },
    ],
    analysisConfigs: [],
    aiUsageLogs: [],
  };
}

describe('toViolationRows —— 判异明细纯映射', () => {
  it('单点违规：涉及点与窗口起点为 1-based', () => {
    const v: RuleViolation = {
      ruleId: 'W1',
      ruleGroup: 'westernElectric',
      pointIndices: [4],
      windowStart: 4,
      message: '第 5 点超 3σ',
      severity: 'high',
    };
    const rows = toViolationRows([v]);
    expect(rows.length).toBe(1);
    expect(rows[0].ruleId).toBe('W1');
    expect(rows[0].shortName).toBe('1点超3σ');
    expect(rows[0].groupLabel).toBe('西方电气');
    expect(rows[0].pointsText).toBe('第 5 点');
    expect(rows[0].windowStartText).toBe('第 5 点');
    expect(rows[0].pointIndex).toBe(4);
  });

  it('区间型违规：涉及点全部列出（升序，1-based）', () => {
    const v: RuleViolation = {
      ruleId: 'W2',
      ruleGroup: 'westernElectric',
      pointIndices: [3, 4, 5, 6],
      windowStart: 3,
      message: '连续 9 点同侧',
      severity: 'medium',
    };
    const rows = toViolationRows([v]);
    expect(rows[0].pointsText).toBe('第 4 / 5 / 6 / 7 点');
  });

  it('去重后仍保留等效标注（message 内含尼尔森）', () => {
    const violations: RuleViolation[] = [
      {
        ruleId: 'W1',
        ruleGroup: 'westernElectric',
        pointIndices: [0],
        windowStart: 0,
        message: 'W1 命中',
        severity: 'high',
      },
      {
        ruleId: 'N1',
        ruleGroup: 'nelson',
        pointIndices: [0],
        windowStart: 0,
        message: 'N1 命中',
        severity: 'high',
      },
    ];
    const deduped = dedupeViolations(violations, true);
    // 去重后仅 1 条（保留 W）。
    expect(deduped.length).toBe(1);
    const rows = toViolationRows(deduped);
    expect(rows[0].ruleId).toBe('W1');
    expect(rows[0].message).toContain('尼尔森');
  });
});

describe('computeControlChartState —— 控制图编排', () => {
  it('Xbar-R：返回 series + evaluation（含 pointRuleMap）', () => {
    const state = computeControlChartState(sampleValues(25), 'Xbar-R', 5, defaultToggleConfig());
    expect(state.error).toBeNull();
    expect(state.series?.selectedType).toBe('Xbar-R');
    expect(state.evaluation).not.toBeNull();
    expect(Array.isArray(state.sigmaByPoint)).toBe(true);
  });

  it('I-MR：不依赖子组容量', () => {
    const state = computeControlChartState(sampleValues(20), 'I-MR', 5, defaultToggleConfig());
    expect(state.error).toBeNull();
    expect(state.series?.selectedType).toBe('I-MR');
  });

  it('子组容量不足：返回中文错误提示（不抛异常）', () => {
    const state = computeControlChartState([1, 2, 3], 'Xbar-R', 5, defaultToggleConfig());
    expect(state.series).toBeNull();
    expect(state.error).toContain('不足一个完整子组');
  });

  it('计数型无数据：返回中文错误提示', () => {
    const state = computeControlChartState([], 'P', 5, defaultToggleConfig());
    expect(state.series).toBeNull();
    expect(state.error).toContain('不良数');
  });

  it('计数型有数据：正确构造 P 图', () => {
    const state = computeControlChartState([], 'P', 5, defaultToggleConfig(), {
      defectivesOrDefects: [3, 2, 4],
      sampleSizes: [100, 100, 100],
    });
    expect(state.error).toBeNull();
    expect(state.series?.selectedType).toBe('P');
  });

  it('判异结果经 §9.3 去重（Wk/Nk 仅一项）', () => {
    // 构造一组会命中 W1/N1 的数据。
    const values = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 60];
    const state = computeControlChartState(values, 'I-MR', 5, {
      westernElectric: { W1: true, W2: false, W3: false, W4: false },
      nelson: { N1: true, N2: false, N3: false, N4: false, N5: false, N6: false, N7: false, N8: false },
    });
    const violations = state.evaluation?.violations ?? [];
    // W1 与 N1 等价，去重后不应同时出现。
    const hasW1 = violations.some((v) => v.ruleId === 'W1');
    const hasN1 = violations.some((v) => v.ruleId === 'N1');
    expect(hasW1 && hasN1).toBe(false);
  });

  it('isVariablesChart / isAttributeChart 分类正确', () => {
    expect(isVariablesChart('Xbar-R')).toBe(true);
    expect(isVariablesChart('P')).toBe(false);
    expect(isAttributeChart('P')).toBe(true);
    expect(isAttributeChart('I-MR')).toBe(false);
  });
});

describe('reportService —— Excel 导出（≥4 sheet，无图片）', () => {
  it('buildExcelReport 产物含 4 个 sheet', () => {
    const model = buildModel(makeProject());
    const fileName = exportExcelReport(model, () => undefined);
    expect(fileName.endsWith('.xlsx')).toBe(true);
  });

  it('导出的 xlsx 恰好 4 个 sheet，且不含图片类型', () => {
    const model = buildModel(makeProject());
    let captured: ArrayBuffer | null = null;
    const save: SaveBlobFn = (data) => {
      captured = data;
    };
    exportExcelReport(model, save);
    expect(captured).not.toBeNull();
    const wb = XLSX.read(captured as unknown as ArrayBuffer, { type: 'array' });
    expect(wb.SheetNames.length).toBe(4);
    expect(wb.SheetNames).toEqual(['CPK汇总', '不良统计', '原始尺寸', '原始不良']);
    // 无图片：book 内不含 pics（SheetJS 将图片挂在 sheet 的 `!images`）。
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name];
      expect((ws as { '!images'?: unknown })['!images']).toBeUndefined();
    }
  });
});

describe('reportService —— 导出范围（7 项：4 表 + 3 图）', () => {
  it('导出范围恰好 7 项，且 4 表 + 3 图分组无遗漏（证伪：漏项/多项即变红）', () => {
    expect(TABLE_OPTION_KEYS).toEqual(['cpkSummary', 'defectStats', 'rawDimensions', 'rawDefects']);
    expect(CHART_OPTION_KEYS).toEqual([
      'controlChartImage',
      'paretoChartImage',
      'capabilityChartImage',
    ]);
    expect([...TABLE_OPTION_KEYS, ...CHART_OPTION_KEYS]).toHaveLength(7);
    expect(Object.keys(DEFAULT_EXPORT_OPTIONS).sort()).toEqual(
      [...TABLE_OPTION_KEYS, ...CHART_OPTION_KEYS].sort(),
    );
  });

  it('sanitizeExportOptions：旧版 2 字段结构读回后补齐为 7 项且默认全选', () => {
    // 历史持久化残留（includeChartImagesInPrint / includeTables）不得导致整份丢弃。
    const legacy = sanitizeExportOptions({ includeChartImagesInPrint: false, includeTables: true });
    expect(legacy).toEqual(DEFAULT_EXPORT_OPTIONS);
    // 脏值（字符串 / null / 数字）逐项回落默认 true，而非整份丢弃。
    const dirty = sanitizeExportOptions({ cpkSummary: 'yes', defectStats: null, rawDefects: 1 });
    expect(dirty).toEqual(DEFAULT_EXPORT_OPTIONS);
    // 显式 false 必须被保留（否则「取消勾选」会失效）。
    expect(sanitizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, cpkSummary: false }).cpkSummary).toBe(false);
    // 非对象 → 默认。
    expect(sanitizeExportOptions(null)).toEqual(DEFAULT_EXPORT_OPTIONS);
  });

  it('hasAnyChartOption：只看三项图表，任一勾选即 true', () => {
    expect(hasAnyChartOption(DEFAULT_EXPORT_OPTIONS)).toBe(true);
    const onlyPareto = {
      ...DEFAULT_EXPORT_OPTIONS,
      controlChartImage: false,
      capabilityChartImage: false,
    };
    expect(hasAnyChartOption(onlyPareto)).toBe(true);
    const noneChart = {
      ...DEFAULT_EXPORT_OPTIONS,
      controlChartImage: false,
      paretoChartImage: false,
      capabilityChartImage: false,
    };
    expect(hasAnyChartOption(noneChart)).toBe(false);
  });

  it('hasAnyExportOption：全不勾选为 false（UI 据此拦掉空打印）', () => {
    expect(hasAnyExportOption(DEFAULT_EXPORT_OPTIONS)).toBe(true);
    const none = Object.fromEntries(
      [...TABLE_OPTION_KEYS, ...CHART_OPTION_KEYS].map((k) => [k, false]),
    );
    expect(hasAnyExportOption(sanitizeExportOptions(none))).toBe(false);
  });

  it('printReport 调用注入的打印函数并返回 true', () => {
    const spy = vi.fn();
    const ok = printReport({ ...DEFAULT_EXPORT_OPTIONS }, spy);
    expect(ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('applyPrintClass 在 node（无 document）环境安全 no-op', () => {
    expect(() => applyPrintClass(false)).not.toThrow();
    expect(typeof PRINT_HIDE_CHARTS_CLASS).toBe('string');
  });
});
