// @vitest-environment jsdom
/**
 * ReportPage 接线回归测试（永久）—— 第五轮 P0 修复 #11 / #2。
 *
 * 背景缺陷（用户第五轮截图反馈）：报表打印预览「只有三张表、一张图都没有」，
 * 且导出范围**只有 2 项、还是 useState**。根因是：
 *   1. `ReportPage` 全文没有 import 任何图表组件，`includeChartImagesInPrint`
 *      只是给 body 加一个 CSS 类 —— 作用于**不存在的元素**（空转）；
 *   2. 勾选状态是页面 `useState`，刷新即丢。
 *
 * 本文件按「接线类缺陷」的方法论验证：**注入假协作者 + 破坏实现必须变红**。
 *
 * 证伪立场：
 * - 若把 `exportOptions` 改回 `useState`：第 1/3 组「store → UI 受控」用例变红；
 * - 若把图表渲染删掉（回到旧版空转）：第 1/2 组「图表真实存在 / 按项消失」变红；
 * - 若 `printReport` 未被调用或未按勾选项过滤：第 3/5 组变红。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ReportPage from '@/ui/pages/ReportPage';
import { useProjectStore } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import { useSettingsStore } from '@/store/settingsStore';
import { clearCapabilityCache } from '@/store/selectors';
import { DEFAULT_EXPORT_OPTIONS } from '@/services/report/exportOptions';
import type { Dataset } from '@/data/schema';

/** 构造含 3 特性 + 6 类不良记录的数据集（图表全部有数据）。 */
function makeDataset(): Dataset {
  const mkChar = (id: string, name: string, base: number, usl: number, lsl: number) => ({
    id,
    datasetId: 'ds1',
    name,
    specLimits: { usl, lsl, target: base, unit: 'mm' },
    measurements: Array.from({ length: 120 }, (_, i) => ({
      id: `${id}_m${i}`,
      characteristicId: id,
      value: base + Math.sin(i / 3) * 0.02 + (i % 7) * 0.001,
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
  });
  return {
    id: 'ds1',
    projectId: 'p1',
    name: '测试数据集',
    sourceType: 'xlsx',
    importedAt: new Date().toISOString(),
    rawFileName: 'test.xlsx',
    characteristics: [
      mkChar('c1', '外壳长度', 50, 50.2, 49.8),
      mkChar('c2', '转轴直径', 12, 12.02, 11.98),
      mkChar('c3', '安装孔径', 8, 8.1, 7.9),
    ],
    defectRecords: [
      { id: 'd1', datasetId: 'ds1', defectType: '划伤', count: 320, category: '外观' },
      { id: 'd2', datasetId: 'ds1', defectType: '尺寸超差', count: 215, category: '尺寸' },
      { id: 'd3', datasetId: 'ds1', defectType: '毛边', count: 148, category: '外观' },
      { id: 'd4', datasetId: 'ds1', defectType: '色差', count: 92, category: '外观' },
      { id: 'd5', datasetId: 'ds1', defectType: '变形', count: 45, category: '尺寸' },
      { id: 'd6', datasetId: 'ds1', defectType: '异物', count: 18, category: '材质' },
    ],
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <ReportPage />
    </MemoryRouter>,
  );
}

/**
 * 取当前页面上的导出范围复选框容器。
 *
 * 注意：MUI 的 `data-testid` 落在 Checkbox 的根 `<span>` 上，真正的
 * `<input type="checkbox">` 在其内部 —— 断言 checked 必须下沉到 input，
 * 否则拿到的是 undefined（曾被此坑误导过一次）。
 */
function optionCheckbox(key: string): HTMLElement {
  return screen.getByTestId(`export-option-${key}`);
}

/** 取复选框内部的真实 input（用于断言 checked）。 */
function optionInput(key: string): HTMLInputElement {
  const input = optionCheckbox(key).querySelector('input');
  if (!input) {
    throw new Error(`未找到 ${key} 的 input 元素`);
  }
  return input;
}

describe('ReportPage —— 导出范围 7 项（表格 + 图表）', () => {
  beforeEach(() => {
    clearCapabilityCache();
    useProjectStore.getState().clearDataset();
    useProjectStore.getState().setDataset(makeDataset());
    useSettingsStore.getState().resetPreferences();
    useAnalysisStore.getState().setSubgroupCapacity(5);
  });

  it('默认全选 7 项，且三张图表**真实渲染**（不是 CSS 空转）', () => {
    renderPage();

    const boxes = within(screen.getByTestId('report-export-options')).getAllByRole('checkbox');
    expect(boxes).toHaveLength(7);
    for (const key of Object.keys(DEFAULT_EXPORT_OPTIONS)) {
      expect(optionCheckbox(key)).toBeInTheDocument();
    }

    // 关键：图表必须在 DOM 里（旧版此处一颗图都没有）。
    expect(screen.getByTestId('report-charts')).toBeInTheDocument();
    expect(screen.getByTestId('control-chart')).toBeInTheDocument();
    expect(screen.getByTestId('pareto-chart')).toBeInTheDocument();
    expect(screen.getByTestId('histogram-chart')).toBeInTheDocument();
  });

  it('取消「控制图」→ 只少控制图，柏拉图与能力图仍在（按项生效）', () => {
    renderPage();

    fireEvent.click(optionCheckbox('controlChartImage'));

    // 副作用断言：状态确实写进了 settingsStore（而非组件临时态）。
    expect(useSettingsStore.getState().exportOptions.controlChartImage).toBe(false);
    expect(useSettingsStore.getState().exportOptions.paretoChartImage).toBe(true);

    expect(screen.queryByTestId('control-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('pareto-chart')).toBeInTheDocument();
    expect(screen.getByTestId('histogram-chart')).toBeInTheDocument();
  });

  it('取消「柏拉图」与「能力图」→ 图表区整体消失', () => {
    renderPage();

    fireEvent.click(optionCheckbox('controlChartImage'));
    fireEvent.click(optionCheckbox('paretoChartImage'));
    fireEvent.click(optionCheckbox('capabilityChartImage'));

    expect(screen.queryByTestId('report-charts')).not.toBeInTheDocument();
  });

  it('勾选状态**受 store 控制**（刷新后保持的根因；useState 实现会让此例变红）', () => {
    // 模拟「上次会话用户关掉了 CPK 汇总与控制图」后重新进入页面。
    useSettingsStore.getState().setExportOptions({ cpkSummary: false, controlChartImage: false });

    renderPage();

    expect(optionInput('cpkSummary').checked).toBe(false);
    expect(optionInput('controlChartImage').checked).toBe(false);
    expect(optionInput('defectStats').checked).toBe(true);
    expect(screen.queryByTestId('report-cpk-table')).not.toBeInTheDocument();
    expect(screen.queryByTestId('control-chart')).not.toBeInTheDocument();
    // 其余项仍按默认渲染。
    expect(screen.getByTestId('report-defect-table')).toBeInTheDocument();
    expect(screen.getByTestId('pareto-chart')).toBeInTheDocument();
  });

  it('取消「CPK 汇总」→ 该表从页面消失，其余三表仍在', () => {
    renderPage();
    expect(screen.getByTestId('report-cpk-table')).toBeInTheDocument();

    fireEvent.click(optionCheckbox('cpkSummary'));

    expect(screen.queryByTestId('report-cpk-table')).not.toBeInTheDocument();
    expect(screen.getByTestId('report-defect-table')).toBeInTheDocument();
    expect(screen.getByTestId('report-raw-dimensions-table')).toBeInTheDocument();
    expect(screen.getByTestId('report-raw-defects-table')).toBeInTheDocument();
  });

  it('原始尺寸表限量渲染（3×120=360 行 → 截断提示 + 只渲染 200 行）', () => {
    renderPage();
    const table = screen.getByTestId('report-raw-dimensions-table');
    // 3 特性 × 120 = 360 行 > 200 → 触发截断提示且只渲染 200 行。
    expect(screen.getByTestId('raw-dim-truncated')).toBeInTheDocument();
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(201); // 1 表头 + 200 数据行
  });

  it('全不勾选 → 打印按钮禁用并给出提示', () => {
    renderPage();
    for (const key of Object.keys(DEFAULT_EXPORT_OPTIONS)) {
      fireEvent.click(optionCheckbox(key));
    }

    const printBtn = screen.getByTestId('print-report');
    expect(printBtn).toBeDisabled();
    expect(screen.getByTestId('export-none-selected')).toBeInTheDocument();
    // Excel 保持可用（Excel 固定 4 sheet，不受图表勾选影响）。
    expect(screen.getByTestId('export-excel')).not.toBeDisabled();
  });

  it('点击打印 → 真的调用 window.print（接线，而非只弹 toast）', () => {
    const printSpy = vi.fn();
    const originalPrint = window.print;
    Object.defineProperty(window, 'print', { value: printSpy, writable: true, configurable: true });
    try {
      renderPage();
      fireEvent.click(screen.getByTestId('print-report'));
      expect(printSpy).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window, 'print', {
        value: originalPrint,
        writable: true,
        configurable: true,
      });
    }
  });

  it('图表全不勾选时给 body 加 print-hide-charts（打印样式兜底）', () => {
    renderPage();
    fireEvent.click(optionCheckbox('controlChartImage'));
    fireEvent.click(optionCheckbox('paretoChartImage'));
    fireEvent.click(optionCheckbox('capabilityChartImage'));

    const printSpy = vi.fn();
    const originalPrint = window.print;
    Object.defineProperty(window, 'print', { value: printSpy, writable: true, configurable: true });
    try {
      // 至少留一张表，保证打印按钮可用。
      fireEvent.click(screen.getByTestId('print-report'));
      expect(document.body.classList.contains('print-hide-charts')).toBe(true);
    } finally {
      Object.defineProperty(window, 'print', {
        value: originalPrint,
        writable: true,
        configurable: true,
      });
      document.body.classList.remove('print-hide-charts');
    }
  });
});