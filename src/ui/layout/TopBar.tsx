/**
 * TopBar —— 顶栏：产品名 + 项目名 + 模式徽标 + AI 解读入口 + 一键日报导出。
 *
 * 出处：架构文档 §2.8、§5。
 *
 * 一键日报：构造报表模型 → 导出 Excel（4 个数据 sheet，报表页会附带「图表」sheet）→ 切到报表页
 * 并触发浏览器原生打印（PDF）。遵守架构硬约束：Excel 永不含图片，打印才含图表。
 */

import { AppBar, Box, Button, IconButton, Toolbar, Tooltip, Typography } from '@mui/material';
import { Menu as MenuIcon, FileDownload as FileDownloadIcon } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { useUiStore } from '@/store/uiStore';
import { useProjectStore, buildProjectFromDataset } from '@/store/projectStore';
import {
  buildModel,
  exportExcelReportDetailed,
  printReport,
  DEFAULT_EXPORT_OPTIONS,
} from '@/services/report';
import ModeBadge from '@/ui/components/ModeBadge';
import AiGate from '@/ui/components/AiGate';
import ProjectSwitcher from './ProjectSwitcher';

/**
 * 渲染顶栏。
 *
 * @returns 顶栏元素
 */
export default function TopBar(): ReactElement {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const pushToast = useUiStore((s) => s.pushToast);
  const navigate = useNavigate();

  const dataset = useProjectStore((s) => s.dataset);
  const project = useProjectStore((s) => s.project);
  const projectName = useProjectStore((s) => s.projectName);

  /**
   * 一键日报：构造模型 → 导出 Excel → 切报表页并触发打印。
   *
   * 空数据场景给出明确提示，不导出空文件、不抛异常（对齐 ReportPage 空态语义）。
   */
  const handleExport = (): void => {
    if (!dataset || dataset.characteristics.length === 0) {
      pushToast('暂无可导出的数据，请先在「数据导入」页导入测量数据', 'warning');
      return;
    }
    try {
      const proj = project ?? buildProjectFromDataset('local', projectName, dataset);
      const model = buildModel(proj);
      const { fileName, imageCount } = exportExcelReportDetailed(model);
      pushToast(
        imageCount > 0
          ? `已生成一键日报 Excel：${fileName}（4 个数据 sheet + 图表 sheet，内嵌 ${imageCount} 张图）`
          : `已生成一键日报 Excel：${fileName}（4 个数据 sheet；图表将在报表页导出时内嵌）`,
        'success',
      );
      // 先切到报表导出页，待其渲染完成后再唤起打印 —— 否则打印的是当前所在页，
      // 会得到与日报无关的 PDF。用双 rAF 保证路由切换已提交后再调用 window.print()。
      navigate('/report');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          printReport(DEFAULT_EXPORT_OPTIONS);
        });
      });
    } catch (e) {
      pushToast(`一键日报导出失败：${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  /** 跳转 AI 助手页（离线时该页会展示「请先配置 AI 服务」引导）。 */
  const handleAiEntry = (): void => {
    navigate('/ai');
  };

  return (
    <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: 1, borderColor: 'divider' }}>
      <Toolbar variant="dense" sx={{ gap: 1.5 }}>
        <IconButton edge="start" size="small" onClick={toggleSidebar} aria-label="折叠/展开侧栏">
          <MenuIcon />
        </IconButton>
        <Typography variant="subtitle1" fontWeight={700} color="primary.main" noWrap>
          Hogo-QA-tool
        </Typography>
        <Typography variant="body2" color="text.disabled">
          |
        </Typography>
        <Typography variant="body2" color="text.secondary" component="div">
          <ProjectSwitcher />
        </Typography>
        <Box sx={{ flexGrow: 1 }} />
        <ModeBadge />
        {/* 导航入口：离线时保留 tooltip 提示但不禁用（点击进入 AI 页看离线引导）。 */}
        <AiGate disabledHint="配置 AI 服务后可用" allowWhenOffline>
          <Button size="small" variant="text" onClick={handleAiEntry} data-testid="topbar-ai-entry">
            AI 解读
          </Button>
        </AiGate>
        <Tooltip title="一键导出日报（Excel + 打印 PDF）">
          <Button
            size="small"
            variant="contained"
            startIcon={<FileDownloadIcon />}
            onClick={handleExport}
            data-testid="topbar-export-report"
          >
            一键日报
          </Button>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
