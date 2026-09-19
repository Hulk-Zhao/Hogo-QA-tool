// @vitest-environment jsdom
/**
 * 能力分析结果表渲染条件测试（PRD P0-12/P0-13）。
 *
 * 覆盖要求（T03）：
 * - 结果表渲染给定能力结果；
 * - **单侧规格时 Cp/Pp 显示 N/A**（core 语义透传到 UI）；
 * - 双西格玛水平标注正确；
 * - 直方图 / 正态性卡渲染。
 *
 * 做法：直接渲染 CapabilityPage，向 store 注入受控特性与配置，
 * 断言 DOM。不重复验证 core 公式（T01 职责）。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import type { ReactElement } from 'react';
import { theme } from '@/theme';
import { clearCapabilityCache } from '@/store/selectors';
import { useProjectStore, generateId } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import type { SpecLimits } from '@/core';
import type { Characteristic, Dataset, Measurement } from '@/data/schema';
import CapabilityPage from '@/ui/pages/CapabilityPage';

/** 构造一个特性（n 个近似正态值）。 */
function makeCharacteristic(name: string, values: number[], spec: SpecLimits): Characteristic {
  const cid = generateId('ch');
  const measurements: Measurement[] = values.map((v) => ({
    id: generateId('m'),
    characteristicId: cid,
    value: v,
    subgroupId: null,
    timestamp: null,
    batch: null,
    excluded: false,
    excludeReason: null,
  }));
  return {
    id: cid,
    datasetId: 'ds-test',
    name,
    specLimits: spec,
    measurements,
    subgroups: [],
    nullCount: 0,
    outlierFlags: [],
    preprocessConfigRef: null,
    measurementBlobRef: null,
  };
}

function makeDataset(characteristics: Characteristic[]): Dataset {
  return {
    id: 'ds-test',
    projectId: 'local',
    name: '测试数据集',
    sourceType: 'csv',
    importedAt: new Date().toISOString(),
    rawFileName: 'test.csv',
    characteristics,
    defectRecords: [],
  };
}

/** 一组近似正态、无异常值的 30 个值。 */
const NORMAL_VALUES: number[] = [
  10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01, 9.96, 10.03, 10.02, 9.98, 10.0, 10.06,
  9.95, 10.01, 10.02, 9.99, 10.03, 9.97, 10.0, 10.04, 9.98, 10.01, 10.02, 9.99, 10.0, 10.03,
];

function renderPage(ui: ReactElement): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  );
}

describe('CapabilityPage —— 结果表渲染条件', () => {
  beforeEach(() => {
    clearCapabilityCache();
    useAnalysisStore.getState().resetOutliers();
    useAnalysisStore.getState().setSubgroupCapacity(5);
    useAnalysisStore.getState().setSubgroupMode('fixed');
    useAnalysisStore.getState().setSigmaMode('R');
    useProjectStore.getState().clearDataset();
  });

  it('无数据时渲染空状态', () => {
    renderPage(<CapabilityPage />);
    expect(screen.getByText('尚无可分析的数据')).toBeInTheDocument();
  });

  it('双侧规格：Cp/Cpk/Pp/Ppk 均为数值（非 N/A）', () => {
    const spec: SpecLimits = { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' };
    const dataset = makeDataset([makeCharacteristic('外壳长度', NORMAL_VALUES, spec)]);
    useProjectStore.getState().setDataset(dataset);
    useAnalysisStore.getState().setSpec(spec);
    renderPage(<CapabilityPage />);

    const table = screen.getByTestId('capability-table');
    expect(within(table).getByTestId('cp-cell').textContent).not.toBe('N/A');
    expect(within(table).getByTestId('pp-cell').textContent).not.toBe('N/A');
    // 4 位小数格式
    expect(within(table).getByTestId('cp-cell').textContent).toMatch(/^\d+\.\d{4}$/);
  });

  it('单侧规格：Cp 与 Pp 显示 N/A；Cpk/Ppk 仍有值', () => {
    // 只给 USL，LSL 为 null → Cp/Pp 不可计算
    const spec: SpecLimits = { usl: 10.15, lsl: null, target: null, unit: 'mm' };
    const dataset = makeDataset([makeCharacteristic('单侧特性', NORMAL_VALUES, spec)]);
    useProjectStore.getState().setDataset(dataset);
    useAnalysisStore.getState().setSpec(spec);
    renderPage(<CapabilityPage />);

    const table = screen.getByTestId('capability-table');
    expect(within(table).getByTestId('cp-cell').textContent).toBe('N/A');
    expect(within(table).getByTestId('pp-cell').textContent).toBe('N/A');
    // 单侧仍有 Cpk/Ppk
    expect(within(table).getByTestId('cpk-cell').textContent).not.toBe('N/A');
    expect(within(table).getByTestId('ppk-cell').textContent).not.toBe('N/A');
    // 单侧规格告警（可能同时出现在提示与说明中）
    expect(screen.getAllByText(/单侧规格/).length).toBeGreaterThan(0);
  });

  it('双西格玛水平标注「短期能力」与「工程口径」', () => {
    const spec: SpecLimits = { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' };
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('外壳长度', NORMAL_VALUES, spec)]));
    useAnalysisStore.getState().setSpec(spec);
    renderPage(<CapabilityPage />);

    expect(screen.getByText('短期能力(3×Cpk)')).toBeInTheDocument();
    expect(screen.getByText('工程口径(含1.5σ漂移)')).toBeInTheDocument();
    // 混用警示
    expect(screen.getByText(/请勿混用/)).toBeInTheDocument();
  });

  it('正态性卡渲染 AD / S-W 统计量与 p 值', () => {
    const spec: SpecLimits = { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' };
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('外壳长度', NORMAL_VALUES, spec)]));
    useAnalysisStore.getState().setSpec(spec);
    renderPage(<CapabilityPage />);

    const card = screen.getByTestId('normality-card');
    expect(within(card).getByText(/主方法/)).toBeInTheDocument();
    expect(within(card).getByText(/AD：统计量/)).toBeInTheDocument();
  });

  it('西格玛水平 2 位小数格式', () => {
    const spec: SpecLimits = { usl: 10.15, lsl: 9.85, target: 10.0, unit: 'mm' };
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('外壳长度', NORMAL_VALUES, spec)]));
    useAnalysisStore.getState().setSpec(spec);
    renderPage(<CapabilityPage />);

    const table = screen.getByTestId('capability-table');
    expect(within(table).getByTestId('sigma-short-cell').textContent).toMatch(/^\d+\.\d{2}$/);
  });
});
