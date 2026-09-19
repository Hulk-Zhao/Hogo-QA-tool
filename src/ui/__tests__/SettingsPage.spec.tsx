// @vitest-environment jsdom
/**
 * SettingsPage 测试（P0-22；T05 验收要点 1/5）。
 *
 * 覆盖：AI 配置表单、离线/在线模式 chip、常数表（n=2..25，D3/B3 显示「—」）、
 * 判异准则开关、隐私说明、项目库入口。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import { useSettingsStore } from '@/store/settingsStore';
import SettingsPage from '@/ui/pages/SettingsPage';

function renderPage(): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('SettingsPage', () => {
  beforeEach(() => {
    useSettingsStore.getState().resetMode();
  });

  it('渲染页面与 AI 配置表单', () => {
    renderPage();
    expect(screen.getByTestId('settings-page')).toBeInTheDocument();
    expect(screen.getByLabelText('Base URL')).toBeInTheDocument();
    expect(screen.getByLabelText('API Key')).toBeInTheDocument();
    expect(screen.getByLabelText('模型名')).toBeInTheDocument();
  });

  it('未配置 Key → 离线模式 chip', () => {
    renderPage();
    expect(screen.getByTestId('settings-mode-chip').textContent).toContain('离线模式');
  });

  it('constants 表渲染 n=2..25 共 24 行，且 D3/B3 小 n 显示「—」而非 0', () => {
    renderPage();
    const table = screen.getByTestId('constants-table');
    // D3: n=2..6 无定义 → 显示 —
    expect(within(table).getByTestId('D3-2').textContent).toBe('—');
    expect(within(table).getByTestId('D3-6').textContent).toBe('—');
    expect(within(table).getByTestId('B3-5').textContent).toBe('—');
    // D3: n=7 有定义 → 0.076
    expect(within(table).getByTestId('D3-7').textContent).toBe('0.076');
    // B3: n=6 有定义 → 0.030
    expect(within(table).getByTestId('B3-6').textContent).toBe('0.03');
    // 行数：24 个 n + 表头
    const rows = within(table).getAllByRole('row');
    expect(rows.length).toBe(25);
  });

  it('input 配置变更写入 store', () => {
    renderPage();
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://a.com/v1' } });
    expect(useSettingsStore.getState().aiConfig.baseUrl).toBe('https://a.com/v1');
  });

  it('存在判异准则开关（含 W1 与 N5）', () => {
    renderPage();
    expect(screen.getByLabelText(/W1 1点超3σ/)).toBeInTheDocument();
    expect(screen.getByLabelText(/N5/)).toBeInTheDocument();
  });

  it('展示数据与隐私说明', () => {
    renderPage();
    expect(screen.getByText(/数据与隐私说明/)).toBeInTheDocument();
    expect(screen.getByText(/无任何外部网络请求/)).toBeInTheDocument();
  });
});
