// @vitest-environment jsdom
/**
 * 数据导入页交互测试（PRD P0-15/P0-16）。
 *
 * 覆盖：粘贴 CSV → 解析 → 列映射 → 校验统计展示。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useProjectStore } from '@/store/projectStore';
import ImportPage from '@/ui/pages/ImportPage';

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <ImportPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('ImportPage —— 粘贴导入', () => {
  beforeEach(() => {
    useProjectStore.getState().clearDataset();
  });

  it('渲染拖拽区与页签', () => {
    renderPage();
    expect(screen.getByTestId('import-page')).toBeInTheDocument();
    expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    expect(screen.getByText('文件导入')).toBeInTheDocument();
    expect(screen.getByText('粘贴 CSV')).toBeInTheDocument();
  });

  it('粘贴 CSV → 解析 → 展示校验统计与预览', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));

    const input = screen.getByTestId('paste-input');
    fireEvent.change(input, {
      target: { value: '物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05\n转轴直径,5.01\n外壳长度,' },
    });
    fireEvent.click(screen.getByText('解析'));

    await waitFor(() => {
      expect(screen.getByText('校验结果')).toBeInTheDocument();
    });

    // 校验统计：2 特性、3 测量、1 空值
    expect(screen.getByText('特性数')).toBeInTheDocument();
    expect(screen.getByText('剔除空值数')).toBeInTheDocument();
    const preview = screen.getByTestId('import-preview-table');
    expect(within(preview).getAllByText('外壳长度').length).toBeGreaterThan(0);
  });

  it('识别旧格式并显示自动识别标记', async () => {
    renderPage();
    fireEvent.click(screen.getByText('粘贴 CSV'));
    fireEvent.change(screen.getByTestId('paste-input'), {
      target: { value: '物料名称,测量值\n外壳长度,10.02\n外壳长度,10.05' },
    });
    fireEvent.click(screen.getByText('解析'));

    await waitFor(() => {
      expect(screen.getByText('旧格式自动识别')).toBeInTheDocument();
    });
  });
});
