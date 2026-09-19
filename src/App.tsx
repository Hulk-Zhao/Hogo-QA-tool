import { CssBaseline, ThemeProvider } from '@mui/material';
import type { ReactElement } from 'react';
import { theme } from './theme';
import AppShell from './ui/layout/AppShell';

/**
 * App —— 应用根组件。
 *
 * T03 落地左导航 + 顶栏主布局，承载「数据导入 / 能力分析 / 柏拉图」三页路由，
 * 其余模块留占位路由（点击显示「开发中」，不报错）。
 */
export default function App(): ReactElement {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AppShell />
    </ThemeProvider>
  );
}
