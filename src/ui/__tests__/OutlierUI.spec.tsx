// @vitest-environment jsdom
/**
 * 能力页异常值两步确认 UI 测试（PRD P0-14）。
 *
 * 覆盖：异常值表格渲染、勾选、确认排除（写入 projectStore）、撤销。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { clearCapabilityCache } from '@/store/selectors';
import { useProjectStore, generateId } from '@/store/projectStore';
import { useAnalysisStore } from '@/store/analysisStore';
import type { SpecLimits } from '@/core';
import type { Characteristic, Dataset, Measurement } from '@/data/schema';
import CapabilityPage from '@/ui/pages/CapabilityPage';

const SPEC: SpecLimits = { usl: 10.5, lsl: 9.5, target: 10.0, unit: 'mm' };

// 含一个明显离群点 50 的数据
const VALUES = [10.0, 10.1, 10.05, 9.98, 10.02, 10.08, 9.95, 10.03, 10.01, 9.99, 50.0];

function makeCharacteristic(): Characteristic {
  const cid = generateId('ch');
  const measurements: Measurement[] = VALUES.map((v) => ({
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
    name: '含离群点特性',
    specLimits: SPEC,
    measurements,
    subgroups: [],
    nullCount: 0,
    outlierFlags: [],
    preprocessConfigRef: null,
    measurementBlobRef: null,
  };
}

function makeDataset(c: Characteristic): Dataset {
  return {
    id: 'ds-test',
    projectId: 'local',
    name: '测试数据集',
    sourceType: 'csv',
    importedAt: new Date().toISOString(),
    rawFileName: 'test.csv',
    characteristics: [c],
    defectRecords: [],
  };
}

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <CapabilityPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('CapabilityPage —— 异常值两步确认', () => {
  beforeEach(() => {
    clearCapabilityCache();
    useAnalysisStore.getState().resetOutliers();
    useAnalysisStore.getState().setOutlierMethod('grubbs');
    useAnalysisStore.getState().setSpec(SPEC);
    useProjectStore.getState().clearDataset();
  });

  it('检测到候选后展示异常值表（默认未勾选）', async () => {
    useProjectStore.getState().setDataset(makeDataset(makeCharacteristic()));
    renderPage();

    await waitFor(() => {
      expect(screen.getByTestId('outlier-table')).toBeInTheDocument();
    });
    const table = screen.getByTestId('outlier-table');
    const checkboxes = within(table).getAllByRole('checkbox') as HTMLInputElement[];
    expect(checkboxes.length).toBeGreaterThan(0);
    expect(checkboxes.every((c: HTMLInputElement) => !c.checked)).toBe(true);
  });

  it('勾选 → 确认排除 → 写入 projectStore', async () => {
    useProjectStore.getState().setDataset(makeDataset(makeCharacteristic()));
    renderPage();

    await waitFor(() => expect(screen.getByTestId('outlier-table')).toBeInTheDocument());

    const table = screen.getByTestId('outlier-table');
    const checkbox = within(table).getAllByRole('checkbox')[0];
    fireEvent.click(checkbox);
    expect((checkbox as HTMLInputElement).checked).toBe(true);

    // 确认排除按钮此时可用
    const applyBtn = screen.getByTestId('apply-exclusions');
    expect(applyBtn).not.toBeDisabled();
    fireEvent.click(applyBtn);

    const stored = useProjectStore.getState().dataset?.characteristics[0];
    const excludedCount = stored?.measurements.filter((m) => m.excluded).length ?? 0;
    expect(excludedCount).toBeGreaterThan(0);
  });

  it('未勾选时确认按钮禁用', async () => {
    useProjectStore.getState().setDataset(makeDataset(makeCharacteristic()));
    renderPage();
    await waitFor(() => expect(screen.getByTestId('outlier-table')).toBeInTheDocument());
    expect(screen.getByTestId('apply-exclusions')).toBeDisabled();
  });
});
