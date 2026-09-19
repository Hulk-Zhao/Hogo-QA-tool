/**
 * AppShell —— 主布局：左导航 + 顶栏 + 内容区，并承载路由。
 *
 * 出处：架构文档 §2.8、§5。
 *
 * 路由：本轮实现「数据导入 / 能力分析 / 控制图 / 柏拉图 / 报表导出 / AI 助手 / 设置 / 项目库」全量页面。
 * 无占位路由。
 */

import { Box } from '@mui/material';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { DEFAULT_ROUTE } from './navItems';
import ImportPage from '@/ui/pages/ImportPage';
import CapabilityPage from '@/ui/pages/CapabilityPage';
import ControlChartPage from '@/ui/pages/ControlChartPage';
import ParetoPage from '@/ui/pages/ParetoPage';
import ReportPage from '@/ui/pages/ReportPage';
import AiAssistantPage from '@/ui/pages/AiAssistantPage';
import SettingsPage from '@/ui/pages/SettingsPage';
import ProjectLibraryPage from '@/ui/pages/ProjectLibraryPage';
import ErrorBoundary from '@/ui/components/ErrorBoundary';

/**
 * 渲染应用主壳。
 *
 * @returns 布局元素
 */
export default function AppShell(): ReactElement {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh', bgcolor: 'background.default' }}>
      <TopBar />
      <Box sx={{ display: 'flex', flexGrow: 1, minHeight: 0 }}>
        <Sidebar />
        <Box component="main" sx={{ flexGrow: 1, minWidth: 0, overflow: 'auto', p: 2.5 }}>
          <ErrorBoundary>
            <Routes>
              <Route path="/" element={<Navigate to={DEFAULT_ROUTE} replace />} />
              <Route path="/import" element={<ImportPage />} />
              <Route path="/capability" element={<CapabilityPage />} />
              <Route path="/pareto" element={<ParetoPage />} />
              <Route path="/control-chart" element={<ControlChartPage />} />
              <Route path="/report" element={<ReportPage />} />
              <Route path="/ai" element={<AiAssistantPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/library" element={<ProjectLibraryPage />} />
              <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
            </Routes>
          </ErrorBoundary>
        </Box>
      </Box>
    </Box>
  );
}
