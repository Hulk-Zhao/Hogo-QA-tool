/**
 * ProjectSwitcher —— 项目切换器（T03 占位 → T05 增强）。
 *
 * 出处：架构文档 §2.8；PRD §7.1。T05 增强：在重命名基础上，
 * 增加「打开项目库」入口（跳转 /library，完整搜索/复制/删除由项目库页落地）。
 *
 * 兼容性：保留原「显示项目名 + 重命名」交互（既有测试通过）。
 */

import { useState } from 'react';
import { IconButton, TextField, Tooltip, Box } from '@mui/material';
import {
  Edit as EditIcon,
  Check as CheckIcon,
  Dashboard as DashboardIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useProjectStore } from '@/store/projectStore';

/**
 * 渲染项目切换器。
 *
 * @returns 项目名编辑元素
 */
export default function ProjectSwitcher(): ReactElement {
  const navigate = useNavigate();
  const projectName = useProjectStore((s) => s.projectName);
  const setProjectName = useProjectStore((s) => s.setProjectName);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(projectName);

  const startEdit = (): void => {
    setDraft(projectName);
    setEditing(true);
  };

  const commit = (): void => {
    const next = draft.trim();
    if (next.length > 0) {
      setProjectName(next);
    }
    setEditing(false);
  };

  if (editing) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <TextField
          size="small"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit();
            }
          }}
          inputProps={{ 'aria-label': '项目名称' }}
          sx={{ width: 180 }}
        />
        <IconButton size="small" onClick={commit} aria-label="确认项目名">
          <CheckIcon fontSize="small" />
        </IconButton>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
      <Box sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {projectName}
      </Box>
      <Tooltip title="重命名项目">
        <IconButton size="small" onClick={startEdit} aria-label="重命名项目">
          <EditIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="项目库">
        <IconButton size="small" onClick={() => navigate('/library')} aria-label="打开项目库">
          <DashboardIcon fontSize="small" />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
