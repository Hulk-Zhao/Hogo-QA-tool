// @vitest-environment jsdom
/**
 * 应用骨架冒烟测试（架构文档 §2.8、§5）。
 *
 * 覆盖：侧栏导航项、模式徽标（默认离线）、已实现路由可正常挂载不报错。
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { theme } from '@/theme';
import AppShell from '@/ui/layout/AppShell';
import { useSettingsStore } from '@/store/settingsStore';

function renderShell(initialPath = '/import'): void {
  render(
    <ThemeProvider theme={theme}>
      <MemoryRouter initialEntries={[initialPath]}>
        <AppShell />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe('AppShell —— 布局与导航', () => {
  it('渲染侧栏与全部导航项', () => {
    renderShell();
    const sidebar = screen.getByTestId('app-sidebar');
    ['数据导入', '能力分析', '控制图', '柏拉图', '报表导出', 'AI 助手', '设置'].forEach((label) => {
      expect(within(sidebar).getByText(label)).toBeInTheDocument();
    });
  });

  it('顶栏显示产品名、项目名与离线模式徽标', () => {
    renderShell();
    expect(screen.getByText('Hogo-QA-tool')).toBeInTheDocument();
    expect(screen.getByText('离线模式')).toBeInTheDocument();
  });

  it('点击「控制图」挂载真实控制图页（不再是占位页）', () => {
    renderShell();
    const sidebar = screen.getByTestId('app-sidebar');
    fireEvent.click(within(sidebar).getByText('控制图'));
    // 真实页面已挂载：以页面根 testid 为锚点，断言不再渲染占位文案。
    expect(screen.getByTestId('control-chart-page')).toBeInTheDocument();
    expect(screen.queryByText('「控制图与判异准则」模块开发中')).not.toBeInTheDocument();
  });

  it('AI 模式时徽标切换为 AI 模式', () => {
    useSettingsStore.getState().setMode('ai', '探测成功');
    renderShell();
    expect(screen.getByText('AI 模式')).toBeInTheDocument();
    useSettingsStore.getState().setMode('offline', '清理');
  });

  it('全部 8 条路由均可直接挂载且不渲染占位页', () => {
    // T04/T05 收尾：路由接线由主理人统一接入，此处做路由级冒烟，
    // 断言每条路径都不抛错、不落到 UnderConstruction。
    const routes: { path: string; label: string }[] = [
      { path: '/import', label: '数据导入' },
      { path: '/capability', label: '能力分析' },
      { path: '/control-chart', label: '控制图' },
      { path: '/pareto', label: '柏拉图' },
      { path: '/report', label: '报表导出' },
      { path: '/ai', label: 'AI 助手' },
      { path: '/settings', label: '设置' },
      { path: '/library', label: '项目库' },
    ];

    routes.forEach(({ path }) => {
      const { unmount } = render(
        <ThemeProvider theme={theme}>
          <MemoryRouter initialEntries={[path]}>
            <AppShell />
          </MemoryRouter>
        </ThemeProvider>,
      );
      // 未落入占位页
      expect(screen.queryByText(/模块开发中/)).not.toBeInTheDocument();
      // 侧栏仍在（说明 shell 正常渲染，未因路由异常白屏）
      expect(screen.getByTestId('app-sidebar')).toBeInTheDocument();
      unmount();
    });
  });
});
