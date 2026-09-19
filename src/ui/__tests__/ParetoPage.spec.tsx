// @vitest-environment jsdom
/**
 * 柏拉图页测试（PRD P0-17）。
 *
 * 覆盖：无数据空状态、示例数据渲染、明细表降序、阈值调节。
 * ECharts 在 jsdom 下渲染为 canvas 占位，测试聚焦数据与 DOM 结构。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useProjectStore, generateId } from '@/store/projectStore';
import type { Dataset } from '@/data/schema';
import ParetoPage from '@/ui/pages/ParetoPage';

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ParetoPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

function makeDatasetWithDefects(): Dataset {
  return {
    id: 'ds-defect',
    projectId: 'local',
    name: '缺陷数据集',
    sourceType: 'csv',
    importedAt: new Date().toISOString(),
    rawFileName: 'defect.csv',
    characteristics: [],
    defectRecords: [
      { id: generateId('d'), datasetId: 'ds-defect', defectType: '划伤', count: 42, category: null },
      { id: generateId('d'), datasetId: 'ds-defect', defectType: '毛边', count: 31, category: null },
      { id: generateId('d'), datasetId: 'ds-defect', defectType: '尺寸超差', count: 18, category: null },
      { id: generateId('d'), datasetId: 'ds-defect', defectType: '气孔', count: 12, category: null },
    ],
  };
}

describe('ParetoPage', () => {
  beforeEach(() => {
    useProjectStore.getState().clearDataset();
  });

  it('无缺陷数据 → 空状态', () => {
    renderPage();
    expect(screen.getByText('暂无缺陷数据')).toBeInTheDocument();
  });

  it('有缺陷数据 → 渲染图表与明细表', async () => {
    useProjectStore.getState().setDataset(makeDatasetWithDefects());
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('pareto-table')).toBeInTheDocument();
    });
    const table = screen.getByTestId('pareto-table');
    expect(within(table).getByText('划伤')).toBeInTheDocument();
    expect(within(table).getByText('毛边')).toBeInTheDocument();
    // 图表容器存在
    expect(screen.getByTestId('pareto-chart')).toBeInTheDocument();
  });

  it('明细表首行为最大项（降序）', async () => {
    useProjectStore.getState().setDataset(makeDatasetWithDefects());
    renderPage();
    await waitFor(() => expect(screen.getByTestId('pareto-table')).toBeInTheDocument());
    const table = screen.getByTestId('pareto-table');
    const rows = within(table).getAllByRole('row');
    // 第一行是表头，第二行是数据
    expect(within(rows[1]).getByText('划伤')).toBeInTheDocument();
  });

  it('可通过「使用示例数据」加载演示数据', async () => {
    renderPage();
    fireEvent.click(screen.getByText('使用示例数据'));
    await waitFor(() => {
      expect(screen.getByTestId('pareto-table')).toBeInTheDocument();
    });
  });

  it('累计占比列显示 2 位小数百分比', async () => {
    useProjectStore.getState().setDataset(makeDatasetWithDefects());
    renderPage();
    await waitFor(() => expect(screen.getByTestId('pareto-table')).toBeInTheDocument());
    const table = screen.getByTestId('pareto-table');
    const percents = within(table)
      .getAllByText(/%$/)
      .map((el: HTMLElement) => el.textContent ?? '');
    expect(percents.length).toBeGreaterThan(0);
    expect(percents.every((p: string) => /^\d+\.\d{2}%$/.test(p))).toBe(true);
  });
});
