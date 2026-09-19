// @vitest-environment jsdom
/**
 * TopBar 接线回归测试（永久）——一键日报导出 + AI 解读跳转。
 *
 * 背景：本轮缺陷根因是「代码写好但从未接线」——`handleExport` / `handleAiEntry`
 * 曾是空壳（只弹提示，不导出 / 不跳转）。此处以**可证伪**断言锁定真实行为：
 *
 *  - 导出：在 `@/services/report` 边界注入假 save 函数，断言真实导出路径
 *    产出的 `(buffer, fileName, mime)` —— buffer 非空、文件名 `.xlsx`、MIME 正确。
 *    若把实现换成只 `pushToast`，save 永不被调用 → 断言失败（防「只断言弹了 toast」）。
 *  - 无数据：断言给出警告且 save **未被调用**。
 *  - AI 解读：断言发生**路由跳转**（渲染 /ai 探针），而非「开发中」提示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import TopBar from '@/ui/layout/TopBar';
import { useProjectStore, generateId } from '@/store/projectStore';
import { useUiStore } from '@/store/uiStore';
import type { Characteristic, Dataset, Measurement } from '@/data/schema';

/** 注入到导出边界的假 save（hoisted：供 vi.mock 工厂引用）。 */
const reportSpy = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('@/services/report', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/report')>();
  return {
    ...actual,
    // TopBar 调用 exportExcelReportDetailed(model)（P3 起：导出会内嵌图表，
    // 需要拿到 imageCount 来提示）；这里替换为注入假 save，以便断言真实导出参数。
    exportExcelReportDetailed: (
      model: Parameters<typeof actual.exportExcelReportDetailed>[0],
    ) => actual.exportExcelReportDetailed(model, reportSpy.save),
  };
});

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** 30 个近似正态、无异常值的测量值。 */
const NORMAL_VALUES: number[] = [
  10.01, 9.98, 10.03, 10.05, 9.97, 10.02, 10.0, 9.99, 10.04, 10.01, 9.96, 10.03, 10.02, 9.98, 10.0,
  10.06, 9.95, 10.01, 10.02, 9.99, 10.03, 9.97, 10.0, 10.04, 9.98, 10.01, 10.02, 9.99, 10.0, 10.03,
];

/** 构造一个含测量值的特性。 */
function makeCharacteristic(): Characteristic {
  const cid = generateId('ch');
  const measurements: Measurement[] = NORMAL_VALUES.map((value) => ({
    id: generateId('m'),
    characteristicId: cid,
    value,
    subgroupId: null,
    timestamp: null,
    batch: null,
    excluded: false,
    excludeReason: null,
  }));
  return {
    id: cid,
    datasetId: 'ds-topbar',
    name: '外壳长度',
    specLimits: { usl: 10.2, lsl: 9.8, target: 10, unit: 'mm' },
    measurements,
    subgroups: [],
    nullCount: 0,
    outlierFlags: [],
    preprocessConfigRef: null,
    measurementBlobRef: null,
  };
}

/** 构造数据集。 */
function makeDataset(characteristics: Characteristic[]): Dataset {
  return {
    id: 'ds-topbar',
    projectId: 'local',
    name: '顶栏测试数据集',
    sourceType: 'csv',
    importedAt: new Date().toISOString(),
    rawFileName: 'topbar.csv',
    characteristics,
    defectRecords: [],
  };
}

/** 渲染 TopBar + 路由探针（用于断言跳转目标）。 */
function renderTopBar(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={['/import']}>
        <TopBar />
        <Routes>
          <Route path="/import" element={<div data-testid="page-import" />} />
          <Route path="/report" element={<div data-testid="page-report" />} />
          <Route path="/ai" element={<div data-testid="page-ai" />} />
        </Routes>
      </MemoryRouter>
    </ThemeProvider>,
  );
}

/** 重置 store 到「无数据、无 toast」的干净态。 */
function resetStores(): void {
  useProjectStore.setState({
    project: null,
    projectName: '未命名项目',
    dataset: null,
    selectedCharacteristicId: null,
  });
  useUiStore.setState({ toasts: [] });
}

describe('TopBar —— 一键日报导出接线', () => {
  beforeEach(() => {
    reportSpy.save.mockClear();
    resetStores();
    vi.spyOn(window, 'print').mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('有数据：真实导出 Excel（非空 buffer + .xlsx 文件名 + 正确 MIME），并跳转 /report 触发打印', async () => {
    useProjectStore.getState().setDataset(makeDataset([makeCharacteristic()]));
    renderTopBar();

    fireEvent.click(screen.getByTestId('topbar-export-report'));

    expect(reportSpy.save).toHaveBeenCalledTimes(1);
    const [buffer, fileName, mime] = reportSpy.save.mock.calls[0] as [ArrayBuffer, string, string];
    expect(buffer).toBeInstanceOf(ArrayBuffer);
    expect(buffer.byteLength).toBeGreaterThan(0);
    expect(fileName).toMatch(/\.xlsx$/);
    expect(mime).toBe(XLSX_MIME);

    // 导出后应切到报表页并触发打印（双 rAF 后）。
    await screen.findByTestId('page-report');
    await waitFor(() => expect(window.print).toHaveBeenCalled());
  });

  it('无数据：给出警告提示，且**不导出**、不跳转、不打印', () => {
    renderTopBar();

    fireEvent.click(screen.getByTestId('topbar-export-report'));

    expect(reportSpy.save).not.toHaveBeenCalled();
    const toasts = useUiStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe('warning');
    expect(toasts[0].message).toContain('暂无可导出的数据');
    // 未跳转：仍在 /import。
    expect(screen.getByTestId('page-import')).toBeInTheDocument();
    expect(screen.queryByTestId('page-report')).not.toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();
  });

  it('空数据（characteristics 为空）同样不导出', () => {
    useProjectStore.getState().setDataset(makeDataset([]));
    renderTopBar();

    fireEvent.click(screen.getByTestId('topbar-export-report'));

    expect(reportSpy.save).not.toHaveBeenCalled();
  });
});

describe('TopBar —— AI 解读跳转接线', () => {
  beforeEach(() => {
    resetStores();
  });

  afterEach(() => {
    cleanup();
  });

  it('点击 AI 解读 → 路由跳转到 /ai（而非「开发中」提示），按钮保持可点', async () => {
    renderTopBar();

    const button = screen.getByTestId('topbar-ai-entry');
    expect(button).not.toBeDisabled();

    fireEvent.click(button);

    await screen.findByTestId('page-ai');
    // 反向证据：不是弹「开发中」占位提示。
    expect(screen.queryByText(/开发中/)).not.toBeInTheDocument();
  });
});
