// @vitest-environment jsdom
/**
 * 多特性 Cpk 汇总对比表（本轮 P2-D，PRD P1-03）+ 规格限自动预填（本轮 P2-A）。
 *
 * 缺陷背景：
 * - P2-A：导入带 USL/LSL 的数据后，能力页规格限输入框为空、Cp/Cpk 全显示 N/A
 *   并提示「仅提供单侧规格」，而报表页对同一份数据能算出 Cpk —— 因为能力页的
 *   编辑态从未与特性的 specLimits 同步。
 * - P2-D：多特性场景缺少「一次看完全部特性」的对比视图，只能逐个切换特性。
 *
 * 证伪立场：
 * - 去掉预填 effect、或去掉 setSpec 里的 specOverridden 置位 → 预填/手改断言变红；
 * - 让 sortBatchRows 把 Cpk 不可判定的行排到前面（升/降任一方向）→ 排序断言变红。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import type { ReactElement } from 'react';
import { theme } from '@/theme';
import { clearCapabilityCache } from '@/store/selectors';
import { useProjectStore, generateId } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import type { SpecLimits } from '@/core';
import type { Characteristic, Dataset, Measurement } from '@/data/schema';
import type { CpKSummaryRow } from '@/data/exporter/reportModel';
import CapabilityPage, { sortBatchRows } from '@/ui/pages/CapabilityPage';

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

function renderPage(ui: ReactElement): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>{ui}</MemoryRouter>
    </ThemeProvider>,
  );
}

/** 当前 DOM 中批量表的行顺序（按 testid 后缀取特性名）。 */
function rowOrder(): string[] {
  return screen
    .getAllByTestId(/^batch-row-/)
    .map((el) => (el.getAttribute('data-testid') ?? '').replace('batch-row-', ''));
}

/** 构造一个汇总行（供纯函数排序测试）。 */
function makeRow(characteristic: string, cpk: number | null, n: number): CpKSummaryRow {
  return {
    characteristic,
    n,
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
    sigmaLevelShort: cpk === null ? null : cpk * 3,
    sigmaLevelBench: cpk === null ? null : cpk * 3 + 1.5,
    ppmOverall: 0,
  };
}

/** 一组近似正态、无异常值的 30 个值。 */
const VALUES: number[] = [
  10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01, 9.96, 10.03, 10.02, 9.98, 10.0, 10.06,
  9.95, 10.01, 10.02, 9.99, 10.03, 9.97, 10.0, 10.04, 9.98, 10.01, 10.02, 9.99, 10.0, 10.03,
];

/** 窄规格（Cpk 小）与宽规格（Cpk 大）。 */
const NARROW: SpecLimits = { usl: 10.05, lsl: 9.95, target: 10.0, unit: 'mm' };
const WIDE: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10.0, unit: 'mm' };
/** 无规格限（Cpk 不可判定）。 */
const NO_SPEC: SpecLimits = { usl: null, lsl: null, target: null, unit: 'mm' };

describe('sortBatchRows —— 纯函数排序', () => {
  const rows: CpKSummaryRow[] = [
    makeRow('甲', 2.0, 30),
    makeRow('乙', null, 20),
    makeRow('丙', 0.8, 10),
  ];

  it('升序：Cpk 从小到大；不可判定的行固定排最后', () => {
    expect(sortBatchRows(rows, 'cpk', 'asc').map((r) => r.characteristic)).toEqual(['丙', '甲', '乙']);
  });

  it('降序：Cpk 从大到小；不可判定的行**依然**排最后（不能被顶到首屏）', () => {
    expect(sortBatchRows(rows, 'cpk', 'desc').map((r) => r.characteristic)).toEqual(['甲', '丙', '乙']);
  });

  it('按 n 排序同样把不可判定行排最后', () => {
    expect(sortBatchRows(rows, 'n', 'asc').map((r) => r.characteristic)).toEqual(['丙', '乙', '甲']);
  });

  it('不修改入参数组（纯函数）', () => {
    const before = rows.map((r) => r.characteristic);
    sortBatchRows(rows, 'cpk', 'desc');
    expect(rows.map((r) => r.characteristic)).toEqual(before);
  });
});

