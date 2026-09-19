/**
 * 导航项定义（供 Sidebar 与 AppShell 路由复用）。
 *
 * 出处：架构文档 §2.8。本轮实现「数据导入 / 能力分析 / 柏拉图」三页，
 * 其余为占位路由（点击显示「该模块开发中」，不报错）。
 */

import type { ReactElement } from 'react';
import {
  Dashboard as DashboardIcon,
  UploadFile as UploadFileIcon,
  Assessment as AssessmentIcon,
  ShowChart as ShowChartIcon,
  BarChart as BarChartIcon,
  Description as DescriptionIcon,
  SmartToy as SmartToyIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';

export interface NavItem {
  /** 路由路径。 */
  path: string;
  /** 中文标签。 */
  label: string;
  /** 图标元素。 */
  icon: ReactElement;
  /** 是否本轮已实现；false 时显示「开发中」占位。 */
  implemented: boolean;
}

/** 全部导航项（顺序即侧栏顺序）。 */
export const NAV_ITEMS: NavItem[] = [
  { path: '/import', label: '数据导入', icon: <UploadFileIcon />, implemented: true },
  { path: '/capability', label: '能力分析', icon: <AssessmentIcon />, implemented: true },
  { path: '/control-chart', label: '控制图', icon: <ShowChartIcon />, implemented: true },
  { path: '/pareto', label: '柏拉图', icon: <BarChartIcon />, implemented: true },
  { path: '/report', label: '报表导出', icon: <DescriptionIcon />, implemented: true },
  { path: '/ai', label: 'AI 助手', icon: <SmartToyIcon />, implemented: true },
  { path: '/settings', label: '设置', icon: <SettingsIcon />, implemented: true },
  { path: '/library', label: '项目库', icon: <DashboardIcon />, implemented: true },
];

/** 默认首页路径。 */
export const DEFAULT_ROUTE = '/import';
