/**
 * Sidebar —— 左侧导航（约 220px，可折叠）。
 *
 * 出处：架构文档 §2.8、§5。
 */

import {
  Box,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Tooltip,
  Typography,
} from '@mui/material';
import { NavLink } from 'react-router-dom';
import type { ReactElement } from 'react';
import { useUiStore } from '@/store/uiStore';
import { NAV_ITEMS } from './navItems';

const EXPANDED_WIDTH = 220;
const COLLAPSED_WIDTH = 64;

/**
 * 渲染侧栏导航。
 *
 * @returns 侧栏元素
 */
export default function Sidebar(): ReactElement {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <Box
      component="nav"
      data-testid="app-sidebar"
      sx={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flexShrink: 0,
        borderRight: 1,
        borderColor: 'divider',
        bgcolor: 'background.paper',
        transition: 'width 0.2s',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Box sx={{ px: collapsed ? 0 : 2, py: 1.5, display: 'flex', justifyContent: collapsed ? 'center' : 'flex-start' }}>
        <Typography variant="subtitle2" color="text.secondary" noWrap>
          {collapsed ? 'QA' : '质量分析'}
        </Typography>
      </Box>
      <List dense sx={{ pt: 0 }}>
        {NAV_ITEMS.map((item) => (
          <Tooltip key={item.path} title={collapsed ? item.label : ''} placement="right">
            <ListItemButton
              component={NavLink}
              to={item.path}
              sx={{
                justifyContent: collapsed ? 'center' : 'flex-start',
                px: collapsed ? 1 : 2,
                '&.active': {
                  bgcolor: 'primary.light',
                  color: 'primary.dark',
                  '& .MuiListItemIcon-root': { color: 'primary.dark' },
                },
              }}
            >
              <ListItemIcon sx={{ minWidth: collapsed ? 0 : 36, justifyContent: 'center' }}>
                {item.icon}
              </ListItemIcon>
              {collapsed ? null : <ListItemText primary={item.label} />}
            </ListItemButton>
          </Tooltip>
        ))}
      </List>
    </Box>
  );
}

export { EXPANDED_WIDTH, COLLAPSED_WIDTH };