describe('CapabilityPage —— 多特性 Cpk 对比表（P2-D）', () => {
  beforeEach(() => {
    clearCapabilityCache();
    useAnalysisStore.setState({
      spec: { usl: null, lsl: null, target: null, unit: 'mm' },
      specOverridden: false,
    });
    useProjectStore.getState().clearDataset();
  });

  it('单特性：不渲染批量对比卡（只对多特性有意义）', () => {
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('甲特性', VALUES, WIDE)]));
    renderPage(<CapabilityPage />);
    expect(screen.queryByTestId('batch-capability-card')).toBeNull();
  });

  it('多特性：渲染对比表，默认按 Cpk 升序、不可判定行排最后', () => {
    useProjectStore.getState().setDataset(
      makeDataset([
        makeCharacteristic('甲特性', VALUES, NARROW),
        makeCharacteristic('乙特性', VALUES, WIDE),
        makeCharacteristic('丙特性', VALUES, NO_SPEC),
      ]),
    );
    renderPage(<CapabilityPage />);

    const card = screen.getByTestId('batch-capability-card');
    expect(within(card).getByTestId('batch-capability-table')).toBeInTheDocument();

    const order = rowOrder();
    expect(order).toHaveLength(3);
    expect(order.indexOf('丙特性')).toBe(2);
    expect(order.indexOf('甲特性')).toBeLessThan(order.indexOf('乙特性'));

    expect(within(card).getByTestId('batch-verdict-丙特性').textContent).toBe('规格限不足，无法判定');
  });

  it('点击表头切换排序方向：次数不变、顺序反转，不可判定行仍在最后', () => {
    useProjectStore.getState().setDataset(
      makeDataset([
        makeCharacteristic('甲特性', VALUES, NARROW),
        makeCharacteristic('乙特性', VALUES, WIDE),
        makeCharacteristic('丙特性', VALUES, NO_SPEC),
      ]),
    );
    renderPage(<CapabilityPage />);

    const before = rowOrder();
    expect(before.indexOf('甲特性')).toBeLessThan(before.indexOf('乙特性'));

    fireEvent.click(screen.getByTestId('batch-sort-cpk'));

    const after = rowOrder();
    expect(after).toHaveLength(3);
    expect(after.indexOf('乙特性')).toBeLessThan(after.indexOf('甲特性'));
    expect(after.indexOf('丙特性')).toBe(2);

    fireEvent.click(screen.getByTestId('batch-sort-cpk'));
    expect(rowOrder()).toEqual(before);
  });

  it('当前特性行带「当前」标记（避免看错行）', () => {
    useProjectStore.getState().setDataset(
      makeDataset([
        makeCharacteristic('甲特性', VALUES, NARROW),
        makeCharacteristic('乙特性', VALUES, WIDE),
      ]),
    );
    renderPage(<CapabilityPage />);
    const row = screen.getByTestId('batch-row-甲特性');
    expect(within(row).getByText('当前')).toBeInTheDocument();

    // 结构回归：Cpk/Ppk 必须落在真实 td 里。
    // NumberCell 渲染的是 <span>，若忘记外面套 TableCell，单元格会裸挂在 <tr> 下：
    // 视觉上靠浏览器的匿名表格单元格「碰巧」能看，但语义/可访问性与列对齐都不可靠。
    expect(row.querySelectorAll('td').length).toBe(5);
  });
});

describe('CapabilityPage —— 规格限自动预填（P2-A）', () => {
  beforeEach(() => {
    clearCapabilityCache();
    useAnalysisStore.setState({
      spec: { usl: null, lsl: null, target: null, unit: 'mm' },
      specOverridden: false,
    });
    useProjectStore.getState().clearDataset();
  });

  it('导入带 USL/LSL 的数据后：自动预填，且 Cp/Cpk 不再是 N/A', () => {
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('甲特性', VALUES, WIDE)]));
    renderPage(<CapabilityPage />);

    expect(screen.getByTestId('spec-source-hint').textContent).toBe('规格限：来自导入数据（甲特性）');
    expect((screen.getByLabelText('USL（上限）') as HTMLInputElement).value).toBe('10.5');
    expect((screen.getByLabelText('LSL（下限）') as HTMLInputElement).value).toBe('9.5');

    const table = screen.getByTestId('capability-table');
    expect(within(table).getByTestId('cp-cell').textContent).toMatch(/^\d+\.\d{4}$/);
    expect(within(table).getByTestId('cpk-cell').textContent).toMatch(/^\d+\.\d{4}$/);
  });

  it('用户手改后标记「已手动修改」，并可一键恢复为导入规格', () => {
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic('甲特性', VALUES, WIDE)]));
    renderPage(<CapabilityPage />);

    fireEvent.change(screen.getByLabelText('USL（上限）'), { target: { value: '10.9' } });
    expect(screen.getByTestId('spec-source-hint').textContent).toBe('规格限：已手动修改');
    expect((screen.getByLabelText('USL（上限）') as HTMLInputElement).value).toBe('10.9');

    fireEvent.click(screen.getByTestId('reset-spec-from-characteristic'));
    expect(screen.getByTestId('spec-source-hint').textContent).toBe('规格限：来自导入数据（甲特性）');
    expect((screen.getByLabelText('USL（上限）') as HTMLInputElement).value).toBe('10.5');
  });
});
